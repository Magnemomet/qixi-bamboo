/* ============================================================
 * bamboo.js — 竹蜻蜓 3D 模型与高速残影
 *
 * 视觉方案：
 *   - 两片对称桨叶（自定义 BufferGeometry，根部厚→叶尖薄）
 *   - 竖直转轴（CylinderGeometry，细长）
 *   - 桨毂（短圆柱，连桨叶与轴）
 *   - 高速残影：半透明桨盘扇形 mesh + 外圈圆环
 *
 * 行为：
 *   - 位置：y = S.altitude * 80
 *   - 旋转：绕竖直 Y 轴累积，角度 += rpm/60 * 2π * dt * 0.5
 *   - 陀螺感：omega 大时轻微 XYZ 三轴摆动
 *
 * 接口：{init(), update(dt), getPos()}
 * getPos 是给 scene 跟随用的扩展接口
 * ============================================================ */
(function () {
  'use strict';

  var THREE = window.THREE;
  var BG = window.BambooGame;
  if (!THREE) { console.error('[bamboo] THREE 未加载'); return; }

  // ========== 内部状态 ==========
  var group;            // 根 Group（加到 scene）
  var rotors;           // 桨叶旋转体（用于累积 rotation.y）
  var afterImage;       // 残影扇形盘
  var afterRing;        // 外圈光环
  var angle = 0;        // 桨叶累积旋转角（弧度）
  var wobbleT = 0;      // 陀螺感晃动时间
  var added = false;    // 是否已加入 scene
  var initialized = false;

  // ========== 工具：程序化竹纹 CanvasTexture ==========
  // 256×64，竹黄底色 + 纤维细纹 + 3 条深色竹节横线 + 节边亮线
  function makeBambooTexture() {
    var c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    var ctx = c.getContext('2d');

    // 底色（暖竹黄）
    ctx.fillStyle = '#d9b36c';
    ctx.fillRect(0, 0, c.width, c.height);

    // 纤维细纹（细斜线）
    ctx.strokeStyle = 'rgba(120, 80, 30, 0.22)';
    ctx.lineWidth = 1;
    for (var i = 0; i < 110; i++) {
      var y = Math.random() * c.height;
      var x = Math.random() * c.width;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 6 + Math.random() * 14, y + (Math.random() - 0.5) * 1.5);
      ctx.stroke();
    }

    // 3 条深色竹节横线 + 节边亮线（带轻微阴影）
    var nodes = [56, 134, 208];
    for (var n = 0; n < nodes.length; n++) {
      var x = nodes[n];
      // 节阴影
      ctx.fillStyle = 'rgba(80, 50, 22, 0.18)';
      ctx.fillRect(x - 2, 0, 7, c.height);
      // 节主线
      ctx.fillStyle = 'rgba(70, 45, 20, 0.70)';
      ctx.fillRect(x, 0, 2.5, c.height);
      // 节边亮线
      ctx.fillStyle = 'rgba(255, 230, 180, 0.35)';
      ctx.fillRect(x + 2.5, 0, 1, c.height);
    }

    var tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // ========== 自定义桨叶 BufferGeometry ==========
  // 8 顶点：根部宽厚 → 叶尖收窄变薄
  // 形状：楔形竹片，根部 rootW×rootT，叶尖 tipW×tipT
  // 在 XY 平面（X 是宽，Y 是长），Z 是厚度方向
  function makeBladeGeometry() {
    var rootW = 0.13, tipW = 0.05;
    var rootT = 0.026, tipT = 0.012;
    var len = 0.9;

    // 顶点：4 个底面 + 4 个顶面，共 8 个
    var verts = [
      // 上面（+Z 面），逆时针
      -rootW / 2, 0,        rootT / 2,  // 0 root TL
       rootW / 2, 0,        rootT / 2,  // 1 root TR
       tipW / 2,  len,      tipT / 2,   // 2 tip TR
      -tipW / 2,  len,      tipT / 2,   // 3 tip TL
      // 下面（-Z 面），逆时针
      -rootW / 2, 0,       -rootT / 2,  // 4 root BL
       rootW / 2, 0,       -rootT / 2,  // 5 root BR
       tipW / 2,  len,     -tipT / 2,   // 6 tip BR
      -tipW / 2,  len,     -tipT / 2    // 7 tip BL
    ];

    // 12 个三角形 = 6 个面（上下 + 4 个侧面）
    var indices = [
      // 上面（法向 +Z）
      0, 1, 2,   0, 2, 3,
      // 下面（法向 -Z，绕序反转）
      4, 6, 5,   4, 7, 6,
      // 根部侧面（Y=0）
      0, 4, 5,   0, 5, 1,
      // 叶尖侧面（Y=len）
      3, 2, 6,   3, 6, 7,
      // 左边缘（X 负侧）
      0, 3, 7,   0, 7, 4,
      // 右边缘（X 正侧）
      1, 5, 6,   1, 6, 2
    ];

    var geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();

    // 计算 UV（让竹纹沿长度方向重复）
    var uvs = [
      // 上面
      0, 0,   1, 0,   1, 1,   0, 1,
      // 下面
      0, 0,   1, 0,   1, 1,   0, 1
    ];
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));

    return geom;
  }

  // ========== 构造一片桨叶 ==========
  // 通过嵌套 group 实现：
  //   - blade mesh：几何在 XY 平面（X 宽，Y 长，Z 厚）
  //   - tiltGroup：rotation.x = -15°（桨叶面与水平面成 15° 倾角，叶尖上仰）
  //   - horizGroup：rotation.z = -90°（让 +Y 变 +X，桨叶水平伸出沿 +X）
  // 调用方再通过 rotation.y = π 做对称第二片
  function makeBlade() {
    var geom = makeBladeGeometry();
    var tex = makeBambooTexture();

    var mat = new THREE.MeshStandardMaterial({
      color: 0xd9b36c,
      map: tex,
      roughness: 0.55,
      metalness: 0.05,
      side: THREE.DoubleSide
    });

    var blade = new THREE.Mesh(geom, mat);

    var tiltGroup = new THREE.Group();
    tiltGroup.rotation.x = -0.262;  // -15°
    tiltGroup.add(blade);

    var horizGroup = new THREE.Group();
    horizGroup.rotation.z = -Math.PI / 2;
    horizGroup.add(tiltGroup);

    return horizGroup;
  }

  // ========== 初始化 ==========
  function init() {
    if (initialized) return;
    initialized = true;

    group = new THREE.Group();
    rotors = new THREE.Group();

    // 两片桨叶（旋转 180° 对称）
    var blade1 = makeBlade();
    var blade2 = makeBlade();
    blade2.rotation.y = Math.PI;
    rotors.add(blade1);
    rotors.add(blade2);

    // 桨毂（短圆柱，深竹色）
    var hubGeom = new THREE.CylinderGeometry(0.058, 0.046, 0.06, 24);
    var hubMat = new THREE.MeshStandardMaterial({
      color: 0xa8742e, roughness: 0.45, metalness: 0.18
    });
    var hub = new THREE.Mesh(hubGeom, hubMat);
    hub.position.y = 0.20;
    group.add(hub);

    // 转轴（贯穿，细长竹色圆柱）
    var axisGeom = new THREE.CylinderGeometry(0.018, 0.016, 0.55, 16);
    var axisMat = new THREE.MeshStandardMaterial({
      color: 0xb88a48, roughness: 0.42, metalness: 0.22
    });
    var axis = new THREE.Mesh(axisGeom, axisMat);
    group.add(axis);

    // 桨叶层放在桨毂上方（桨毂夹在桨叶与转轴之间）
    rotors.position.y = 0.20;
    group.add(rotors);

    // ---- 残影扇形盘（高速时显示为暖白圆盘）----
    var afterGeom = new THREE.CircleGeometry(0.48, 48);
    var afterMat = new THREE.MeshBasicMaterial({
      color: 0xfff0c8,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    afterImage = new THREE.Mesh(afterGeom, afterMat);
    afterImage.rotation.x = -Math.PI / 2;
    afterImage.position.y = 0.215;
    afterImage.renderOrder = 2;
    group.add(afterImage);

    // ---- 外圈光环（更淡的圆环，营造旋涡感）----
    var ringGeom = new THREE.RingGeometry(0.46, 0.58, 64);
    var ringMat = new THREE.MeshBasicMaterial({
      color: 0xfff5d6,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    afterRing = new THREE.Mesh(ringGeom, ringMat);
    afterRing.rotation.x = -Math.PI / 2;
    afterRing.position.y = 0.21;
    afterRing.renderOrder = 2;
    group.add(afterRing);

    // 延迟加入 scene（scene 可能尚未初始化）
    tryAddToScene();
  }

  // ========== 尝试加入 scene（幂等）==========
  function tryAddToScene() {
    if (added) return;
    var sceneMod = BG.getModule('scene');
    if (sceneMod && sceneMod.getScene) {
      sceneMod.getScene().add(group);
      added = true;
    }
  }

  // ========== 每帧更新 ==========
  function update(dt) {
    if (!initialized) return;
    if (!added) tryAddToScene();
    if (!group) return;

    // ---- 桨叶累积旋转 ----
    var rpm = BG.S.rpm || 0;
    angle += (rpm / 60) * Math.PI * 2 * dt * 0.5;
    if (rotors) rotors.rotation.y = angle;

    // ---- 残影透明度（转速越高越明显）----
    var rpmNorm = BG.clamp(rpm / 3000, 0, 1);
    if (afterImage) {
      afterImage.material.opacity = rpmNorm * 0.22;
      afterImage.rotation.z = angle * 0.3;
    }
    if (afterRing) {
      afterRing.material.opacity = rpmNorm * 0.08;
      afterRing.rotation.z = -angle * 0.5;
    }

    // ---- 高度驱动位置 ----
    group.position.y = (BG.S.altitude || 0) * 80;

    // ---- 陀螺感晃动（omega 大时轻微摆动）----
    wobbleT += dt * (1 + (BG.S.omega || 0) * 0.08);
    var wobbleAmp = BG.clamp((BG.S.omega || 0) / 80, 0, 1) * 0.05;
    group.rotation.z = Math.sin(wobbleT * 7.3) * wobbleAmp;
    group.rotation.x = Math.cos(wobbleT * 5.7) * wobbleAmp * 0.6;
    group.rotation.y = Math.sin(wobbleT * 3.1) * wobbleAmp * 0.3;
  }

  // ========== 暴露给 scene 的位置查询 ==========
  function getPos() {
    if (!group) return new THREE.Vector3(0, 0, 0);
    return group.position.clone();
  }

  BG.register('bamboo', {
    init: init,
    update: update,
    getPos: getPos
  });
})();