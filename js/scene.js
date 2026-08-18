/* ============================================================
 * scene.js — Three.js 场景主流程
 *
 * 职责：
 *   1. 初始化 WebGLRenderer / Scene / PerspectiveCamera
 *   2. 相机固定侧面 3/4 视角（卷轴观感，不再可旋转）
 *   3. 主循环 render(dt)：驱动 bamboo + world 后渲染
 *   4. resize：响应窗口尺寸变化
 *
 * 视角约定（2026-08-18 改为固定）：
 *   - theta=0.40, phi=0.35, dist=7（固定，不响应输入）
 *   - 相机随竹蜻蜓 y 上下平移（保持主角在画面中央偏下）
 *   - 低空（alt<0.05）注视点上抬更明显，保留"掠过草尖"观感
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

  // 相机固定球坐标（侧面 3/4 视角，卷轴观感）
  //   theta=0.40 → 水平角约 23°（相机偏右后侧看）
  //   phi  =0.35 → 仰角约 20°（略俯视）
  //   dist =7    → 距主角 7 单位，给云海和星球留出景深
  // 不再响应 camera-rotate / camera-zoom 事件（input.js 已停止发送）
  var CAM_THETA = 0.40;
  var CAM_PHI = 0.35;
  var CAM_DIST = 7;
  // 注视点上抬量：让竹蜻蜓稳定出现在画面中央偏下
  var LOOK_OFFSET_BASE = 0.7;
  var LOOK_OFFSET_LOW_ALT = 0.9; // 低空时额外上抬，让"掠过草尖"感保留

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
    var cx0 = CAM_DIST * Math.cos(CAM_PHI) * Math.cos(CAM_THETA);
    var cy0 = CAM_DIST * Math.sin(CAM_PHI);
    var cz0 = CAM_DIST * Math.cos(CAM_PHI) * Math.sin(CAM_THETA);
    camSmoothPos.set(cx0, cy0, cz0);
    camera.position.copy(camSmoothPos);
    camera.lookAt(0, LOOK_OFFSET_BASE, 0);

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

    // ---- resize 监听 ----
    window.addEventListener('resize', resize);
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

    // ---- 固定球坐标 → 笛卡尔，加到竹蜻蜓位置 ----
    // 相机角度/距离恒定，只随竹蜻蜓 x/y/z 平移（卷轴视角锁定）
    var cx = CAM_DIST * Math.cos(CAM_PHI) * Math.cos(CAM_THETA);
    var cy = CAM_DIST * Math.sin(CAM_PHI);
    var cz = CAM_DIST * Math.cos(CAM_PHI) * Math.sin(CAM_THETA);

    var desiredX = camTargetPos.x + cx;
    var desiredY = camTargetPos.y + cy;
    var desiredZ = camTargetPos.z + cz;

    // ---- 平滑插值（缓动，避免抖动）----
    camSmoothPos.x = BG.lerp(camSmoothPos.x, desiredX, 0.12);
    camSmoothPos.y = BG.lerp(camSmoothPos.y, desiredY, 0.12);
    camSmoothPos.z = BG.lerp(camSmoothPos.z, desiredZ, 0.12);
    camera.position.copy(camSmoothPos);

    // ---- 注视点：固定略高于竹蜻蜓，让主角位于画面中央偏下 ----
    // 低空 alt<0.05 时额外上抬（LOOK_OFFSET_LOW_ALT），让"掠过草尖"感保留
    var alt = BG.S.altitude || 0;
    var lowAltT = alt < 0.05 ? (1 - alt / 0.05) : 0;
    var lookY = camTargetPos.y + LOOK_OFFSET_BASE + lowAltT * LOOK_OFFSET_LOW_ALT;
    camera.lookAt(camTargetPos.x, lookY, camTargetPos.z);

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