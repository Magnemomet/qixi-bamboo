/* ============================================================
 * input.js — 输入模块（fairy 实现）
 *
 * 职责：收集所有"转动/操控"输入源并注入物理：
 *   - 鼠标：按住左键 = 持续注入（点击转动）；松开/移出窗口 = 停止，靠惯性滑翔
 *   - 触摸：单指按住 = 持续注入；抬起/取消 = 停止（不再需要划动）
 *   - 摇一摇：devicemotion 加速度变化率超阈值 = 注入（Android，iOS 尽力而为）
 *   - 摄像头手势：MediaPipe Hands 双掌心相对搓动 / 单掌心上下挥动（尽力而为）
 *     附画中画预览窗（右上角 HUD 下方，可点击最小化，信笺/收藏馆打开时自动隐藏）
 * 原则：能力检测 + try/catch 全包裹，任何失败静默降级，绝不抛错。
 *
 * 接口：
 *   init()    能力检测、挂事件、启动摄像头手势（异步）、emit 能力报告
 *   dispose() 移除全部监听、停止摄像头流、关闭 MediaPipe、清理注入定时器
 *
 * 事件（emit）：
 *   input-status    {mouse, touch, shake, gesture}  能力检测结果（gesture 异步更新）
 *   gesture-status  {state, hands}  摄像头手势状态机：loading/ready/tracking/error/off；
 *                   hands = 当前朝向摄像头的有效掌数（0|1|2），仅在状态/掌数变化时发出
 *
 * 注入走 physics.spin()（正增量接口）。按住注入由本模块的 50ms 定时器节流，
 * 每 tick 注入一次，转速越高注入越小（两段式），保证平衡点不爆表。
 *
 * 已移除（2026-08-18，固定侧面视角）：
 *   - camera-rotate / camera-zoom 的全部 emit（慢速拖拽、右键拖拽、双指手势）
 *   - 鼠标横移搓动（SPIN_VELOCITY / SPIN_RPS_K / SPIN_THROTTLE）
 *   - 触摸滑动搓动与双指捏合逻辑
 *
 * 已知限制（尽力而为模块）：
 * - file:// 下摄像头取决于浏览器是否把 file:// 视为安全上下文（Chrome/Edge 允许，
 *   Firefox 允许），权限被拒/无网络（CDN 加载失败）时静默降级为无手势。
 * - MediaPipe Hands 全部走 CDN（jsdelivr），离线环境手势自动失效。
 * ============================================================ */
