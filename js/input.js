/* ============================================================
 * input.js — 输入模块（fairy 实现）
 *
 * 职责：收集所有"搓动/操控"输入源并注入物理：
 *   - 鼠标：快速横移（>700px/s）= 搓动；慢速拖拽 / 右键拖拽 = 视角旋转
 *   - 触摸：单指快速来回划 = 搓动；慢速单指 = 旋转；双指滑动 = 旋转 + 捏合 = 缩放
 *   - 摇一摇：devicemotion 加速度变化率超阈值 = 搓动（Android，iOS 尽力而为）
 *   - 摄像头手势：MediaPipe Hands 双掌心相对搓动 / 单掌心上下挥动（尽力而为）
 * 原则：能力检测 + try/catch 全包裹，任何失败静默降级，绝不抛错。
 *
 * 接口：
 *   init()    能力检测、挂事件、启动摄像头手势（异步）、emit 能力报告
 *   dispose() 移除全部监听、停止摄像头流、关闭 MediaPipe、清理注入节点
 *
 * 事件（emit）：
 *   input-status  {mouse, touch, shake, gesture}   能力检测结果（gesture 异步更新）
 *   camera-rotate {dx, dy}   视角拖拽（像素位移，右为正）
 *   camera-zoom   {delta}    双指捏合（delta>0 张开/放大，像素）
 *
 * 搓动走 physics.spin()（正增量接口，本模块负责节流，防止每帧灌爆）。
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

  /* ---------- 调参常量 ---------- */
  var CONST = {
    /* 搓动通用 */
    SPIN_VELOCITY: 700,    // px/s 横向速度阈值，超过即搓动
    SPIN_RPS_K: 0.25,      // rps = |vx| / 100 * 25（即 vx * 0.25）
    SPIN_THROTTLE: 50,     // ms，两次搓动最小间隔（防每帧灌爆）

    /* 摇一摇 */
    SHAKE_THRESHOLD: 12,   // 加速度变化率阈值（m/s² 帧间差向量模）
    SHAKE_RPS_K: 2,        // rps = min(Δacc * 2, SHAKE_RPS_MAX)
    SHAKE_RPS_MAX: 40,
    SHAKE_THROTTLE: 80,    // ms

    /* 摄像头手势（MediaPipe Hands） */
    HANDS_CDN: 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/',
    GESTURE_DIST_RATE: 0.35,  // 双掌心距离变化率阈值（归一坐标/s）
    GESTURE_RPS_K: 90,        // rps 正比系数：rps = min(|rate| * K, MAX)
    GESTURE_RPS_MAX: 40,
    GESTURE_Y_RATE: 1.2,      // 单手 y 方向速度阈值（归一坐标/s，快速往复）
    GESTURE_SINGLE_K: 45,     // 单手 rps 系数（比双手保守）
    GESTURE_THROTTLE: 120,    // ms，手势搓动节流
    VIDEO_W: 320, VIDEO_H: 240
  };

  /* ---------- 内部状态 ---------- */
  var physics = null;           // 惰性获取 BambooGame.getModule('physics')

  function doSpin(rps, source) {
    if (!physics) physics = B.getModule('physics');
    if (physics && physics.spin) physics.spin(rps, source);
  }

  /* ================= 鼠标 ================= */
  var mouse = { down: false, button: 0, x: 0, y: 0, lastT: 0, lastSpinT: 0 };

  function onMouseDown(e) {
    if (e.button !== 0 && e.button !== 2) return; // 只要左/右键
    mouse.down = true;
    mouse.button = e.button;
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.lastT = performance.now();
  }
  function onMouseMove(e) {
    if (!mouse.down) return;
    var now = performance.now();
    var dt = Math.max((now - mouse.lastT) / 1000, 0.001);
    var dx = e.clientX - mouse.x;
    var dy = e.clientY - mouse.y;
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.lastT = now;
    if (mouse.button === 2) {           // 右键拖拽：纯视角旋转
      if (Math.abs(dx) + Math.abs(dy) > 0) B.bus.emit('camera-rotate', { dx: dx, dy: dy });
      return;
    }
    var vx = Math.abs(dx) / dt;         // 横向速度 px/s
    if (vx > CONST.SPIN_VELOCITY && now - mouse.lastSpinT > CONST.SPIN_THROTTLE) {
      mouse.lastSpinT = now;
      doSpin(vx * CONST.SPIN_RPS_K, 'mouse');
    } else if (Math.abs(dx) + Math.abs(dy) > 1) {
      B.bus.emit('camera-rotate', { dx: dx, dy: dy });
    }
  }
  function onMouseUp() { mouse.down = false; }
  function onContextMenu(e) { try { e.preventDefault(); } catch (err) { /* 静默 */ } }

  function initMouse() {
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    document.addEventListener('contextmenu', onContextMenu); // 右键拖拽不弹菜单
  }

  /* ================= 触摸 ================= */
  var touch = {
    count: 0, points: {},      // identifier → {x, y, t}
    lastCX: -1, lastCY: 0,     // 双指中心（-1 表示无效）
    prevPinch: 0,              // 双指距离
    lastSpinT: 0
  };

  function onTouchStart(e) {
    try { e.preventDefault(); } catch (err) { /* 静默 */ }
    touch.count = e.touches.length;
    touch.points = {};
    for (var i = 0; i < e.touches.length; i++) {
      var t = e.touches[i];
      touch.points[t.identifier] = { x: t.clientX, y: t.clientY, t: performance.now() };
    }
    if (e.touches.length < 2) { touch.lastCX = -1; }
  }
  function onTouchMove(e) {
    try { e.preventDefault(); } catch (err) { /* 静默 */ }
    var now = performance.now();
    var n = e.touches.length;
    if (n === 1) {
      var t = e.touches[0];
      var p = touch.points[t.identifier];
      if (p) {
        var dt = Math.max((now - p.t) / 1000, 0.001);
        var dx = t.clientX - p.x;
        var dy = t.clientY - p.y;
        var vx = Math.abs(dx) / dt;
        if (vx > CONST.SPIN_VELOCITY && now - touch.lastSpinT > CONST.SPIN_THROTTLE) {
          touch.lastSpinT = now;
          doSpin(vx * CONST.SPIN_RPS_K, 'touch');
        } else if (Math.abs(dx) + Math.abs(dy) > 1) {
          B.bus.emit('camera-rotate', { dx: dx, dy: dy });
        }
        touch.points[t.identifier] = { x: t.clientX, y: t.clientY, t: now };
      }
    } else if (n >= 2) {
      var t0 = e.touches[0], t1 = e.touches[1];
      var cx = (t0.clientX + t1.clientX) / 2;
      var cy = (t0.clientY + t1.clientY) / 2;
      var dist = Math.sqrt(
        Math.pow(t1.clientX - t0.clientX, 2) + Math.pow(t1.clientY - t0.clientY, 2));
      if (touch.lastCX >= 0) {
        var mdx = cx - touch.lastCX, mdy = cy - touch.lastCY;
        if (Math.abs(mdx) + Math.abs(mdy) > 1) {
          B.bus.emit('camera-rotate', { dx: mdx, dy: mdy });
        }
        var dDelta = dist - touch.prevPinch;
        if (Math.abs(dDelta) > 2) B.bus.emit('camera-zoom', { delta: dDelta });
      }
      touch.lastCX = cx;
      touch.lastCY = cy;
      touch.prevPinch = dist;
    }
    touch.count = n;
  }
  function onTouchEnd(e) {
    touch.count = e.touches.length;
    if (e.touches.length < 2) touch.lastCX = -1;
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
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('contextmenu', onContextMenu);
    window.removeEventListener('touchstart', onTouchStart);
    window.removeEventListener('touchmove', onTouchMove);
    window.removeEventListener('touchend', onTouchEnd);
    window.removeEventListener('touchcancel', onTouchEnd);
    window.removeEventListener('devicemotion', onDeviceMotion);
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
