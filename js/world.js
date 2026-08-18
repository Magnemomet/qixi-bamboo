/* ============================================================
 * world.js — 7 层背景世界（按 PHASES 表逐层构建）
 *
 * 视觉驱动：S.altitude（0~1.2）
 *   1. ground       草地 / 树 / 城市剪影 / 小飞机
 *   2. cloud        14 朵积云，缓慢漂移
 *   3. stratosphere 8 朵稀薄云 + 高空飞机 + 尾迹
 *   4. space        星空粒子 + 地球（带大气辉光）
 *   5. planets      火星 / 土星（带环）/ 木星
 *   6. moon         大月球（接近时巨大化）+ 光晕 + 弱光
 *   7. galaxy       银河螺旋盘 + 星云 + 远景亮星
 *
 * 全部程序化：CanvasTexture + 几何体，禁外部贴图
 * 性能：粒子 ≤ 4000；移动端降级（粒子减半、不开阴影）
 *
 * 接口：{init(), update(dt)}
 * ============================================================ */
(function () {
  'use strict';

  var THREE = window.THREE;
  var BG = window.BambooGame;
  if (!THREE) { console.error('[world] THREE 未加载'); return; }

  // ========== 内部状态 ==========
  var root;             // 根 Group（7 层都挂这下面）
  var layerGroups = []; // 7 层 group，索引对齐 PHASES
  var layerData = [];   // 每层 update 函数
  var skyUniforms;      // 天空 shader uniforms
  var initialized = false;

  // 移动端检测（Android UA 或窄屏）
  var MOBILE = /Android/i.test(navigator.userAgent || '') || window.innerWidth <= 640;

  // ========== 工具：按 altitude 计算 7 层权重 ==========
  // 每层在自己 t 处权重 = 1，前后 smoothstep 平滑过渡到 0
  function computeWeights(alt) {
    var phases = BG.PHASES;
    var w = new Array(phases.length).fill(0);
    for (var i = 0; i < phases.length; i++) {
      var ph = phases[i];
      var prevT = (phases[i - 1] || { t: ph.t - 0.4 }).t;
      var nextT = (phases[i + 1] || { t: BG.ALTITUDE_MAX + 0.4 }).t;
      w[i] = BG.smoothstep(prevT, ph.t, alt) * (1 - BG.smoothstep(ph.t, nextT, alt));
    }
    return w;
  }

  // ========== 通用 CanvasTexture 工具 ==========
  function makeCanvas(w, h, drawFn) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    drawFn(c.getContext('2d'), w, h);
    var tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // 径向渐变光晕纹理（用于 moon halo、地球辉光、星云）
  function makeHaloTex(hexColor) {
    return makeCanvas(256, 256, function (ctx, w, h) {
      var r = (hexColor >> 16) & 0xff;
      var g = (hexColor >> 8) & 0xff;
      var b = hexColor & 0xff;
      var grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      grad.addColorStop(0, 'rgba(' + r + ',' + g + ',' + b + ', 0.65)');
      grad.addColorStop(0.3, 'rgba(' + r + ',' + g + ',' + b + ', 0.30)');
      grad.addColorStop(0.65, 'rgba(' + r + ',' + g + ',' + b + ', 0.08)');
      grad.addColorStop(1, 'rgba(' + r + ',' + g + ',' + b + ', 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    });
  }

  // ========== 天空穹顶（球体内侧 + 自定义渐变 shader）==========
  // 不跟随竹蜻蜓，固定世界中心，给整个场景一个远景
  function buildSky() {
    var skyGeom = new THREE.SphereGeometry(900, 32, 16);
    skyUniforms = {
      topColor:    { value: new THREE.Color(0x87b7e8) },
      bottomColor: { value: new THREE.Color(0xffd9a0) },
      horizonGlow: { value: 0.30 }
    };
    var skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: skyUniforms,
      vertexShader: [
        'varying vec3 vWorldPos;',
        'void main() {',
        '  vec4 wp = modelMatrix * vec4(position, 1.0);',
        '  vWorldPos = wp.xyz;',
        '  gl_Position = projectionMatrix * viewMatrix * wp;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 topColor;',
        'uniform vec3 bottomColor;',
        'uniform float horizonGlow;',
        'varying vec3 vWorldPos;',
        'void main() {',
        '  vec3 dir = normalize(vWorldPos);',
        '  float h = dir.y * 0.5 + 0.5;',
        '  vec3 col = mix(bottomColor, topColor, smoothstep(0.30, 0.95, h));',
        '  float horizon = exp(-pow((h - 0.5) * 5.0, 2.0)) * horizonGlow;',
        '  col += vec3(1.0, 0.72, 0.42) * horizon;',
        '  gl_FragColor = vec4(col, 1.0);',
        '}'
      ].join('\n')
    });
    var sky = new THREE.Mesh(skyGeom, skyMat);
    sky.frustumCulled = false;
    sky.renderOrder = -1;
    return sky;
  }

  // 7 层天空色调预设（与 PHASES 对齐）
  var SKY_PRESETS = [
    { top: 0x6fb5e6, bot: 0xffd49a, glow: 0.40 }, // ground 海蓝+晚霞
    { top: 0x9ec5e6, bot: 0xffe2b3, glow: 0.25 }, // cloud
    { top: 0x3f6195, bot: 0x86afd4, glow: 0.10 }, // stratosphere
    { top: 0x081232, bot: 0x2a4a7a, glow: 0.02 }, // space
    { top: 0x040818, bot: 0x142040, glow: 0.01 }, // planets
    { top: 0x080d20, bot: 0x18253e, glow: 0.02 }, // moon
    { top: 0x000005, bot: 0x050810, glow: 0.01 }  // galaxy
  ];

  // 根据 7 层权重插值天空颜色
  function updateSky(alt) {
    if (!skyUniforms) return;
    var w = computeWeights(alt);
    var topR = 0, topG = 0, topB = 0;
    var botR = 0, botG = 0, botB = 0;
    var glow = 0;
    var totalW = 0;
    for (var i = 0; i < w.length; i++) {
      var wi = w[i];
      if (wi <= 0) continue;
      var p = SKY_PRESETS[i];
      topR += ((p.top >> 16) & 0xff) * wi;
      topG += ((p.top >> 8) & 0xff) * wi;
      topB += (p.top & 0xff) * wi;
      botR += ((p.bot >> 16) & 0xff) * wi;
      botG += ((p.bot >> 8) & 0xff) * wi;
      botB += (p.bot & 0xff) * wi;
      glow += p.glow * wi;
      totalW += wi;
    }
    if (totalW > 0.01) {
      skyUniforms.topColor.value.setRGB(topR / 255, topG / 255, topB / 255);
      skyUniforms.bottomColor.value.setRGB(botR / 255, botG / 255, botB / 255);
      skyUniforms.horizonGlow.value = glow;
    }
  }

  // ========== fade 管理工具 ==========
  // registerFade 标记某对象的所有 transparent 材质，让 applyFade 乘以 phase 权重
  function registerFade(obj) {
    obj.traverse(function (o) {
      if (!o.material) return;
      var mats = Array.isArray(o.material) ? o.material : [o.material];
      for (var i = 0; i < mats.length; i++) {
        var m = mats[i];
        if (m.transparent) {
          m.userData.fadeBase = m.opacity;
          m.userData.fadeManaged = true;
        }
      }
    });
  }
  function applyFade(group, w) {
    group.traverse(function (o) {
      if (!o.material) return;
      var mats = Array.isArray(o.material) ? o.material : [o.material];
      for (var i = 0; i < mats.length; i++) {
        var m = mats[i];
        if (m.userData.fadeManaged && !m.userData.fadeManual) {
          m.opacity = m.userData.fadeBase * w;
        }
      }
    });
  }

  // ========== Layer 1: Ground（草地 + 树 + 城市 + 飞机）==========
  function buildGround() {
    var g = new THREE.Group();

    // 草地（大方圆盘）
    var grassMat = new THREE.MeshStandardMaterial({
      color: 0x6ea05a, roughness: 0.95, metalness: 0
    });
    var grass = new THREE.Mesh(new THREE.PlaneGeometry(220, 220, 1, 1), grassMat);
    grass.rotation.x = -Math.PI / 2;
    grass.position.y = -5;
    g.add(grass);

    // 8 棵树，前方散落
    for (var i = 0; i < 8; i++) {
      var tree = makeTree();
      var ang = (i / 8) * Math.PI * 2 + Math.random() * 0.5;
      var radius = 6 + Math.random() * 6;
      tree.position.set(Math.cos(ang) * radius, -5, Math.sin(ang) * radius - 2);
      tree.rotation.y = Math.random() * Math.PI * 2;
      g.add(tree);
    }

    // 远处城市剪影（30 栋 Box，暖色窗灯 emissive）
    for (var i = 0; i < 30; i++) {
      var bw = 1.6 + Math.random() * 1.8;
      var bh = 4 + Math.random() * 8;
      var bd = 1.6 + Math.random() * 1.6;
      var mat = new THREE.MeshStandardMaterial({
        color: 0x3d4a5e, roughness: 0.75,
        emissive: 0xffaa55, emissiveIntensity: 0.05 + Math.random() * 0.05
      });
      var bld = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), mat);
      bld.position.set(-50 + i * 3.2 + Math.random() * 0.8, -5 + bh / 2, -38 - Math.random() * 6);
      g.add(bld);
    }

    // 小飞机（两架不同方向）
    var plane = makeAirplane(false);
    plane.position.set(-35, 4, -25);
    plane.userData.flight = { speed: 1.2, startX: -35, rangeX: 70 };
    g.add(plane);

    var plane2 = makeAirplane(false);
    plane2.position.set(40, 8, -30);
    plane2.scale.setScalar(1.3);
    plane2.userData.flight = { speed: -0.9, startX: 40, rangeX: 60 };
    g.add(plane2);

    layerData.push({
      update: function (dt, w) {
        // 飞机缓慢循环
        g.children.forEach(function (c) {
          if (c.userData.flight) {
            var f = c.userData.flight;
            c.position.x += f.speed * dt;
            if (f.speed > 0 && c.position.x > f.startX + f.rangeX) c.position.x = f.startX;
            if (f.speed < 0 && c.position.x < f.startX - f.rangeX) c.position.x = f.startX;
          }
        });
      }
    });

    return g;
  }

  function makeTree() {
    var g = new THREE.Group();
    var trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.14, 1.2, 8),
      new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 0.95 })
    );
    trunk.position.y = 0.6;
    g.add(trunk);

    var leaves = new THREE.Mesh(
      new THREE.ConeGeometry(0.85, 2.4, 8),
      new THREE.MeshStandardMaterial({ color: 0x4d8a3d, roughness: 0.9 })
    );
    leaves.position.y = 2.2;
    g.add(leaves);

    var leaves2 = new THREE.Mesh(
      new THREE.ConeGeometry(0.65, 1.8, 8),
      new THREE.MeshStandardMaterial({ color: 0x5da14b, roughness: 0.9 })
    );
    leaves2.position.y = 3.0;
    g.add(leaves2);

    return g;
  }

  function makeAirplane(high) {
    var g = new THREE.Group();
    var bodyColor = high ? 0xddeeff : 0xeeeeee;
    var bodyLen = high ? 1.6 : 0.9;
    var body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, bodyLen, 8),
      new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.5, metalness: 0.3 })
    );
    body.rotation.z = Math.PI / 2;
    g.add(body);

    var wing = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, 0.6, 0.18),
      new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.5, metalness: 0.3 })
    );
    g.add(wing);

    var tail = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.2, 0.06),
      new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.5 })
    );
    tail.position.set(bodyLen / 2 - 0.05, 0.06, 0);
    g.add(tail);

    return g;
  }

  // ========== Layer 2: Cloud（14 朵积云）==========
  function buildClouds() {
    var g = new THREE.Group();
    var mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 1.0,
      transparent: true, opacity: 0.92, depthWrite: false
    });

    for (var i = 0; i < 14; i++) {
      var cloud = new THREE.Group();
      var lobes = 5 + Math.floor(Math.random() * 3);
      for (var j = 0; j < lobes; j++) {
        var r = 0.6 + Math.random() * 0.6;
        var sphere = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), mat);
        sphere.position.set(
          (j - lobes / 2) * 0.7,
          Math.random() * 0.25,
          Math.random() * 0.3
        );
        cloud.add(sphere);
      }
      var ang = Math.random() * Math.PI * 2;
      var radius = 4 + Math.random() * 16;
      cloud.position.set(
        Math.cos(ang) * radius,
        12 + Math.random() * 8,
        Math.sin(ang) * radius - 8
      );
      cloud.scale.setScalar(1.3 + Math.random() * 1.5);
      cloud.userData.driftSpeed = 0.10 + Math.random() * 0.15;
      g.add(cloud);
    }
    registerFade(g);

    layerData.push({
      update: function (dt, w) {
        g.children.forEach(function (c) {
          c.position.x += c.userData.driftSpeed * dt;
          if (c.position.x > 28) c.position.x = -28;
        });
      }
    });

    return g;
  }

  // ========== Layer 3: Stratosphere（稀薄云 + 飞机 + 尾迹）==========
  function buildStratosphere() {
    var g = new THREE.Group();

    var matCloud = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 1.0,
      transparent: true, opacity: 0.65, depthWrite: false
    });

    // 稀薄云（8 朵，更大更稀）
    for (var i = 0; i < 8; i++) {
      var cloud = new THREE.Group();
      var lobes = 4 + Math.floor(Math.random() * 2);
      for (var j = 0; j < lobes; j++) {
        var r = 0.8 + Math.random() * 0.6;
        var sphere = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), matCloud);
        sphere.position.set((j - lobes / 2) * 0.9, Math.random() * 0.3, Math.random() * 0.4);
        cloud.add(sphere);
      }
      cloud.position.set(
        -30 + Math.random() * 60,
        30 + Math.random() * 10,
        -22 - Math.random() * 12
      );
      cloud.scale.setScalar(2.2 + Math.random() * 1.8);
      cloud.userData.driftSpeed = 0.2 + Math.random() * 0.2;
      g.add(cloud);
    }

    // 高空飞机
    var plane = makeAirplane(true);
    plane.position.set(-50, 38, -35);
    plane.userData.flight = { speed: 1.5, startX: -50, rangeX: 100 };
    g.add(plane);

    // 尾迹（细长 Plane）
    var trailMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.4, depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    trailMat.userData.fadeManual = true;  // 自己管理 opacity
    var trail = new THREE.Mesh(new THREE.PlaneGeometry(20, 0.06), trailMat);
    trail.rotation.y = Math.PI / 2;
    trail.position.set(-30, 38, -35);
    trail.userData.followPlane = plane;
    g.add(trail);

    registerFade(g);

    layerData.push({
      update: function (dt, w) {
        g.children.forEach(function (c) {
          // 云朵漂移
          if (c.userData.driftSpeed != null) {
            c.position.x += c.userData.driftSpeed * dt;
            if (c.position.x > 30) c.position.x = -50;
          }
          // 飞机飞行
          if (c.userData.flight) {
            var f = c.userData.flight;
            c.position.x += f.speed * dt;
            if (c.position.x - f.startX > f.rangeX) c.position.x = f.startX;
          }
          // 尾迹跟随飞机 + 渐隐
          if (c.userData.followPlane) {
            var p = c.userData.followPlane;
            c.position.x = p.position.x - 10;
            c.position.y = p.position.y;
            c.position.z = p.position.z;
            var t = Math.min(p.position.x / 50, 1);
            c.material.opacity = 0.5 * t * w;
          }
        });
      }
    });

    return g;
  }

  // ========== Layer 4: Space（星空 + 地球 + 大气辉光）==========
  function buildSpace() {
    var g = new THREE.Group();

    // 星空粒子
    var count = MOBILE ? 300 : 600;
    var positions = new Float32Array(count * 3);
    for (var i = 0; i < count; i++) {
      var r = 100 + Math.random() * 100;
      var theta = Math.random() * Math.PI * 2;
      var phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi) + 50;
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    var starGeom = new THREE.BufferGeometry();
    starGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    var starMat = new THREE.PointsMaterial({
      size: 0.55, color: 0xffffff,
      transparent: true, opacity: 0.92,
      sizeAttenuation: true, depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    var stars = new THREE.Points(starGeom, starMat);
    g.add(stars);

    // 地球
    var earth = makeEarth();
    earth.position.set(0, -10, -90);
    g.add(earth);

    // 地球大气辉光（Sprite）
    var glowTex = makeHaloTex(0x88bbff);
    var glowMat = new THREE.SpriteMaterial({
      map: glowTex, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    glowMat.userData.fadeManual = true;
    var earthGlow = new THREE.Sprite(glowMat);
    earthGlow.scale.setScalar(78);
    earthGlow.position.copy(earth.position);
    g.add(earthGlow);

    layerData.push({
      update: function (dt, w) {
        stars.rotation.y += dt * 0.005;
        earth.rotation.y += dt * 0.03;
        earthGlow.material.opacity = 0.55 * w;
      }
    });

    return g;
  }

  function makeEarth() {
    var tex = makeCanvas(512, 512, function (ctx, w, h) {
      // 海洋
      ctx.fillStyle = '#3a72b8';
      ctx.fillRect(0, 0, w, h);
      // 大陆（绿色块）
      ctx.fillStyle = '#4a8a55';
      for (var i = 0; i < 28; i++) {
        var x = Math.random() * w, y = Math.random() * h;
        var r = 30 + Math.random() * 60;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
      // 沙漠（棕黄）
      ctx.fillStyle = '#c8a766';
      for (var i = 0; i < 14; i++) {
        var x = Math.random() * w, y = Math.random() * h;
        var r = 18 + Math.random() * 30;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
      // 极地
      ctx.fillStyle = '#e8e8e8';
      ctx.fillRect(0, 0, w, 28);
      ctx.fillRect(0, h - 28, w, 28);
      // 云
      ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
      for (var i = 0; i < 18; i++) {
        var x = Math.random() * w, y = Math.random() * h;
        var r = 25 + Math.random() * 50;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
    });
    var geom = new THREE.SphereGeometry(28, 48, 36);
    return new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
      map: tex, roughness: 0.7, metalness: 0.05
    }));
  }

  // ========== Layer 5: Planets（火星 / 土星 / 木星）==========
  function buildPlanets() {
    var g = new THREE.Group();

    // 火星（红球+暗斑）
    var marsTex = makeCanvas(256, 128, function (ctx, w, h) {
      ctx.fillStyle = '#c1440e';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(60, 30, 10, 0.5)';
      for (var i = 0; i < 35; i++) {
        var x = Math.random() * w, y = Math.random() * h;
        var r = 4 + Math.random() * 18;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
      // 极地冰盖
      ctx.fillStyle = 'rgba(230, 220, 200, 0.6)';
      ctx.fillRect(0, 0, w, 10);
      ctx.fillRect(0, h - 10, w, 10);
    });
    var mars = new THREE.Mesh(
      new THREE.SphereGeometry(2.2, 32, 24),
      new THREE.MeshStandardMaterial({
        map: marsTex, roughness: 0.85, metalness: 0.02,
        emissive: 0xc1440e, emissiveIntensity: 0.05
      })
    );
    mars.position.set(-22, 62, -55);
    mars.userData.spin = 0.04;
    g.add(mars);

    // 土星（带环）
    var saturn = makeSaturn();
    saturn.position.set(28, 75, -65);
    saturn.userData.spin = 0.025;
    g.add(saturn);

    // 木星（橙球+横纹+大红斑）
    var jupTex = makeCanvas(256, 128, function (ctx, w, h) {
      ctx.fillStyle = '#d6a05a';
      ctx.fillRect(0, 0, w, h);
      var bands = ['#e8c890', '#c08850', '#b07040', '#e0b888', '#a86838'];
      for (var i = 0; i < 10; i++) {
        ctx.fillStyle = bands[i % bands.length];
        var y = (i / 10) * h;
        var bh = (h / 10) * (0.7 + Math.random() * 0.4);
        ctx.fillRect(0, y, w, bh);
      }
      // 大红斑
      ctx.fillStyle = 'rgba(170, 60, 30, 0.85)';
      ctx.beginPath();
      ctx.ellipse(w * 0.7, h * 0.6, 22, 10, 0, 0, Math.PI * 2);
      ctx.fill();
    });
    var jupiter = new THREE.Mesh(
      new THREE.SphereGeometry(3.4, 32, 24),
      new THREE.MeshStandardMaterial({
        map: jupTex, roughness: 0.75, metalness: 0.05
      })
    );
    jupiter.position.set(0, 58, -75);
    jupiter.userData.spin = 0.05;
    g.add(jupiter);

    layerData.push({
      update: function (dt, w) {
        g.children.forEach(function (c) {
          if (c.userData.spin != null) c.rotation.y += c.userData.spin * dt;
        });
      }
    });

    return g;
  }

  function makeSaturn() {
    var g = new THREE.Group();

    // 本体
    var satTex = makeCanvas(256, 128, function (ctx, w, h) {
      ctx.fillStyle = '#d8b27a';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(180, 130, 70, 0.4)';
      for (var i = 0; i < 8; i++) {
        var y = (i / 8) * h;
        ctx.fillRect(0, y, w, 4);
      }
    });
    var planet = new THREE.Mesh(
      new THREE.SphereGeometry(2.6, 32, 24),
      new THREE.MeshStandardMaterial({
        map: satTex, roughness: 0.75, metalness: 0.05
      })
    );
    g.add(planet);

    // 土星环（RingGeometry）
    var ringTex = makeCanvas(256, 16, function (ctx, w, h) {
      ctx.fillStyle = 'rgba(220, 180, 120, 0.9)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(140, 100, 50, 0.5)';
      ctx.fillRect(0, 4, w, 2);
      ctx.fillRect(0, 10, w, 1);
    });
    var ringGeom = new THREE.RingGeometry(3.5, 5.2, 64);
    var ring = new THREE.Mesh(
      ringGeom,
      new THREE.MeshBasicMaterial({
        map: ringTex, side: THREE.DoubleSide,
        transparent: true, opacity: 0.85, depthWrite: false
      })
    );
    ring.rotation.x = Math.PI / 2 - 0.35;
    g.add(ring);

    return g;
  }

  // ========== Layer 6: Moon（月球 + 光晕 + 月光）==========
  function buildMoon() {
    var g = new THREE.Group();

    var moonTex = makeCanvas(512, 512, function (ctx, w, h) {
      ctx.fillStyle = '#e8e4da';
      ctx.fillRect(0, 0, w, h);
      // 月海（暗斑）
      ctx.fillStyle = 'rgba(80, 75, 70, 0.30)';
      for (var i = 0; i < 10; i++) {
        ctx.beginPath();
        ctx.ellipse(
          Math.random() * w, Math.random() * h,
          25 + Math.random() * 45,
          18 + Math.random() * 30,
          Math.random() * Math.PI,
          0, Math.PI * 2
        );
        ctx.fill();
      }
      // 环形山（暗+亮边）
      for (var i = 0; i < 60; i++) {
        var x = Math.random() * w, y = Math.random() * h;
        var r = 5 + Math.random() * 22;
        ctx.fillStyle = 'rgba(80, 70, 60, 0.25)';
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(255, 240, 215, 0.45)';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
      }
    });

    var moonGeom = new THREE.SphereGeometry(8, 64, 48);
    var moonMat = new THREE.MeshStandardMaterial({
      map: moonTex, color: 0xe8e4da,
      roughness: 0.85, metalness: 0.02,
      emissive: 0xffefd0, emissiveIntensity: 0.0,
      transparent: true, opacity: 1.0
    });
    moonMat.userData.fadeManual = true;
    var moon = new THREE.Mesh(moonGeom, moonMat);
    g.add(moon);

    // 光晕 Sprite
    var haloTex = makeHaloTex(0xffeac0);
    var haloMat = new THREE.SpriteMaterial({
      map: haloTex, color: 0xffeac0,
      transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    haloMat.userData.fadeManual = true;
    var halo = new THREE.Sprite(haloMat);
    halo.scale.setScalar(30);
    g.add(halo);

    // 月光 PointLight（弱光，营造信笺氛围）
    var moonLight = new THREE.PointLight(0xfff0d0, 0, 80, 1.2);
    g.add(moonLight);

    g.userData.moon = moon;
    g.userData.halo = halo;
    g.userData.moonLight = moonLight;

    layerData.push({
      update: function (dt, w) {
        var moon = g.userData.moon;
        var halo = g.userData.halo;
        var moonLight = g.userData.moonLight;

        // 月亮固定位置（远处）
        moon.position.set(0, 90, -45);
        halo.position.copy(moon.position);

        // 接近阶段（altitude 0.85→1.0，月亮视觉上变大变亮）
        var approach = BG.smoothstep(0.85, 1.0, BG.S.altitude);
        var scale = BG.lerp(0.5, 3.0, approach);
        moon.scale.setScalar(scale);
        halo.scale.setScalar(BG.lerp(25, 70, approach));

        // 穿过月亮后淡出（altitude 1.05→1.18）
        var fadeOut = 1 - BG.smoothstep(1.05, 1.18, BG.S.altitude);

        moon.material.emissiveIntensity = BG.lerp(0.0, 0.55, approach) * w;
        moon.material.opacity = w * fadeOut;
        halo.material.opacity = BG.lerp(0.0, 0.75, approach) * w * fadeOut;
        moonLight.intensity = BG.lerp(0, 1.8, approach) * w * fadeOut;
      }
    });

    return g;
  }

  // ========== Layer 7: Galaxy（银河螺旋盘 + 星云 + 远景亮星）==========
  function buildGalaxy() {
    var g = new THREE.Group();

    // 银河螺旋粒子
    var count = MOBILE ? 800 : 1500;
    var positions = new Float32Array(count * 3);
    var colors = new Float32Array(count * 3);
    var arms = 4;

    for (var i = 0; i < count; i++) {
      var armIdx = i % arms;
      var dist = Math.pow(Math.random(), 0.6) * 55;
      var angle = armIdx * (Math.PI * 2 / arms) + dist * 0.18 + (Math.random() - 0.5) * 0.4;
      var y = (Math.random() - 0.5) * (3 + dist * 0.08);

      positions[i * 3]     = Math.cos(angle) * dist;
      positions[i * 3 + 1] = y + 130;
      positions[i * 3 + 2] = Math.sin(angle) * dist - 15;

      // 中心暖白 → 边缘冷蓝紫
      var t = Math.min(dist / 55, 1);
      colors[i * 3]     = BG.lerp(1.0, 0.55, t);
      colors[i * 3 + 1] = BG.lerp(0.92, 0.55, t);
      colors[i * 3 + 2] = BG.lerp(0.75, 0.95, t);
    }

    var galGeom = new THREE.BufferGeometry();
    galGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    galGeom.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    var galMat = new THREE.PointsMaterial({
      size: 0.7, vertexColors: true,
      transparent: true, opacity: 0.92,
      sizeAttenuation: true, depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    var galaxy = new THREE.Points(galGeom, galMat);
    galaxy.rotation.x = Math.PI / 6;
    g.add(galaxy);

    // 星云色斑（4 个不同颜色）
    var nebulaColors = [0xa080ff, 0xff8a8a, 0x80c0ff, 0xffc080];
    for (var i = 0; i < 4; i++) {
      var nebTex = makeHaloTex(nebulaColors[i]);
      var nebMat = new THREE.SpriteMaterial({
        map: nebTex, transparent: true, opacity: 0.35,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
      nebMat.userData.fadeManual = true;
      var neb = new THREE.Sprite(nebMat);
      neb.scale.setScalar(70 + Math.random() * 50);
      neb.position.set(
        (Math.random() - 0.5) * 80,
        125 + (Math.random() - 0.5) * 30,
        -25 - Math.random() * 30
      );
      g.add(neb);
    }

    // 远景亮星（少量大尺寸）
    var farCount = MOBILE ? 80 : 150;
    var farPos = new Float32Array(farCount * 3);
    var farCol = new Float32Array(farCount * 3);
    for (var i = 0; i < farCount; i++) {
      var r = 200 + Math.random() * 100;
      var theta = Math.random() * Math.PI * 2;
      var phi = Math.acos(2 * Math.random() - 1);
      farPos[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
      farPos[i * 3 + 1] = r * Math.cos(phi) + 130;
      farPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
      farCol[i * 3]     = 0.9 + Math.random() * 0.1;
      farCol[i * 3 + 1] = 0.9 + Math.random() * 0.1;
      farCol[i * 3 + 2] = 0.95;
    }
    var farGeom = new THREE.BufferGeometry();
    farGeom.setAttribute('position', new THREE.BufferAttribute(farPos, 3));
    farGeom.setAttribute('color', new THREE.BufferAttribute(farCol, 3));
    var farMat = new THREE.PointsMaterial({
      size: 1.0, vertexColors: true,
      transparent: true, opacity: 0.85,
      sizeAttenuation: true, depthWrite: false
    });
    farMat.userData.fadeManual = true;
    g.add(new THREE.Points(farGeom, farMat));

    // 让未手动管理的 transparent 材质（如 galaxy 螺旋盘）走 applyFade
    registerFade(g);

    layerData.push({
      update: function (dt, w) {
        galaxy.rotation.z += dt * 0.01;  // 银河缓慢自转
        // 星云和远景星乘以 phase 权重
        g.children.forEach(function (c) {
          if (c.material && c.material.userData && c.material.userData.fadeManual) {
            // 仅对原本就有 opacity 的材质（避免把 opacity=1 的覆写成 0）
            if (c.material.opacity > 0 || c.userData._wasVisible) {
              c.material.opacity = c.userData._baseOp * w;
            }
          }
        });
      }
    });

    // 记录 base opacity 便于 update 计算
    g.children.forEach(function (c) {
      if (c.material && c.material.userData && c.material.userData.fadeManual) {
        c.userData._baseOp = c.material.opacity;
        c.userData._wasVisible = true;
      }
    });

    return g;
  }

  // ========== 初始化 ==========
  function init() {
    if (initialized) return;
    initialized = true;

    var sceneMod = BG.getModule('scene');
    var scene = sceneMod && sceneMod.getScene();
    if (!scene) { console.error('[world] scene 未就绪'); return; }

    // 天空（直接挂 scene，独立于 root，不跟随竹蜻蜓）
    scene.add(buildSky());

    // 7 层根 group
    root = new THREE.Group();
    scene.add(root);

    layerGroups = [
      buildGround(),       // 0 ground
      buildClouds(),       // 1 cloud
      buildStratosphere(), // 2 strato
      buildSpace(),        // 3 space
      buildPlanets(),      // 4 planets
      buildMoon(),         // 5 moon
      buildGalaxy()        // 6 galaxy
    ];

    layerGroups.forEach(function (lg) {
      root.add(lg);
    });
  }

  // ========== 每帧更新 ==========
  function update(dt) {
    if (!initialized) return;

    var alt = BG.S.altitude || 0;
    var w = computeWeights(alt);

    // 天空
    updateSky(alt);

    // 7 层
    for (var i = 0; i < layerGroups.length; i++) {
      var lg = layerGroups[i];
      var wi = w[i] || 0;

      // visibility 硬切换（weight 太低时直接隐藏，省渲染开销）
      lg.visible = wi > 0.02;

      // 自动 fade managed 透明材质
      if (lg.visible) applyFade(lg, wi);

      // 自定义 update（动态行为）
      var ld = layerData[i];
      if (ld && ld.update) ld.update(dt, wi);
    }
  }

  BG.register('world', {
    init: init,
    update: update
  });
})();