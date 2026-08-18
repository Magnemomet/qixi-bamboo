/* ============================================================
 * scene.js — Three.js 场景主流程
 *
 * 职责：
 *   1. 初始化 WebGLRenderer / Scene / PerspectiveCamera
 *   2. 相机以球坐标方式相对跟随竹蜻蜓（bus 事件可微调）
 *   3. 主循环 render(dt)：驱动 bamboo + world 后渲染
 *   4. resize：响应窗口尺寸变化
 *
 * 不做的事：
 *   - 不创建世界元素（world.js 负责）
 *   - 不创建竹蜻蜓模型（bamboo.js 负责）
 *   - 不处理任何业务逻辑（只渲染）
 *
 * 暴露给其他模块的扩展接口：getScene / getCamera / getRenderer
 * ============================================================ */
(function () {
  'use strict';

  var THREE = window.THREE;
  var BG = window.BambooGame;
  if (!THREE) { console.error('[scene] THREE 未加载'); return; }

  // ========== 内部状态 ==========
  var container;        // #game-container DOM
  var scene;
  var camera;
  var renderer;
  var initialized = false;

  // 相机相对竹蜻蜓的偏移（球坐标）
  // 默认：偏右上后方，仰角约 23°，距离 6 单位
  var camOrbit = {
    theta: 0.55,        // 水平角（弧度）
    phi: 0.40,          // 仰角（弧度），0=水平面，π/2=垂直
    dist: 6             // 距目标距离
  };
  var camSmoothPos = new THREE.Vector3();
  var camTargetPos = new THREE.Vector3();

  // 移动端检测（Android UA 或窄屏）
  function isMobile() {
    if (/Android/i.test(navigator.userAgent || '')) return true;
    if (window.innerWidth <= 640) return true;
    return false;
  }

  // ========== 初始化 ==========
  function init(containerEl) {
    if (initialized) return;
    initialized = true;

    container = containerEl || document.getElementById('game-container');
    if (!container) { console.error('[scene] 找不到 #game-container'); return; }

    // ---- Scene ----
    scene = new THREE.Scene();

    // ---- Camera ----
    var ar = container.clientWidth / Math.max(container.clientHeight, 1);
    camera = new THREE.PerspectiveCamera(60, ar, 0.1, 2000);
    var cx0 = camOrbit.dist * Math.cos(camOrbit.phi) * Math.cos(camOrbit.theta);
    var cy0 = camOrbit.dist * Math.sin(camOrbit.phi);
    var cz0 = camOrbit.dist * Math.cos(camOrbit.phi) * Math.sin(camOrbit.theta);
    camSmoothPos.set(cx0, cy0, cz0);
    camera.position.copy(camSmoothPos);
    camera.lookAt(0, 0, 0);

    // ---- Renderer ----
    var pr = isMobile() ? 1.5 : 2;
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance'
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pr));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.outputEncoding = THREE.sRGBEncoding;
    container.appendChild(renderer.domElement);

    // ---- 灯光（暖色基调）----
    var ambient = new THREE.AmbientLight(0xfff0d0, 0.65);
    scene.add(ambient);

    var sun = new THREE.DirectionalLight(0xfff2cc, 1.0);
    sun.position.set(6, 10, 4);
    scene.add(sun);

    var hemi = new THREE.HemisphereLight(0xb6d6ff, 0x4d6b3e, 0.45);
    scene.add(hemi);

    // ---- 事件订阅 ----
    BG.bus.on('camera-rotate', onCamRotate);
    BG.bus.on('camera-zoom', onCamZoom);

    // ---- resize 监听 ----
    window.addEventListener('resize', resize);
  }

  // ========== 相机控制事件 ==========
  function onCamRotate(d) {
    if (!d) return;
    camOrbit.theta -= (d.dx || 0) * 0.005;
    camOrbit.phi = BG.clamp(camOrbit.phi - (d.dy || 0) * 0.005, 0.10, 1.35);
  }

  function onCamZoom(d) {
    if (!d) return;
    camOrbit.dist = BG.clamp(camOrbit.dist + (d.delta || 0) * 0.5, 3, 15);
  }

  // ========== resize ==========
  function resize() {
    if (!container || !renderer || !camera) return;
    var w = container.clientWidth;
    var h = container.clientHeight;
    if (h <= 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }

  // ========== 主渲染循环（每帧调用一次）==========
  function render(dt) {
    if (!initialized || !scene || !camera || !renderer) return;

    // ---- 取竹蜻蜓世界坐标 ----
    var bambooMod = BG.getModule('bamboo');
    if (bambooMod && bambooMod.getPos) {
      var p = bambooMod.getPos();
      camTargetPos.set(p.x, p.y, p.z);
    } else {
      camTargetPos.set(0, (BG.S.altitude || 0) * 80, 0);
    }

    // ---- 球坐标 → 笛卡尔，加到竹蜻蜓位置 ----
    var cx = camOrbit.dist * Math.cos(camOrbit.phi) * Math.cos(camOrbit.theta);
    var cy = camOrbit.dist * Math.sin(camOrbit.phi);
    var cz = camOrbit.dist * Math.cos(camOrbit.phi) * Math.sin(camOrbit.theta);

    var desiredX = camTargetPos.x + cx;
    var desiredY = camTargetPos.y + cy;
    var desiredZ = camTargetPos.z + cz;

    // ---- 平滑插值（缓动，避免抖动）----
    camSmoothPos.x = BG.lerp(camSmoothPos.x, desiredX, 0.12);
    camSmoothPos.y = BG.lerp(camSmoothPos.y, desiredY, 0.12);
    camSmoothPos.z = BG.lerp(camSmoothPos.z, desiredZ, 0.12);
    camera.position.copy(camSmoothPos);

    // 低空时注视点略上抬，让竹蜻蜓位于画面下方（"刚离手"感）
    var alt = BG.S.altitude || 0;
    var altLift = alt < 0.05 ? 0.7 * (1 - alt / 0.05) : 0;
    camera.lookAt(camTargetPos.x, camTargetPos.y + altLift, camTargetPos.z);

    // ---- 驱动依赖模块 ----
    if (bambooMod && bambooMod.update) bambooMod.update(dt);
    var worldMod = BG.getModule('world');
    if (worldMod && worldMod.update) worldMod.update(dt);

    // ---- 渲染 ----
    renderer.render(scene, camera);
  }

  // ========== 暴露接口 ==========
  function getScene() { return scene; }
  function getCamera() { return camera; }
  function getRenderer() { return renderer; }

  BG.register('scene', {
    init: init,
    render: render,
    resize: resize,
    getScene: getScene,
    getCamera: getCamera,
    getRenderer: getRenderer
  });
})();