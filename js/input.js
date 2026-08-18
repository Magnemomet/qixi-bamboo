/* ============================================================
 * input.js — 输入模块（fairy 实现）
 *
 * 职责：收集所有"转动/操控"输入源并注入物理：
 *   - 鼠标：按住左键 = 持续注入（点击转动）；松开/移出窗口 = 停止，靠惯性滑翔
 *   - 触摸：单指按住 = 持续注入；抬起/取消 = 停止（不再需要划动）
 *   - 摇一摇：devicemotion 加速度变化率超阈值 = 注入（Android，iOS 尽力而为）
 *   - 摄像头手势：MediaPipe Hands 双掌心相对搓动 / 单掌心上下挥动（尽力而为）
 * 原则：能力检测 + try/catch 全包裹，任何失败静默降级，绝不抛错。
 *
 * 接口：
 *   init()    能力检测、挂事件、启动摄像头手势（异步）、emit 能力报告
 *   dispose() 移除全部监听、停止摄像头流、关闭 MediaPipe、清理注入定时器
 *
 * 事件（emit）：
 *   input-status  {mouse, touch, shake, gesture}   能力检测结果（gesture 异步更新）
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
    GESTURE_DIST_RATE: 0.35,  // 双掌心距离变化率阈值（归一坐标/s）
    GESTURE_RPS_K: 12,        // rps 正比系数（原 90 → 1/7.5）：rps = min(|rate| * K, MAX)
    GESTURE_RPS_MAX: 5,       // 单次手势注入上限（5rps ≈ +270rpm，落在单次 +100~300rpm 目标）
    GESTURE_Y_RATE: 1.2,      // 单手 y 方向速度阈值（归一坐标/s，快速往复）
    GESTURE_SINGLE_K: 6,      // 单手 rps 系数（原 45 → 1/7.5，与双手同比例）
    GESTURE_THROTTLE: 120,    // ms，手势搓动节流
    VIDEO_W: 320, VIDEO_H: 240
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
    prevD: null,      // 双手距离 {d, t}
    prevY: null,      // 单手掌心 y {y, t}
    lastSpinT: 0,
    loopId: 0
  };

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
    try {
      if (gesture.video && gesture.video.parentNode) {
        gesture.video.parentNode.removeChild(gesture.video);
      }
    } catch (e) { /* 静默 */ }
    gesture.video = null;
    gesture.prevD = gesture.prevY = null;
  }

  /* 摄像头初始化失败/权限被拒/wasm 加载失败：静默降级 */
  function gestureFail() {
    gestureCleanup();
    B.bus.emit('input-status', { gesture: false });
  }

  function onHandResults(results) {
    if (!results || !results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
      gesture.prevD = null;
      gesture.prevY = null;
      return;
    }
    var now = performance.now();
    var handsList = results.multiHandLandmarks;
    var P = 9; // 掌根中心（掌心），比手腕(0)更稳

    if (handsList.length >= 2) {
      /* 双手：两掌心距离变化率超阈值 → 搓动（rps 正比变化率） */
      var h0 = handsList[0][P], h1 = handsList[1][P];
      var d = Math.sqrt(Math.pow(h0.x - h1.x, 2) + Math.pow(h0.y - h1.y, 2));
      if (gesture.prevD) {
        var dt = Math.max((now - gesture.prevD.t) / 1000, 0.001);
        var rate = (d - gesture.prevD.d) / dt;
        if (Math.abs(rate) > CONST.GESTURE_DIST_RATE &&
            now - gesture.lastSpinT > CONST.GESTURE_THROTTLE) {
          gesture.lastSpinT = now;
          doSpin(Math.min(Math.abs(rate) * CONST.GESTURE_RPS_K, CONST.GESTURE_RPS_MAX), 'gesture');
        }
      }
      gesture.prevD = { d: d, t: now };
      gesture.prevY = null;
    } else {
      /* 单手：掌心 y 方向快速往复（简化：|vy| 超阈值即搓动，节流防灌爆） */
      var y = handsList[0][P].y;
      if (gesture.prevY) {
        var dt2 = Math.max((now - gesture.prevY.t) / 1000, 0.001);
        var vy = Math.abs(y - gesture.prevY.y) / dt2;
        if (vy > CONST.GESTURE_Y_RATE && now - gesture.lastSpinT > CONST.GESTURE_THROTTLE) {
          gesture.lastSpinT = now;
          doSpin(Math.min(vy * CONST.GESTURE_SINGLE_K, CONST.GESTURE_RPS_MAX), 'gesture');
        }
      }
      gesture.prevY = { y: y, t: now };
      gesture.prevD = null;
    }
  }

  function handLoop() {
    if (!gesture.on || !gesture.hands || !gesture.video) return;
    gesture.hands.send({ image: gesture.video }).then(function () {
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
          /* 隐藏渲染：1×1 像素 + opacity 0，不显示在页面上 */
          var video = document.createElement('video');
          video.setAttribute('playsinline', '');
          video.muted = true;
          video.width = 1;
          video.height = 1;
          video.style.cssText =
            'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;' +
            'pointer-events:none;';
          video.srcObject = stream;
          video.play().catch(function () { /* 静默：play 失败走降级 */ });
          document.body.appendChild(video);
          gesture.video = video;

          var Hands = window.Hands;
          if (!Hands) { gestureFail(); return; }
          var hands = new Hands({
            locateFile: function (f) { return CONST.HANDS_CDN + f; }
          });
          hands.setOptions({ maxNumHands: 2, modelComplexity: 0 });
          hands.onResults = onHandResults;
          gesture.hands = hands;
          gesture.on = true;
          B.bus.emit('input-status', { gesture: true });
          handLoop();
        } catch (e) { gestureFail(); }
      }).catch(function () { gestureFail(); }); // 权限被拒 / 非安全上下文
    } catch (e) { gestureFail(); }
  }

  function initGesture() {
    try {
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