(function () {
  'use strict';

  var B = window.BambooGame;
  var S = B.S;

  /* ---------- 调参常量 ----------
   * 标定说明（2026-08-18，点击转动模型，由 030-车间/input-handfeel-sim.js 模拟验证）：
   * 按住注入两段式：低转速段用力起转（HOLD_RPS_FAST），高转速段转巡航
   * （HOLD_RPS_CRUISE），切换阈值 HOLD_RPM_SWITCH。
   * rpm 增量 = rps × SPIN_EFF×60 = rps×54。
   *  - FAST 0.93rps/50ms ≈ +50rpm/次 → 注入率 1000rpm/s，0→2200rpm 约 2.5s；
   *  - CRUISE 0.40rps/50ms ≈ +21.5rpm/次 → 注入率 430rpm/s，阻尼平衡点 ≈3100rpm
   *    （K1=0.08、K2=0.00018 下 3100rpm 阻尼 ≈429rpm/s，恰好抵消），
   *    按住 5s ≈2600rpm、持续按住稳定 3100±，均落在 2500~3500 校验窗内。
   * 注：若巡航也按 0.8~1.2rps（注入率 860~1300rpm/s），平衡点会到 5400~6400rpm，
   * 远超 3500 上限；0.8~1.2 段只用于起转。 */
  var CONST = {
    /* 按住注入（点击转动） */
    HOLD_INJECT_MS: 50,      // ms，注入定时器周期（20 次/s）
    HOLD_RPS_FAST: 0.93,     // 起转段单次注入 rps（+50rpm/次，注入率 1000rpm/s）
    HOLD_RPS_CRUISE: 0.40,   // 巡航段单次注入 rps（+21.5rpm/次，注入率 430rpm/s，平衡点≈3100）
    HOLD_RPM_SWITCH: 2200,   // rpm 达到此值切换为巡航注入（rpm 基准，防高转速下误加速）

    /* 摇一摇 */
    SHAKE_THRESHOLD: 12,   // 加速度变化率阈值（m/s² 帧间差向量模）
    SHAKE_RPS_K: 0.5,      // rps = min(Δacc * 0.5, SHAKE_RPS_MAX)：一次猛摇 +270~540rpm
    SHAKE_RPS_MAX: 10,
    SHAKE_THROTTLE: 80,    // ms

    /* 摄像头手势（MediaPipe Hands） */
    HANDS_CDN: 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/',
    GESTURE_DIST_RATE: 0.35,        // 双掌心距离变化率阈值（归一坐标/s，取 200ms 平滑窗均值）
    GESTURE_RPS_K: 12,              // rps 正比系数（原 90 → 1/7.5）：rps = min(|rate| * K, MAX)
    GESTURE_RPS_MAX: 5,             // 单次手势注入上限（5rps ≈ +270rpm，落在单次 +100~300rpm 目标）
    GESTURE_Y_RATE: 1.2,            // 单手 y 方向速度阈值（归一坐标/s，快速往复）
    GESTURE_SINGLE_K: 6,            // 单手 rps 系数（原 45 → 1/7.5，与双手同比例）
    GESTURE_THROTTLE: 120,          // ms，手势注入节流
    GESTURE_SMOOTH_MS: 200,         // ms，距离/速度平滑窗口（取窗口首尾样本斜率，防单帧抖动误触发）
    GESTURE_PALM_Z_MAX: 0.03,       // 掌心朝向过滤：指尖平均 z（腕部为原点）< 此值才算朝向摄像头
    GESTURE_MODEL_COMPLEXITY: 1,    // 模型复杂度 0/1（1 更准；实测持续低帧率会自动降 0）
    GESTURE_FPS_MIN: 10,            // 实测 fps 低于此值且连续 2 个统计窗 → 降 modelComplexity 为 0
    GESTURE_FPS_WINDOW_MS: 2000,    // ms，fps 统计窗口
    GESTURE_MAX_FPS: 25,            // 发送速率上限（帧/s；目标 ≥15fps，25 封顶省电）
    VIDEO_W: 320, VIDEO_H: 240,     // 摄像头渲染分辨率（预览用 CSS 缩小显示，绝不放大）

    /* 预览窗（画中画，右上角 HUD 下方；不遮挡左下照片卡/右下 toast/顶部手势提示） */
    PREVIEW_W: 140, PREVIEW_H: 105,          // 桌面预览尺寸 px（4:3）
    PREVIEW_W_MOBILE: 120, PREVIEW_H_MOBILE: 90, // 移动端（≤640px 宽）默认更小
    PREVIEW_RIGHT: 16, PREVIEW_TOP: 128,     // 桌面位置：HUD 右上列（约 18~117px）下方
    PREVIEW_RIGHT_MOBILE: 12, PREVIEW_TOP_MOBILE: 114,
    PREVIEW_OPACITY: 0.85,                   // 半透明
    PREVIEW_Z: 28,                           // 层级：HUD(20) < 预览(28) < 信笺(60)/收藏馆(55)
    PREVIEW_MIRROR: true,                    // 预览镜像（自拍自然感；CSS 变换不影响 MediaPipe 输入帧）
    PREVIEW_MIN_SCALE: 0.42,                 // 点击最小化后边长 = 原短边 × 此系数
    PREVIEW_HIDE_SEL: '#letter-overlay.show, .gallery-overlay.show, #start-screen:not(.hidden)', // 命中即隐藏预览
    PREVIEW_ERROR_MS: 4000                   // ms，错误红点提示停留时长后自动消失
  };

  /* ---------- 内部状态 ---------- */
  var physics = null;           // 惰性获取 BambooGame.getModule('physics')

  function doSpin(rps, source) {
    if (!physics) physics = B.getModule('physics');
    if (physics && physics.spin) physics.spin(rps, source);
  }

  /* ================= 按住注入（点击转动） =================
   * 鼠标左键 / 单指按住 → 50ms 定时器持续注入，松开/抬起/移出窗口 → 停止。
   * 两段式注入：S.rpm < HOLD_RPM_SWITCH 用 FAST 起转，否则 CRUISE 巡航。
   * 多输入源同时按住只保留一条注入流（防止叠加爆表），source 取当前按住源。 */
  var hold = { mouse: false, touch: false, timer: null };

  function holdTick() {
    var rps = S.rpm >= CONST.HOLD_RPM_SWITCH ? CONST.HOLD_RPS_CRUISE : CONST.HOLD_RPS_FAST;
    doSpin(rps, hold.mouse ? 'mouse' : 'touch');
  }
  function startHold() {
    holdTick(); // 按下立即注入一次，手感跟手
    if (!hold.timer) hold.timer = setInterval(holdTick, CONST.HOLD_INJECT_MS);
  }
  function stopHoldIfIdle() {
    if (hold.mouse || hold.touch) return;
    if (hold.timer) { clearInterval(hold.timer); hold.timer = null; }
  }

  /* ================= 鼠标 ================= */
  function onMouseDown(e) {
    if (e.button !== 0) return; // 只认左键
    hold.mouse = true;
    startHold();
  }
  function onMouseUp() { hold.mouse = false; stopHoldIfIdle(); }
  function onMouseLeave() { hold.mouse = false; stopHoldIfIdle(); } // 按住拖出窗口：停止注入
  function onWindowBlur() { hold.mouse = false; hold.touch = false; stopHoldIfIdle(); }
  function onContextMenu(e) { try { e.preventDefault(); } catch (err) { /* 静默 */ } }

  function initMouse() {
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('mouseleave', onMouseLeave);
    window.addEventListener('blur', onWindowBlur);
    document.addEventListener('contextmenu', onContextMenu); // 游戏页不弹右键菜单
  }

  /* ================= 触摸 ================= */
  function onTouchStart(e) {
    try { e.preventDefault(); } catch (err) { /* 静默 */ }
    if (e.touches.length > 0 && !hold.touch) {
      hold.touch = true;
      startHold();
    }
  }
  function onTouchMove(e) {
    // 无注入逻辑：按住期间手指轻微移动不误判为任何操作。
    // 仅 preventDefault 阻止页面滚动/双指缩放手势。
    try { e.preventDefault(); } catch (err) { /* 静默 */ }
  }
  function onTouchEnd(e) {
    hold.touch = e.touches.length > 0; // 还有手指按住则继续注入
    stopHoldIfIdle();
  }

  function initTouch() {
    window.addEventListener('touchstart', onTouchStart, { passive: false });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);
    window.addEventListener('touchcancel', onTouchEnd);
  }

  /* ================= 摇一摇 ================= */
  var shake = { lastAcc: null, lastSpinT: 0 };

  function onDeviceMotion(e) {
    var a = e.accelerationIncludingGravity;
    if (!a) return;
    var now = performance.now();
    if (shake.lastAcc) {
      var ddx = a.x - shake.lastAcc.x;
      var ddy = a.y - shake.lastAcc.y;
      var ddz = a.z - shake.lastAcc.z;
      var d = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
      if (d > CONST.SHAKE_THRESHOLD && now - shake.lastSpinT > CONST.SHAKE_THROTTLE) {
        shake.lastSpinT = now;
        doSpin(Math.min(d * CONST.SHAKE_RPS_K, CONST.SHAKE_RPS_MAX), 'shake');
      }
    }
    shake.lastAcc = { x: a.x, y: a.y, z: a.z };
  }

  function initShake() {
    try {
      if (typeof DeviceMotionEvent !== 'undefined' &&
          typeof DeviceMotionEvent.requestPermission === 'function') {
        // iOS 13+：需要用户授权（尽力而为，失败静默）
        DeviceMotionEvent.requestPermission().then(function (res) {
          if (res === 'granted') window.addEventListener('devicemotion', onDeviceMotion);
        }).catch(function () { /* 静默 */ });
      } else if ('DeviceMotionEvent' in window) {
        window.addEventListener('devicemotion', onDeviceMotion);
      }
    } catch (e) { /* 静默降级 */ }
  }

  /* ================= 摄像头手势（尽力而为） ================= */
  var gesture = {
    on: false,
    video: null,
    hands: null,
    stream: null,
    script: null,
    modelComplexity: 0,     // 当前模型复杂度（低帧率自动降 0）
    lastSendT: 0,           // 上次 send 时刻（限速）
    fpsT0: 0, fpsCount: 0, fpsLow: 0,  // fps 统计：窗口起点/计数/连续低帧窗数
    lastSpinT: 0,           // 上次手势注入时刻（节流）
    distBuf: [],            // 双手掌心距离平滑窗 [{v,t},...]
    yBuf: [],               // 单手掌心 y 平滑窗 [{v,t},...]
    lastState: null, lastHands: null  // 上次发出的事件（去重）
  };

  /* ---------- 预览窗（画中画） ---------- */
  var preview = {
    wrap: null, dot: null, video: null, ph: null, mini: null,
    minimized: false, errorPill: null, errorTimer: 0
  };

  function previewIsMobile() {
    return (typeof window.innerWidth === 'number') && window.innerWidth <= 640;
  }
  function previewMetrics() {
    var m = previewIsMobile();
    return {
      w: m ? CONST.PREVIEW_W_MOBILE : CONST.PREVIEW_W,
      h: m ? CONST.PREVIEW_H_MOBILE : CONST.PREVIEW_H,
      right: m ? CONST.PREVIEW_RIGHT_MOBILE : CONST.PREVIEW_RIGHT,
      top: m ? CONST.PREVIEW_TOP_MOBILE : CONST.PREVIEW_TOP
    };
  }
  function previewApplySize() {
    if (!preview.wrap) return;
    var m = previewMetrics();
    preview.wrap.style.width = m.w + 'px';
    preview.wrap.style.height = m.h + 'px';
    preview.wrap.style.right = m.right + 'px';
    preview.wrap.style.top = m.top + 'px';
  }
  function previewCreate() {
    if (preview.wrap) return;
    try {
      var m = previewMetrics();
      var wrap = document.createElement('div');
      wrap.id = 'gesture-preview';
      wrap.style.cssText =
        'position:fixed;z-index:' + CONST.PREVIEW_Z + ';' +
        'width:' + m.w + 'px;height:' + m.h + 'px;' +
        'right:' + m.right + 'px;top:' + m.top + 'px;' +
        'border-radius:12px;overflow:hidden;cursor:pointer;' +
        'background:rgba(10,20,34,.55);border:1px solid rgba(255,230,180,.28);' +
        'box-shadow:0 6px 22px rgba(0,0,0,.4);opacity:' + CONST.PREVIEW_OPACITY + ';' +
        'touch-action:manipulation;-webkit-tap-highlight-color:transparent;';
      /* 状态角标：灰=未就绪，绿=识别到手，红=错误 */
      var dot = document.createElement('div');
      dot.style.cssText =
        'position:absolute;top:6px;right:6px;width:10px;height:10px;border-radius:50%;' +
        'background:#8a97a8;border:2px solid rgba(0,0,0,.45);z-index:2;pointer-events:none;';
      wrap.appendChild(dot);
      /* 占位（视频未就绪） */
      var ph = document.createElement('div');
      ph.textContent = '📷 启动中';
      ph.style.cssText =
        'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
        'font-size:11px;letter-spacing:.1em;color:#9fc4e8;background:#0d1a2c;z-index:1;';
      wrap.appendChild(ph);
      /* 最小化占位 */
      var mini = document.createElement('div');
      mini.textContent = '📷';
      mini.style.cssText =
        'position:absolute;inset:0;display:none;align-items:center;justify-content:center;' +
        'font-size:16px;z-index:1;background:#0d1a2c;';
      wrap.appendChild(mini);
      /* video：渲染 320×240，CSS 缩小显示（不放大 canvas） */
      var video = document.createElement('video');
      video.setAttribute('playsinline', '');
      video.muted = true;
      video.width = CONST.VIDEO_W;
      video.height = CONST.VIDEO_H;
      video.style.cssText =
        'width:100%;height:100%;object-fit:cover;display:block;background:#0d1a2c;' +
        (CONST.PREVIEW_MIRROR ? 'transform:scaleX(-1);' : '');
      wrap.appendChild(video);
      wrap.addEventListener('click', previewToggle);
      document.body.appendChild(wrap);
      preview.wrap = wrap; preview.dot = dot; preview.ph = ph;
      preview.mini = mini; preview.video = video;
      previewUpdateOverlay(); // 立即应用一次（可能在开始界面淡出期）
    } catch (e) { /* 预览失败不影响手势本身 */ }
  }
  function previewSetState(state) {
    if (!preview.dot) return;
    var c = state === 'tracking' ? '#4ade80' : (state === 'error' ? '#f87171' : '#8a97a8');
    preview.dot.style.background = c;
  }
  function previewVideoReady() {
    if (preview.ph) {
      try { preview.ph.parentNode.removeChild(preview.ph); } catch (e) { /* 静默 */ }
      preview.ph = null;
    }
  }
  function previewToggle() {
    if (!preview.wrap) return;
    preview.minimized = !preview.minimized;
    var m = previewMetrics();
    if (preview.minimized) {
      var s = Math.round(Math.min(m.w, m.h) * CONST.PREVIEW_MIN_SCALE);
      preview.wrap.style.width = s + 'px';
      preview.wrap.style.height = s + 'px';
      preview.wrap.style.borderRadius = '10px';
      preview.video.style.display = 'none';
      preview.mini.style.display = 'flex';
    } else {
      previewApplySize();
      preview.wrap.style.borderRadius = '12px';
      preview.video.style.display = 'block';
      preview.mini.style.display = 'none';
    }
  }
  function previewUpdateOverlay() {
    if (!preview.wrap) return;
    var occluded = false;
    try { occluded = !!document.querySelector(CONST.PREVIEW_HIDE_SEL); } catch (e) { /* 静默 */ }
    preview.wrap.classList.toggle('hidden', occluded);
  }
  function previewHideError() {
    if (preview.errorTimer) { clearTimeout(preview.errorTimer); preview.errorTimer = 0; }
    if (preview.errorPill) {
      try { preview.errorPill.parentNode.removeChild(preview.errorPill); } catch (e) { /* 静默 */ }
      preview.errorPill = null;
    }
  }
  function previewShowError() {
    try {
      previewHideError();
      var m = previewMetrics();
      var pill = document.createElement('div');
      pill.id = 'gesture-preview-error';
      pill.style.cssText =
        'position:fixed;z-index:' + (CONST.PREVIEW_Z + 1) + ';' +
        'right:' + m.right + 'px;top:' + m.top + 'px;' +
        'display:flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;' +
        'background:rgba(60,20,24,.78);border:1px solid rgba(248,113,113,.5);' +
        'font-size:11px;color:#fecaca;pointer-events:none;opacity:0;transition:opacity .3s ease;';
      var d = document.createElement('span');
      d.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#f87171;';
      pill.appendChild(d);
      pill.appendChild(document.createTextNode('摄像头不可用'));
      document.body.appendChild(pill);
      preview.errorPill = pill;
      requestAnimationFrame(function () {
        if (preview.errorPill) preview.errorPill.style.opacity = '1';
      });
      preview.errorTimer = setTimeout(previewHideError, CONST.PREVIEW_ERROR_MS);
    } catch (e) { /* 静默 */ }
  }
  function previewDestroy() {
    previewHideError();
    if (preview.wrap) {
      try { preview.wrap.parentNode.removeChild(preview.wrap); } catch (e) { /* 静默 */ }
      preview.wrap = preview.dot = preview.video = preview.ph = preview.mini = null;
    }
    preview.minimized = false;
  }

  /* 状态事件（仅变化时发出；同步刷新预览角标颜色） */
  function emitGesture(state, hands) {
    hands = hands || 0;
    if (gesture.lastState === state && gesture.lastHands === hands) return;
    gesture.lastState = state;
    gesture.lastHands = hands;
    previewSetState(state);
    try { B.bus.emit('gesture-status', { state: state, hands: hands }); } catch (e) { /* 静默 */ }
  }

  function gestureCleanup() {
    gesture.on = false;
    try { if (gesture.hands && gesture.hands.close) gesture.hands.close(); } catch (e) { /* 静默 */ }
    gesture.hands = null;
    try {
      if (gesture.stream) {
        gesture.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e2) { /* 静默 */ } });
      }
    } catch (e) { /* 静默 */ }
    gesture.stream = null;
    previewDestroy();
    gesture.video = null;
    gesture.distBuf.length = 0;
    gesture.yBuf.length = 0;
    gesture.lastState = gesture.lastHands = null;
  }

  /* 摄像头初始化失败/权限被拒/wasm 加载失败：静默降级 */
  function gestureFail() {
    gestureCleanup();
    emitGesture('error', 0);
    try { B.bus.emit('input-status', { gesture: false }); } catch (e) { /* 静默 */ }
    previewShowError(); // 短暂红点提示，不打扰
  }

  /* 掌心朝向过滤：指尖平均深度 < 阈值 → 掌心朝摄像头（搓动时指尖自然指向镜头） */
  function palmFacing(lm) {
    var z = (lm[8].z + lm[12].z + lm[16].z + lm[20].z) / 4;
    return z < CONST.GESTURE_PALM_Z_MAX;
  }

  /* 平滑窗：保留最近 GESTURE_SMOOTH_MS 内样本，斜率 = 窗口首尾差 / 时间跨 */
  function pushSample(buf, v, t, max) {
    buf.push({ v: v, t: t });
    while (buf.length > 1 && t - buf[0].t > CONST.GESTURE_SMOOTH_MS) buf.shift();
    while (buf.length > max) buf.shift();
  }
  function smoothRate(buf) {
    if (buf.length < 2) return null;
    var a = buf[0], b = buf[buf.length - 1];
    var dt = Math.max((b.t - a.t) / 1000, 0.001);
    return (b.v - a.v) / dt;
  }

  function onHandResults(results) {
    if (!results || !results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
      gesture.distBuf.length = 0;
      gesture.yBuf.length = 0;
      emitGesture('ready', 0);
      return;
    }
    var now = performance.now();
    var P = 9; // 掌根中心（掌心），比手腕(0)更稳
    var palms = [];
    for (var i = 0; i < results.multiHandLandmarks.length && palms.length < 2; i++) {
      if (palmFacing(results.multiHandLandmarks[i])) palms.push(results.multiHandLandmarks[i]);
    }
    if (palms.length === 0) {
      gesture.distBuf.length = 0;
      gesture.yBuf.length = 0;
      emitGesture('ready', 0);
      return;
    }
    emitGesture('tracking', palms.length);

    if (palms.length >= 2) {
      /* 双手：掌心距离变化率（200ms 平滑均值）超阈值 → 搓动（rps 正比变化率） */
      var h0 = palms[0][P], h1 = palms[1][P];
      var d = Math.sqrt(Math.pow(h0.x - h1.x, 2) + Math.pow(h0.y - h1.y, 2));
      pushSample(gesture.distBuf, d, now, 8);
      var rate = smoothRate(gesture.distBuf);
      if (rate !== null && Math.abs(rate) > CONST.GESTURE_DIST_RATE &&
          now - gesture.lastSpinT > CONST.GESTURE_THROTTLE) {
        gesture.lastSpinT = now;
        doSpin(Math.min(Math.abs(rate) * CONST.GESTURE_RPS_K, CONST.GESTURE_RPS_MAX), 'gesture');
      }
      gesture.yBuf.length = 0;
    } else {
      /* 单手：掌心 y 方向快速往复（200ms 平滑均值，节流防灌爆） */
      pushSample(gesture.yBuf, palms[0][P].y, now, 8);
      var vy = smoothRate(gesture.yBuf);
      if (vy !== null && Math.abs(vy) > CONST.GESTURE_Y_RATE &&
          now - gesture.lastSpinT > CONST.GESTURE_THROTTLE) {
        gesture.lastSpinT = now;
        doSpin(Math.min(Math.abs(vy) * CONST.GESTURE_SINGLE_K, CONST.GESTURE_RPS_MAX), 'gesture');
      }
      gesture.distBuf.length = 0;
    }
  }

  function handLoop() {
    if (!gesture.on || !gesture.hands || !gesture.video) return;
    previewUpdateOverlay(); // 顺带维护：信笺/收藏馆/开始界面打开时隐藏预览
    var now = performance.now();
    /* 发送限速：不高于 GESTURE_MAX_FPS（目标 ≥15fps，25 封顶省电） */
    if (now - gesture.lastSendT < 1000 / CONST.GESTURE_MAX_FPS) {
      requestAnimationFrame(handLoop);
      return;
    }
    gesture.lastSendT = now;
    gesture.hands.send({ image: gesture.video }).then(function () {
      gesture.fpsCount++;
      var t2 = performance.now();
      if (t2 - gesture.fpsT0 >= CONST.GESTURE_FPS_WINDOW_MS) {
        var fps = gesture.fpsCount * 1000 / Math.max(t2 - gesture.fpsT0, 1);
        gesture.fpsCount = 0;
        gesture.fpsT0 = t2;
        if (fps < CONST.GESTURE_FPS_MIN) {
          gesture.fpsLow++;
          /* 持续低帧率 → modelComplexity 降 0（仅一次） */
          if (gesture.fpsLow >= 2 && gesture.modelComplexity > 0) {
            gesture.modelComplexity = 0;
            try { gesture.hands.setOptions({ modelComplexity: 0 }); } catch (e) { /* 静默 */ }
          }
        } else {
          gesture.fpsLow = 0;
        }
      }
      if (gesture.on) requestAnimationFrame(handLoop);
    }).catch(function () { gestureFail(); });
  }

  function initHands() {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        gestureFail(); return;
      }
      navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: CONST.VIDEO_W }, height: { ideal: CONST.VIDEO_H } }
      }).then(function (stream) {
        try {
          gesture.stream = stream;
          previewCreate(); // 画中画预览：右上角 HUD 下方
          var video = preview.video;
          if (!video) { gestureFail(); return; }
          gesture.video = video;
          video.addEventListener('playing', previewVideoReady, { once: true });
          video.srcObject = stream;
          video.play().catch(function () { /* 静默：play 失败走降级 */ });

          var Hands = window.Hands;
          if (!Hands) { gestureFail(); return; }
          var hands = new Hands({
            locateFile: function (f) { return CONST.HANDS_CDN + f; }
          });
          hands.setOptions({
            maxNumHands: 2,
            modelComplexity: CONST.GESTURE_MODEL_COMPLEXITY
          });
          hands.onResults = onHandResults;
          gesture.hands = hands;
          gesture.on = true;
          gesture.modelComplexity = CONST.GESTURE_MODEL_COMPLEXITY;
          gesture.fpsT0 = performance.now();
          gesture.fpsCount = 0;
          gesture.fpsLow = 0;
          try { B.bus.emit('input-status', { gesture: true }); } catch (e) { /* 静默 */ }
          emitGesture('ready', 0);
          handLoop();
        } catch (e) { gestureFail(); }
      }).catch(function () { gestureFail(); }); // 权限被拒 / 非安全上下文
    } catch (e) { gestureFail(); }
  }

  function initGesture() {
    try {
      emitGesture('loading', 0);
      var s = document.createElement('script');
      s.src = CONST.HANDS_CDN + 'hands.js';
      s.onload = function () { initHands(); };
      s.onerror = function () { gestureFail(); }; // 离线/被墙：静默降级
      document.head.appendChild(s);
      gesture.script = s;
    } catch (e) { gestureFail(); }
  }

  /* ================= 能力检测 ================= */
  function detectCaps() {
    var caps = { mouse: false, touch: false, shake: false, gesture: false };
    try {
      caps.mouse = (window.matchMedia && window.matchMedia('(hover: hover)').matches) ||
        !('ontouchstart' in window);
    } catch (e) { /* 保持 false */ }
    try {
      caps.touch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    } catch (e) { /* 保持 false */ }
    try {
      caps.shake = ('DeviceMotionEvent' in window);
    } catch (e) { /* 保持 false */ }
    return caps;
  }

  /* ================= 接口 ================= */
  function init() {
    var caps = detectCaps();
    B.bus.emit('input-status', caps); // 同步能力报告（gesture 稍后异步更新）

    if (caps.mouse) { try { initMouse(); } catch (e) { /* 静默 */ } }
    if (caps.touch) { try { initTouch(); } catch (e) { /* 静默 */ } }
    if (caps.shake) { try { initShake(); } catch (e) { /* 静默 */ } }
    try { initGesture(); } catch (e) { gestureFail(); } // 摄像头永远尽力而为
  }

  function dispose() {
    window.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('mouseleave', onMouseLeave);
    window.removeEventListener('blur', onWindowBlur);
    document.removeEventListener('contextmenu', onContextMenu);
    window.removeEventListener('touchstart', onTouchStart);
    window.removeEventListener('touchmove', onTouchMove);
    window.removeEventListener('touchend', onTouchEnd);
    window.removeEventListener('touchcancel', onTouchEnd);
    window.removeEventListener('devicemotion', onDeviceMotion);
    if (hold.timer) { clearInterval(hold.timer); hold.timer = null; }
    hold.mouse = hold.touch = false;
    gestureCleanup();
    emitGesture('off', 0);
    try {
      if (gesture.script && gesture.script.parentNode) {
        gesture.script.parentNode.removeChild(gesture.script);
      }
    } catch (e) { /* 静默 */ }
    gesture.script = null;
  }

  /* ---------- 注册 ---------- */
  B.register('input', {
    init: init,
    dispose: dispose
  });
})();
