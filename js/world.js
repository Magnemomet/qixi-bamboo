/* ============================================================
 * world.js — 13 层背景世界（严格对齐 game.js PHASES 表）
 *
 * 视觉驱动：S.altitude（0~1.2，ALTITUDE_MAX=1.2）
 *   0  ground        草地 + 草尖粒子 + 小花 + 灌木 + 远处树海
 *   1  tree          高大乔木阵（粗干 + 4 层树冠 + 树枝 + 落叶粒子）
 *   2  building      50 栋高耸楼群（亮窗暖光 + 楼顶设备 + 闪烁警示灯）
 *   3  rooftop       楼顶平台阵列 + 栏杆 + 远处小飞机 + 低空薄云
 *   4  cloud         云海大平面（贴图）+ 云朵精灵（贴图）+ 少量球体云
 *   5  plane         大型民航飞机（机翼/引擎/尾翼）+ 长尾迹 + 平流层稀云
 *   6  nearspace     大地球（earth_daymap.webp 贴图）+ 大气辉光
 *   7  orbit         卫星 + 空间站 + 远处小地球（视觉渐小）
 *   8  moon          三档接近感月球（moon.webp 贴图）+ halo + 信笺弱光
 *   9  mars          火星（mars.webp 贴图）+ 远处太阳（sun.webp 贴图，emissive）
 *  10  planets       土星（saturn.webp + saturn_ring.png 贴图）+ 木星（jupiter.webp）
 *  11  solaredge     柯伊伯带冰粒子（冷白蓝）+ 少量多面体冰块
 *  12  galaxy        银河螺旋盘 + 4 色星云 + 远景亮星
 *  + 独立远景星空 group（alt > 0.45 渐显，贯穿所有太空阶段）
 *
 * 架构沿用：
 *   - 13 层 smoothstep 交叉淡化（computeWeights）→ 同一根 altitude 上多钟形峰
 *   - registerFade / applyFade：transparent 材质自动乘 phase 权重
 *   - userData.fadeManaged（自动）/ fadeManual（自管）二元约定
 *   - 天空 ShaderMaterial 按 13 层权重插值色板
 *
 * 贴图加载（2026-08-18 升级）：
 *   - 异步 TextureLoader + 贴图缓存（texCache）
 *   - 首帧用程序化 fallback（makeCanvas）占位，加载完成后替换 image
 *   - 加载失败静默降级到 fallback（不抛错）
 *
 * 性能：粒子总数 ≤ 5000；移动端降级（粒子减半、无阴影）
 *
 * 接口：{init(), update(dt)}
 * scene.js 无需改动（竹蜻蜓 y = altitude*80，相机固定视角跟随不变）
 * ============================================================ */
(function () {
  'use strict';

  var THREE = window.THREE;
  var BG = window.BambooGame;
  if (!THREE) { console.error('[world] THREE 未加载'); return; }

  // ========== 内部状态 ==========
  var root;                // 根 Group（13 层 + 独立星空都挂这下面）
  var layerGroups = [];    // 13 层 group，索引对齐 PHASES
  var layerData = [];      // 每层 update 函数
  var starfieldGroup;      // 远景星空（独立 group，独立 fade）
  var starfieldMat;        // 星空 PointsMaterial（直接控制 opacity）
  var skyUniforms;         // 天空 shader uniforms
  var texCache = {};       // 贴图缓存：key -> THREE.Texture（先 fallback 后 image 替换）
  var initialized = false;

  // 移动端检测（Android UA 或窄屏）
  var MOBILE = /Android/i.test(navigator.userAgent || '') || window.innerWidth <= 640;

  // ========== 权重计算：13 层 smoothstep 交叉淡化 ==========
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

  // ========== CanvasTexture 通用工具 ==========
  function makeCanvas(w, h, drawFn) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    drawFn(c.getContext('2d'), w, h);
    var tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // 径向渐变光晕纹理（用于 moon halo、大气辉光、星云）
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

  // ========== 贴图加载：异步 TextureLoader + 占位 fallback ==========
  // 用法：
  //   1. buildXxx 内 getOrCreateTex(key, fallbackFn) → 立即拿到 Texture（fallback）
  //   2. init() 末尾 preloadTextures() → 异步加载所有真实贴图，加载完后
  //      替换 texCache[key].image 并 needsUpdate，所有引用同一 Texture 的
  //      材质下一次渲染自动使用新图，无需逐个 material 升级
  // 加载失败时静默降级（保留 fallback）
  var texLoader = new THREE.TextureLoader();

  function getOrCreateTex(key, fallbackFn) {
    if (texCache[key]) return texCache[key];
    var tex = fallbackFn ? fallbackFn() : new THREE.Texture();
    texCache[key] = tex;
    return tex;
  }

  function upgradeTexImage(key, loadedTex) {
    var tex = texCache[key];
    if (!tex) return;
    loadedTex.colorSpace = THREE.SRGBColorSpace;
    tex.image = loadedTex.image;
    tex.needsUpdate = true;
    // 贴图属性同步：顺带复制有用的设置
    tex.wrapS = loadedTex.wrapS;
    tex.wrapT = loadedTex.wrapT;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
  }

  function loadTexture(key, path) {
    if (!texCache[key]) {
      // 未注册占位的 key 直接跳过（不应该发生）
      console.warn('[world] loadTexture: 未注册的 key', key);
      return;
    }
    texLoader.load(
      path,
      function (loadedTex) { upgradeTexImage(key, loadedTex); },
      undefined,
      function () { /* 加载失败静默降级到 fallback */ }
    );
  }

  // 启动时一次性预加载所有素材贴图（路径相对 index.html）
  function preloadTextures() {
    // 行星 / 卫星 / 太阳
    loadTexture('earth',      'assets/textures/earth_daymap.webp');
    loadTexture('moon',       'assets/textures/moon.webp');
    loadTexture('mars',       'assets/textures/mars.webp');
    loadTexture('jupiter',    'assets/textures/jupiter.webp');
    loadTexture('saturn',     'assets/textures/saturn.webp');
    loadTexture('saturn_ring','assets/textures/saturn_ring.png');
    loadTexture('sun',        'assets/textures/sun.webp');
    // 云海素材
    loadTexture('cloud_sea',  'assets/textures/cloud-sea.webp');
    loadTexture('cloud_a',    'assets/textures/cloud-a.png');
    loadTexture('cloud_b',    'assets/textures/cloud-b.png');
  }

  // ========== 天空穹顶（ShaderMaterial 自定义渐变）==========
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

  // ========== 13 层天空色板（与 PHASES 一一对应）==========
  // 梯度：海蓝晚霞 → 偏粉晚霞 → 平流层深蓝 → 太空深蓝 → 太空黑蓝 → 冷黑 → 深黑微紫
  var SKY_PRESETS = [
    { top: 0x6fb5e6, bot: 0xffd49a, glow: 0.40 }, //  0 ground       海蓝+晚霞
    { top: 0x82bce0, bot: 0xffe2b3, glow: 0.32 }, //  1 tree         略提亮
    { top: 0x93c4e0, bot: 0xffdcb0, glow: 0.28 }, //  2 building     城际暖光
    { top: 0xa0cae0, bot: 0xfed4a8, glow: 0.22 }, //  3 rooftop      楼顶晚霞
    { top: 0x9ec5e6, bot: 0xffe2b3, glow: 0.18 }, //  4 cloud        积云带
    { top: 0x3f6195, bot: 0x86afd4, glow: 0.10 }, //  5 plane        平流层深蓝
    { top: 0x152040, bot: 0x2a4a7a, glow: 0.04 }, //  6 nearspace    深蓝黑
    { top: 0x0e1a35, bot: 0x213a60, glow: 0.02 }, //  7 orbit        近黑深蓝
    { top: 0x0a142a, bot: 0x182844, glow: 0.03 }, //  8 moon         信笺微辉
    { top: 0x081020, bot: 0x132036, glow: 0.02 }, //  9 mars         太空黑蓝
    { top: 0x050b18, bot: 0x0e1828, glow: 0.02 }, // 10 planets      太空黑
    { top: 0x030610, bot: 0x0a1020, glow: 0.015 },// 11 solaredge    冷黑
    { top: 0x000005, bot: 0x050810, glow: 0.01 }  // 12 galaxy       深黑微紫
  ];

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

  // ========== 远景星空（独立 group，不参与 phase weight）==========
  // nearspace 起就常驻可见，保证从近地太空到银河尽头都有星点
  function buildStarfield() {
    var g = new THREE.Group();
    var count = MOBILE ? 300 : 600;
    var positions = new Float32Array(count * 3);
    var colors = new Float32Array(count * 3);
    for (var i = 0; i < count; i++) {
      var r = 120 + Math.random() * 100;
      var theta = Math.random() * Math.PI * 2;
      var phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi) + 60;
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
      // 微微偏冷白（接近真实星色）
      var c = 0.82 + Math.random() * 0.18;
      var t = Math.random();
      colors[i * 3]     = c * (1 - t * 0.12);
      colors[i * 3 + 1] = c * (1 - t * 0.06);
      colors[i * 3 + 2] = c;
    }
    var geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    starfieldMat = new THREE.PointsMaterial({
      size: 0.55, vertexColors: true,
      transparent: true, opacity: 0,
      sizeAttenuation: true, depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    starfieldMat.userData.fadeManual = true;
    var stars = new THREE.Points(geom, starfieldMat);
    g.add(stars);
    g.userData.starfield = stars;
    return g;
  }
  function updateStarfield(alt) {
    if (!starfieldMat) return;
    // alt < 0.45 隐藏；0.45~0.55 渐显；> 0.55 全亮；进入 galaxy 后更亮
    var opacity = BG.smoothstep(0.45, 0.55, alt) * 0.92;
    if (alt > 1.0) opacity = Math.min(1.0, opacity + (alt - 1.0) * 0.5);
    starfieldMat.opacity = opacity;
    if (starfieldGroup && starfieldGroup.userData.starfield) {
      starfieldGroup.userData.starfield.rotation.y += 0.0008;
    }
  }

  // ============================================================
  // Layer 0: ground (0~0.04) — 草地 + 草尖粒子 + 小花 + 灌木
  // 竹蜻蜓刚离手的高度，镜头极低，强调"掠过草尖"
  // ============================================================
  function buildGround() {
    var g = new THREE.Group();

    // 草地大方圆盘
    var grassMat = new THREE.MeshStandardMaterial({
      color: 0x6ea05a, roughness: 0.95, metalness: 0
    });
    var grass = new THREE.Mesh(new THREE.PlaneGeometry(300, 300, 1, 1), grassMat);
    grass.rotation.x = -Math.PI / 2;
    grass.position.y = -8;
    g.add(grass);

    // 泥土色边缘（远处更暖）
    var dirtMat = new THREE.MeshStandardMaterial({
      color: 0x8a6a3a, roughness: 0.95, metalness: 0
    });
    var dirt = new THREE.Mesh(new THREE.RingGeometry(60, 150, 32), dirtMat);
    dirt.rotation.x = -Math.PI / 2;
    dirt.position.y = -7.95;
    g.add(dirt);

    // 低草尖粒子（掠过感关键）
    var grassCount = MOBILE ? 40 : 80;
    var grassPos = new Float32Array(grassCount * 3);
    for (var i = 0; i < grassCount; i++) {
      var ang = Math.random() * Math.PI * 2;
      var radius = 2 + Math.random() * 18;
      grassPos[i * 3]     = Math.cos(ang) * radius;
      grassPos[i * 3 + 1] = -7.4 + Math.random() * 0.6;
      grassPos[i * 3 + 2] = Math.sin(ang) * radius;
    }
    var grassGeom = new THREE.BufferGeometry();
    grassGeom.setAttribute('position', new THREE.BufferAttribute(grassPos, 3));
    var grassTipMat = new THREE.PointsMaterial({
      size: 0.35, color: 0x9ec76a,
      transparent: true, opacity: 0.85,
      sizeAttenuation: true, depthWrite: false
    });
    grassTipMat.userData.fadeManual = true;
    var grassTips = new THREE.Points(grassGeom, grassTipMat);
    g.add(grassTips);

    // 小花（红/黄/白/橙四色随机）
    var flowerCount = MOBILE ? 12 : 24;
    var flowerColors = [0xff6b8a, 0xffd86b, 0xffffff, 0xff8c5a];
    var flowerPos = new Float32Array(flowerCount * 3);
    var flowerCol = new Float32Array(flowerCount * 3);
    for (var i = 0; i < flowerCount; i++) {
      var ang = Math.random() * Math.PI * 2;
      var radius = 3 + Math.random() * 12;
      flowerPos[i * 3]     = Math.cos(ang) * radius;
      flowerPos[i * 3 + 1] = -7.3;
      flowerPos[i * 3 + 2] = Math.sin(ang) * radius;
      var c = new THREE.Color(flowerColors[i % flowerColors.length]);
      flowerCol[i * 3]     = c.r;
      flowerCol[i * 3 + 1] = c.g;
      flowerCol[i * 3 + 2] = c.b;
    }
    var flowerGeom = new THREE.BufferGeometry();
    flowerGeom.setAttribute('position', new THREE.BufferAttribute(flowerPos, 3));
    flowerGeom.setAttribute('color', new THREE.BufferAttribute(flowerCol, 3));
    var flowerMat = new THREE.PointsMaterial({
      size: 0.5, vertexColors: true,
      transparent: true, opacity: 0.95,
      sizeAttenuation: true, depthWrite: false
    });
    flowerMat.userData.fadeManual = true;
    var flowers = new THREE.Points(flowerGeom, flowerMat);
    g.add(flowers);

    // 5 棵低矮灌木（前/中景）
    for (var i = 0; i < 5; i++) {
      var bush = makeBush();
      var ang = (i / 5) * Math.PI * 2 + Math.random() * 0.5;
      var radius = 5 + Math.random() * 5;
      bush.position.set(Math.cos(ang) * radius, -7.8, Math.sin(ang) * radius - 1);
      bush.rotation.y = Math.random() * Math.PI * 2;
      g.add(bush);
    }

    // 远处树海背景（深绿，远景模糊感）
    var bgForestMat = new THREE.MeshStandardMaterial({
      color: 0x3d6a3a, roughness: 1.0, metalness: 0
    });
    var bgForest = new THREE.Mesh(new THREE.PlaneGeometry(220, 14), bgForestMat);
    bgForest.position.set(0, -1, -90);
    g.add(bgForest);

    g.userData.grassTipBase = grassTipMat.opacity;
    g.userData.flowerBase = flowerMat.opacity;

    layerData.push({
      update: function (dt, w) {
        // 草尖和小花随风微旋
        var t = performance.now() * 0.001;
        grassTips.rotation.y = t * 0.05;
        flowers.rotation.y = -t * 0.03;
        grassTipMat.opacity = g.userData.grassTipBase * w;
        flowerMat.opacity = g.userData.flowerBase * w;
      }
    });

    return g;
  }

  function makeBush() {
    var g = new THREE.Group();
    var bushMat = new THREE.MeshStandardMaterial({ color: 0x4d7a3a, roughness: 0.9 });
    for (var i = 0; i < 5; i++) {
      var r = 0.4 + Math.random() * 0.3;
      var blob = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), bushMat);
      blob.position.set(
        (Math.random() - 0.5) * 0.8,
        r * 0.6,
        (Math.random() - 0.5) * 0.8
      );
      g.add(blob);
    }
    return g;
  }

  // ============================================================
  // Layer 1: tree (0.04~0.08) — 高大乔木阵
  // 4 层树冠分层、树枝细节、落叶飘落粒子
  // ============================================================
  function buildTree() {
    var g = new THREE.Group();

    // 6 棵高大乔木，前方扇形分布（穿行感）
    for (var i = 0; i < 6; i++) {
      var tree = makeTallTree();
      var ang = -0.8 + (i / 5) * 1.6 + (Math.random() - 0.5) * 0.3;
      var radius = 8 + Math.random() * 6;
      tree.position.set(
        Math.cos(ang) * radius,
        -5,
        Math.sin(ang) * radius - 2
      );
      tree.rotation.y = Math.random() * Math.PI * 2;
      g.add(tree);
    }

    // 远处树海（更深绿色调）
    var forestMat = new THREE.MeshStandardMaterial({
      color: 0x2a5a32, roughness: 1.0
    });
    for (var i = 0; i < 3; i++) {
      var forest = new THREE.Mesh(new THREE.PlaneGeometry(200, 20), forestMat);
      forest.position.set((Math.random() - 0.5) * 25, -2, -95 - i * 5);
      g.add(forest);
    }

    // 飘落叶片粒子（带颜色分层）
    var leafCount = MOBILE ? 30 : 60;
    var leafPos = new Float32Array(leafCount * 3);
    var leafCol = new Float32Array(leafCount * 3);
    for (var i = 0; i < leafCount; i++) {
      leafPos[i * 3]     = (Math.random() - 0.5) * 30;
      leafPos[i * 3 + 1] = -2 + Math.random() * 22;
      leafPos[i * 3 + 2] = -5 + (Math.random() - 0.5) * 20;
      var green = 0.35 + Math.random() * 0.35;
      leafCol[i * 3]     = 0.15 + Math.random() * 0.15;
      leafCol[i * 3 + 1] = green;
      leafCol[i * 3 + 2] = 0.08 + Math.random() * 0.12;
    }
    var leafGeom = new THREE.BufferGeometry();
    leafGeom.setAttribute('position', new THREE.BufferAttribute(leafPos, 3));
    leafGeom.setAttribute('color', new THREE.BufferAttribute(leafCol, 3));
    var leafMat = new THREE.PointsMaterial({
      size: 0.25, vertexColors: true,
      transparent: true, opacity: 0.75,
      sizeAttenuation: true, depthWrite: false
    });
    leafMat.userData.fadeManual = true;
    var leaves = new THREE.Points(leafGeom, leafMat);
    leaves.userData.leafCount = leafCount;
    g.add(leaves);

    g.userData.leafBase = leafMat.opacity;

    layerData.push({
      update: function (dt, w) {
        var arr = leaves.geometry.attributes.position.array;
        var n = leaves.userData.leafCount;
        for (var i = 0; i < n; i++) {
          arr[i * 3 + 1] -= dt * (0.6 + (i % 5) * 0.1);
          arr[i * 3] += dt * 0.15 * ((i % 3) - 1);
          if (arr[i * 3 + 1] < -3) {
            arr[i * 3 + 1] = 20;
            arr[i * 3] = (Math.random() - 0.5) * 30;
            arr[i * 3 + 2] = -5 + (Math.random() - 0.5) * 20;
          }
        }
        leaves.geometry.attributes.position.needsUpdate = true;
        leafMat.opacity = g.userData.leafBase * w;
      }
    });

    return g;
  }

  function makeTallTree() {
    var g = new THREE.Group();

    // 主干（粗壮，高 9）
    var trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.55, 9, 10),
      new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 0.95 })
    );
    trunk.position.y = 4.5;
    g.add(trunk);

    // 4 层树冠（深→浅绿分层）
    var colors = [0x3a6a2a, 0x4d8a3d, 0x5da14b, 0x6db85a];
    var yPos = [4.8, 6.8, 8.5, 10.0];
    var radii = [2.4, 2.0, 1.5, 0.9];
    var coneHs = [2.5, 2.2, 2.0, 1.6];
    for (var i = 0; i < 4; i++) {
      var cone = new THREE.Mesh(
        new THREE.ConeGeometry(radii[i], coneHs[i], 8),
        new THREE.MeshStandardMaterial({ color: colors[i], roughness: 0.9 })
      );
      cone.position.y = yPos[i];
      g.add(cone);
    }

    // 4 根向外伸出的树枝
    var branchY = [5.0, 6.5, 7.5, 8.5];
    var branchMat = new THREE.MeshStandardMaterial({ color: 0x7a5a3c, roughness: 0.95 });
    for (var i = 0; i < 4; i++) {
      var ang = (i / 4) * Math.PI * 2;
      var branch = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.1, 1.8, 6),
        branchMat
      );
      branch.rotation.z = Math.PI / 2 * 0.7;
      branch.rotation.y = ang;
      branch.position.y = branchY[i];
      branch.position.x = Math.cos(ang) * 0.5;
      branch.position.z = Math.sin(ang) * 0.5;
      g.add(branch);
    }

    return g;
  }

  // ============================================================
  // Layer 2: building (0.08~0.12) — 50 栋高耸楼群
  // "从楼群中间穿过"观感：楼高 12-30，楼顶设备，闪烁警示灯
  // ============================================================
  function buildBuilding() {
    var g = new THREE.Group();

    var baseTint = new THREE.Color(0x3d4a5e);
    var lightTint = new THREE.Color(0x6878a0);

    for (var i = 0; i < 50; i++) {
      var bw = 2 + Math.random() * 2.5;
      var bh = 12 + Math.random() * 18;  // 12~30 高（更夸张）
      var bd = 2 + Math.random() * 2.5;

      var tint = baseTint.clone().lerp(lightTint, Math.random() * 0.5);
      var mat = new THREE.MeshStandardMaterial({
        color: tint, roughness: 0.75,
        emissive: 0xffaa55, emissiveIntensity: 0.03 + Math.random() * 0.04
      });

      var bld = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), mat);
      // 前后两排交错
      var row = i % 2;
      var col = Math.floor(i / 2);
      bld.position.set(
        -55 + col * 4.2 + Math.random() * 0.8,
        -5 + bh / 2,
        row === 0 ? -42 - Math.random() * 8 : -50 - Math.random() * 6
      );
      g.add(bld);

      // 楼顶设备箱
      if (Math.random() > 0.4) {
        var topBox = new THREE.Mesh(
          new THREE.BoxGeometry(bw * 0.4, 1 + Math.random() * 1.5, bd * 0.4),
          new THREE.MeshStandardMaterial({ color: 0x555a66, roughness: 0.8 })
        );
        topBox.position.copy(bld.position);
        topBox.position.y = -5 + bh + (1 + Math.random() * 1.5) / 2;
        g.add(topBox);
      }
    }

    // 楼间街道（远景地面条带）
    var streetMat = new THREE.MeshStandardMaterial({
      color: 0x2a2c30, roughness: 0.95
    });
    var street = new THREE.Mesh(new THREE.PlaneGeometry(140, 2), streetMat);
    street.rotation.x = -Math.PI / 2;
    street.position.set(0, -4.9, -45);
    g.add(street);

    // 楼顶警示灯（红色闪烁）
    var warnMat = new THREE.MeshBasicMaterial({
      color: 0xff3322, transparent: true, opacity: 0.9
    });
    warnMat.userData.fadeManual = true;
    var warnLights = [];
    for (var i = 0; i < 6; i++) {
      var warn = new THREE.Mesh(new THREE.SphereGeometry(0.22, 6, 4), warnMat);
      warn.position.set(-40 + i * 15, -5 + 30 + Math.random() * 4, -45 - Math.random() * 4);
      warn.userData.blinkPhase = Math.random() * Math.PI * 2;
      g.add(warn);
      warnLights.push(warn);
    }

    g.userData.warnBase = warnMat.opacity;

    layerData.push({
      update: function (dt, w) {
        var t = performance.now() * 0.002;
        var blink = 0.5 + 0.5 * Math.sin(t);
        warnMat.opacity = g.userData.warnBase * w * blink;
      }
    });

    return g;
  }

  // ============================================================
  // Layer 3: rooftop (0.12~0.22) — 楼顶平台 + 栏杆 + 远处小飞机 + 低空薄云
  // ============================================================
  function buildRooftop() {
    var g = new THREE.Group();

    // 8 个楼顶平台（带栏杆 + 水箱）
    for (var i = 0; i < 8; i++) {
      var rooftop = makeRooftop();
      var ang = (i / 8) * Math.PI * 2 + Math.random() * 0.3;
      var radius = 18 + Math.random() * 8;
      rooftop.position.set(
        Math.cos(ang) * radius,
        8 + Math.random() * 2,
        Math.sin(ang) * radius - 12
      );
      rooftop.rotation.y = Math.random() * Math.PI * 2;
      g.add(rooftop);
    }

    // 2 架远处小飞机
    var plane1 = makeSmallPlane();
    plane1.position.set(-30, 14, -28);
    plane1.userData.flight = { speed: 1.0, startX: -30, rangeX: 60 };
    g.add(plane1);

    var plane2 = makeSmallPlane();
    plane2.position.set(20, 18, -32);
    plane2.scale.setScalar(1.2);
    plane2.userData.flight = { speed: -0.8, startX: 20, rangeX: 50 };
    g.add(plane2);

    // 低空薄云（6 朵，稀疏）
    var thinCloudMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 1.0,
      transparent: true, opacity: 0.75, depthWrite: false
    });
    for (var i = 0; i < 6; i++) {
      var cloud = new THREE.Group();
      var lobes = 3 + Math.floor(Math.random() * 2);
      for (var j = 0; j < lobes; j++) {
        var r = 0.7 + Math.random() * 0.5;
        var sphere = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), thinCloudMat);
        sphere.position.set((j - lobes / 2) * 0.8, Math.random() * 0.25, Math.random() * 0.3);
        cloud.add(sphere);
      }
      cloud.position.set(
        -25 + Math.random() * 50,
        16 + Math.random() * 6,
        -25 - Math.random() * 12
      );
      cloud.scale.setScalar(1.6 + Math.random() * 1.2);
      cloud.userData.driftSpeed = 0.15 + Math.random() * 0.1;
      g.add(cloud);
    }

    registerFade(g);

    layerData.push({
      update: function (dt, w) {
        g.children.forEach(function (c) {
          if (c.userData.flight) {
            var f = c.userData.flight;
            c.position.x += f.speed * dt;
            if (f.speed > 0 && c.position.x > f.startX + f.rangeX) c.position.x = f.startX;
            if (f.speed < 0 && c.position.x < f.startX - f.rangeX) c.position.x = f.startX;
          }
          if (c.userData.driftSpeed != null) {
            c.position.x += c.userData.driftSpeed * dt;
            if (c.position.x > 35) c.position.x = -45;
          }
        });
      }
    });

    return g;
  }

  function makeRooftop() {
    var g = new THREE.Group();
    // 平台
    var platMat = new THREE.MeshStandardMaterial({ color: 0x4a4d52, roughness: 0.85 });
    var platform = new THREE.Mesh(new THREE.BoxGeometry(4, 0.4, 4), platMat);
    g.add(platform);

    // 栏杆（4 边细 Box）
    var railMat = new THREE.MeshStandardMaterial({ color: 0x222428, roughness: 0.6 });
    // 前/后
    for (var i = 0; i < 2; i++) {
      var rail = new THREE.Mesh(new THREE.BoxGeometry(4, 0.4, 0.06), railMat);
      rail.position.y = 0.4;
      rail.position.z = i === 0 ? -1.95 : 1.95;
      rail.rotation.y = Math.PI / 2;
      g.add(rail);
    }
    // 左/右
    for (var i = 0; i < 2; i++) {
      var rail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.4, 4), railMat);
      rail.position.y = 0.4;
      rail.position.x = i === 0 ? -1.95 : 1.95;
      g.add(rail);
    }

    // 水箱 / 通风
    if (Math.random() > 0.4) {
      var tank = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3, 0.3, 1.2, 8),
        new THREE.MeshStandardMaterial({ color: 0x666870, roughness: 0.7 })
      );
      tank.position.set((Math.random() - 0.5) * 1.5, 1.0, (Math.random() - 0.5) * 1.5);
      g.add(tank);
    }

    return g;
  }

  function makeSmallPlane() {
    var g = new THREE.Group();
    var bodyColor = 0xeeeeee;
    var body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 1.2, 8),
      new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.5, metalness: 0.3 })
    );
    body.rotation.z = Math.PI / 2;
    g.add(body);
    var wing = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 0.8, 0.22),
      new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.5, metalness: 0.3 })
    );
    g.add(wing);
    var tail = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, 0.25, 0.08),
      new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.5 })
    );
    tail.position.set(0.55, 0.07, 0);
    g.add(tail);
    return g;
  }

  // ============================================================
  // Layer 4: cloud (0.22~0.36) — 20 朵密集积云海
  // ============================================================
  // ============================================================
  // Layer 4: cloud (0.22~0.36) — 贴图云海
  //   1) 云海大平面：cloud-sea.webp 仰角俯视云海，置于竹蜻蜓下方偏远处
  //   2) 云朵精灵：cloud-a / cloud-b PNG 透明云朵，10~15 朵，不同深度/大小/亮度
  //   3) 少量球体云保留做近景遮挡（原程序化实现）
  //   4) 云海下方淡白雾 Plane（模拟云海厚度）
  // ============================================================
  function buildClouds() {
    var g = new THREE.Group();

    // ---- 1. 云海大平面（横向俯视云海贴图）----
    var cloudSeaTex = getOrCreateTex('cloud_sea', function () {
      var c = document.createElement('canvas');
      c.width = c.height = 4;
      var cx = c.getContext('2d');
      cx.fillStyle = 'rgba(255,255,255,0.8)';
      cx.fillRect(0, 0, 4, 4);
      var t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    });
    var cloudSeaMat = new THREE.MeshBasicMaterial({
      map: cloudSeaTex,
      transparent: true, opacity: 0.85,
      depthWrite: false, side: THREE.DoubleSide
    });
    var cloudSea = new THREE.Mesh(new THREE.PlaneGeometry(280, 160), cloudSeaMat);
    cloudSea.rotation.x = -Math.PI / 2;  // 横向铺设
    cloudSea.position.y = -8;             // 竹蜻蜓下方
    cloudSea.position.z = -20;            // 偏远处
    cloudSea.renderOrder = -1;            // 先于云朵渲染
    cloudSea.userData.driftSpeed = 0.35;  // 缓慢漂移
    g.add(cloudSea);

    // ---- 2. 云朵精灵（transparent PNG，始终面向相机）----
    var cloudATex = getOrCreateTex('cloud_a', function () {
      return makeCanvas(128, 64, function (ctx, w, h) {
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        for (var i = 0; i < 8; i++) {
          ctx.beginPath();
          ctx.arc(
            Math.random() * w, Math.random() * h,
            8 + Math.random() * 18,
            0, Math.PI * 2
          );
          ctx.fill();
        }
      });
    });
    var cloudBTex = getOrCreateTex('cloud_b', function () {
      return makeCanvas(128, 64, function (ctx, w, h) {
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(250,250,255,0.75)';
        for (var i = 0; i < 6; i++) {
          ctx.beginPath();
          ctx.ellipse(
            Math.random() * w, Math.random() * h,
            18 + Math.random() * 22, 10 + Math.random() * 14,
            Math.random() * Math.PI, 0, Math.PI * 2
          );
          ctx.fill();
        }
      });
    });

    var spriteCount = MOBILE ? 8 : 12;
    for (var i = 0; i < spriteCount; i++) {
      var useA = (i % 2 === 0);
      var depth = Math.random();              // 0~1, 0=近 1=远
      var baseScale = BG.lerp(14, 5, depth);  // 近大远小
      var baseOp = BG.lerp(0.95, 0.55, depth); // 近亮远淡

      var mat = new THREE.SpriteMaterial({
        map: useA ? cloudATex : cloudBTex,
        transparent: true, opacity: baseOp,
        depthWrite: false
      });
      var sprite = new THREE.Sprite(mat);
      sprite.scale.set(baseScale, baseScale * 0.55, 1);

      // 位置：散布竹蜻蜓四周（近处少、远处多）
      var ang = Math.random() * Math.PI * 2;
      var radius = BG.lerp(8, 30, depth);
      sprite.position.set(
        Math.cos(ang) * radius,
        18 + (Math.random() - 0.5) * 8,
        -10 + Math.sin(ang) * radius * 0.5
      );
      sprite.userData.driftSpeed = BG.lerp(0.4, 0.15, depth);
      sprite.userData.rangeX = 60;
      g.add(sprite);
    }

    // ---- 3. 保留少量球体云（近景遮挡，保证左侧有体积感）----
    var matSphere = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 1.0,
      transparent: true, opacity: 0.92, depthWrite: false
    });
    var sphereCount = MOBILE ? 3 : 5;
    for (var i = 0; i < sphereCount; i++) {
      var cloud = new THREE.Group();
      var lobes = 5 + Math.floor(Math.random() * 3);
      for (var j = 0; j < lobes; j++) {
        var r = 0.7 + Math.random() * 0.7;
        var sphere = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), matSphere);
        sphere.position.set(
          (j - lobes / 2) * 0.85,
          Math.random() * 0.3,
          Math.random() * 0.35
        );
        cloud.add(sphere);
      }
      var ang = Math.random() * Math.PI * 2;
      var radius = 5 + Math.random() * 10;
      cloud.position.set(
        Math.cos(ang) * radius,
        16 + Math.random() * 8,
        Math.sin(ang) * radius - 5
      );
      cloud.scale.setScalar(1.4 + Math.random() * 1.3);
      cloud.userData.driftSpeed = 0.10 + Math.random() * 0.15;
      cloud.userData.rangeX = 32;
      g.add(cloud);
    }

    // ---- 4. 云海下方淡白雾（深度补足）----
    var fogMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true, opacity: 0.28,
      depthWrite: false, side: THREE.DoubleSide
    });
    var fogPlane = new THREE.Mesh(new THREE.PlaneGeometry(420, 260), fogMat);
    fogPlane.rotation.x = -Math.PI / 2;
    fogPlane.position.y = -18;
    fogPlane.position.z = -35;
    fogPlane.renderOrder = -2; // 最先渲染作为背景
    g.add(fogPlane);

    registerFade(g);  // 自动乘 phase w

    layerData.push({
      update: function (dt, w) {
        g.children.forEach(function (c) {
          if (c.userData.driftSpeed != null) {
            c.position.x += c.userData.driftSpeed * dt;
            var range = c.userData.rangeX || 32;
            if (c.position.x > range) c.position.x = -range;
          }
        });
      }
    });

    return g;
  }

  // ============================================================
  // Layer 5: plane (0.36~0.48) — 大型民航飞机 + 尾迹 + 平流层稀云
  // ============================================================
  function buildPlane() {
    var g = new THREE.Group();

    // 2 架大型民航飞机（机翼/引擎/尾翼/垂直尾翼完整）
    for (var p = 0; p < 2; p++) {
      var plane = makeAirliner();
      plane.position.set(
        p === 0 ? -55 : 35,
        48 + p * 6,
        -40 - p * 8
      );
      plane.userData.flight = {
        speed: p === 0 ? 1.4 : -1.1,
        startX: plane.position.x,
        rangeX: 95
      };
      g.add(plane);

      // 长尾迹云（细长 PlaneGeometry + Additive）
      var trailMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.45,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      });
      trailMat.userData.fadeManual = true;
      var trail = new THREE.Mesh(new THREE.PlaneGeometry(30, 0.15), trailMat);
      trail.rotation.y = Math.PI / 2;
      trail.position.copy(plane.position);
      trail.position.x -= 14;
      trail.userData.followPlane = plane;
      g.add(trail);
    }

    // 平流层稀云（4 朵，作下方云海背景）
    var matCloud = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 1.0,
      transparent: true, opacity: 0.55, depthWrite: false
    });
    for (var i = 0; i < 4; i++) {
      var cloud = new THREE.Group();
      var lobes = 3 + Math.floor(Math.random() * 2);
      for (var j = 0; j < lobes; j++) {
        var r = 1.0 + Math.random() * 0.6;
        var sphere = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), matCloud);
        sphere.position.set((j - lobes / 2) * 1.2, Math.random() * 0.3, Math.random() * 0.4);
        cloud.add(sphere);
      }
      cloud.position.set(
        -30 + Math.random() * 60,
        36 + Math.random() * 6,
        -35 - Math.random() * 10
      );
      cloud.scale.setScalar(2.5 + Math.random() * 1.5);
      cloud.userData.driftSpeed = 0.25 + Math.random() * 0.2;
      g.add(cloud);
    }

    registerFade(g);

    layerData.push({
      update: function (dt, w) {
        g.children.forEach(function (c) {
          if (c.userData.flight) {
            var f = c.userData.flight;
            c.position.x += f.speed * dt;
            if (f.speed > 0 && c.position.x > f.startX + f.rangeX) c.position.x = f.startX;
            if (f.speed < 0 && c.position.x < f.startX - f.rangeX) c.position.x = f.startX;
          }
          if (c.userData.followPlane) {
            var p = c.userData.followPlane;
            c.position.x = p.position.x - 15;
            c.position.y = p.position.y;
            c.position.z = p.position.z;
            var tt = Math.min((p.position.x - p.userData.flight.startX) / 30 + 1, 1);
            c.material.opacity = 0.45 * tt * w;
          }
          if (c.userData.driftSpeed != null) {
            c.position.x += c.userData.driftSpeed * dt;
            if (c.position.x > 35) c.position.x = -55;
          }
        });
      }
    });

    return g;
  }

  function makeAirliner() {
    var g = new THREE.Group();
    var bodyColor = 0xe8eef0;
    var bodyMat = new THREE.MeshStandardMaterial({
      color: bodyColor, roughness: 0.4, metalness: 0.4
    });

    // 机身
    var body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.15, 3.0, 12),
      bodyMat
    );
    body.rotation.z = Math.PI / 2;
    g.add(body);

    // 机头
    var nose = new THREE.Mesh(
      new THREE.SphereGeometry(0.15, 12, 8),
      bodyMat
    );
    nose.position.x = 1.5;
    g.add(nose);

    // 主翼
    var wing = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 2.5, 0.5),
      bodyMat
    );
    g.add(wing);

    // 水平尾翼
    var tail = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, 0.5, 0.15),
      new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.5 })
    );
    tail.position.set(-1.4, 0.12, 0);
    g.add(tail);

    // 垂直尾翼
    var vtail = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, 0.4, 0.5),
      new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.5 })
    );
    vtail.position.set(-1.3, 0.18, 0);
    g.add(vtail);

    // 引擎（2 个 cylinder 在机翼下）
    var engineMat = new THREE.MeshStandardMaterial({
      color: 0x4a4d52, roughness: 0.4, metalness: 0.6
    });
    for (var i = 0; i < 2; i++) {
      var engine = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.08, 0.4, 8),
        engineMat
      );
      engine.rotation.z = Math.PI / 2;
      engine.position.set(0.1, -0.15, i === 0 ? -1.0 : 1.0);
      g.add(engine);
    }

    return g;
  }

  // ============================================================
  // Layer 6: nearspace (0.48~0.54) — 大地球 + 大气辉光
  // 1024×512 精细纹理：海洋渐变 + 大陆/沙漠/雪山 + 多云层
  // ============================================================
  function buildNearspace() {
    var g = new THREE.Group();

    var earth = makeEarth(true);
    earth.position.set(0, -15, -100);
    g.add(earth);

    // 大气辉光 Sprite
    var glowTex = makeHaloTex(0x88bbff);
    var glowMat = new THREE.SpriteMaterial({
      map: glowTex, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    glowMat.userData.fadeManual = true;
    var earthGlow = new THREE.Sprite(glowMat);
    earthGlow.scale.setScalar(95);
    earthGlow.position.copy(earth.position);
    g.add(earthGlow);

    layerData.push({
      update: function (dt, w) {
        earth.rotation.y += dt * 0.025;
        glowMat.opacity = 0.55 * w;
      }
    });

    return g;
  }

  // detailed=true 用 64 段 + 大半径（nearspace 大地球）；false 用 48 段 + 小半径（orbit 远处小地球）
  // 贴图统一用 earth_daymap.webp（async 加载，首帧用程序化 fallback）
  function makeEarth(detailed) {
    var tex = getOrCreateTex('earth', function () {
      return makeCanvas(detailed ? 1024 : 512, 512, function (ctx, w, h) {
        // 海洋（深蓝渐变）
        var grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, '#1e4a8a');
        grad.addColorStop(0.5, '#3a72b8');
        grad.addColorStop(1, '#1e4a8a');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);

        // 大陆（绿色不规则块）
        var landColor = ['#4a8a55', '#3a7a45', '#5a9a65', '#6a8a4a'];
        var landCount = detailed ? 60 : 28;
        for (var i = 0; i < landCount; i++) {
          ctx.fillStyle = landColor[i % landColor.length];
          var x = Math.random() * w, y = Math.random() * h;
          var r1 = 30 + Math.random() * 80;
          var r2 = 20 + Math.random() * 50;
          ctx.beginPath();
          ctx.ellipse(x, y, r1, r2, Math.random() * Math.PI, 0, Math.PI * 2);
          ctx.fill();
        }

        // 沙漠（棕黄）
        var desertCount = detailed ? 30 : 14;
        for (var i = 0; i < desertCount; i++) {
          ctx.fillStyle = 'rgba(200, 167, 102, 0.7)';
          var x = Math.random() * w, y = Math.random() * h;
          var r = 18 + Math.random() * 35;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }

        // 雪山（仅 detailed 版）
        if (detailed) {
          for (var i = 0; i < 15; i++) {
            ctx.fillStyle = 'rgba(230, 235, 240, 0.6)';
            var x = Math.random() * w, y = Math.random() * h;
            var r = 12 + Math.random() * 25;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        // 极地冰盖
        ctx.fillStyle = '#e8e8e8';
        ctx.fillRect(0, 0, w, 32);
        ctx.fillRect(0, h - 32, w, 32);

        // 云层（半透明白覆盖）
        var cloudCount = detailed ? 35 : 18;
        for (var i = 0; i < cloudCount; i++) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
          var x = Math.random() * w, y = Math.random() * h;
          var r = 25 + Math.random() * 60;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      });
    });
    var geom = new THREE.SphereGeometry(detailed ? 38 : 28, detailed ? 64 : 48, detailed ? 48 : 36);
    return new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
      map: tex, roughness: 0.7, metalness: 0.05
    }));
  }

  // ============================================================
  // Layer 7: orbit (0.54~0.60) — 卫星 + 空间站 + 远处小地球（视觉渐小）
  // ============================================================
  function buildOrbit() {
    var g = new THREE.Group();

    // 卫星（主体 + 双太阳能板 + 天线）
    var sat = makeSatellite();
    sat.position.set(-25, 30, -35);
    sat.userData.orbit = { speed: 0.8 };
    g.add(sat);

    // 空间站（多段舱 + 4 块太阳能阵列）
    var station = makeSpaceStation();
    station.position.set(20, 35, -50);
    station.userData.orbit = { speed: -0.5 };
    g.add(station);

    // 远处小地球（视觉"渐小"由 orbit 层独立显示，与 nearspace 大地球共同渲染）
    var earth = makeEarth(false);
    earth.position.set(0, -10, -120);
    g.add(earth);

    layerData.push({
      update: function (dt, w) {
        g.children.forEach(function (c) {
          if (c.userData.orbit) {
            var o = c.userData.orbit;
            c.position.x += o.speed * dt;
            if (o.speed > 0 && c.position.x > 40) c.position.x = -40;
            if (o.speed < 0 && c.position.x < -40) c.position.x = 40;
            c.rotation.y += dt * 0.4;
          }
        });
        earth.rotation.y += dt * 0.02;
      }
    });

    return g;
  }

  function makeSatellite() {
    var g = new THREE.Group();
    var body = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.4, 0.3),
      new THREE.MeshStandardMaterial({ color: 0x888c92, roughness: 0.5, metalness: 0.6 })
    );
    g.add(body);

    // 太阳能板（左右）
    var panelMat = new THREE.MeshStandardMaterial({
      color: 0x1a2a5a, roughness: 0.3, metalness: 0.4,
      emissive: 0x1a3a7a, emissiveIntensity: 0.15
    });
    for (var i = 0; i < 2; i++) {
      var panel = new THREE.Mesh(
        new THREE.BoxGeometry(2.0, 0.6, 0.05),
        panelMat
      );
      panel.position.x = i === 0 ? -1.3 : 1.3;
      g.add(panel);
    }

    // 天线
    var antenna = new THREE.Mesh(
      new THREE.CylinderGeometry(0.02, 0.02, 0.6, 6),
      new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.4, metalness: 0.7 })
    );
    antenna.position.y = 0.4;
    g.add(antenna);

    return g;
  }

  function makeSpaceStation() {
    var g = new THREE.Group();
    var hullMat = new THREE.MeshStandardMaterial({
      color: 0xc8c8d0, roughness: 0.5, metalness: 0.5
    });

    // 中央舱（3 段 cylinder 横排）
    for (var i = 0; i < 3; i++) {
      var hull = new THREE.Mesh(
        new THREE.CylinderGeometry(0.2, 0.2, 0.8, 12),
        hullMat
      );
      hull.rotation.z = Math.PI / 2;
      hull.position.x = (i - 1) * 0.9;
      g.add(hull);
    }

    // 4 块大型太阳能板阵列
    var panelMat = new THREE.MeshStandardMaterial({
      color: 0x142850, roughness: 0.3, metalness: 0.5,
      emissive: 0x0a2050, emissiveIntensity: 0.2
    });
    for (var i = 0; i < 4; i++) {
      var panel = new THREE.Mesh(
        new THREE.BoxGeometry(2.5, 0.8, 0.04),
        panelMat
      );
      panel.position.x = (i < 2 ? -2.4 : 2.4);
      panel.position.y = (i % 2 === 0 ? 0.6 : -0.6);
      g.add(panel);
    }

    return g;
  }

  // ============================================================
  // Layer 8: moon (0.60~0.72) — 三档接近感月球 + halo + 信笺弱光
  // letter=true 层（信笺彩蛋）
  // altitude 0.60→0.72: scale 0.5→3.0, emissive 0→0.55, halo 25→70
  // altitude 0.72→0.85: 让位给火星，opacity/emissive/halo/light 全部淡出
  // ============================================================
  function buildMoon() {
    var g = new THREE.Group();

    var moonTex = getOrCreateTex('moon', function () {
      return makeCanvas(512, 512, function (ctx, w, h) {
        ctx.fillStyle = '#e8e4da';
        ctx.fillRect(0, 0, w, h);
        // 月海（暗斑）
        ctx.fillStyle = 'rgba(80, 75, 70, 0.30)';
        for (var i = 0; i < 12; i++) {
          ctx.beginPath();
          ctx.ellipse(
            Math.random() * w, Math.random() * h,
            20 + Math.random() * 45,
            14 + Math.random() * 30,
            Math.random() * Math.PI,
            0, Math.PI * 2
          );
          ctx.fill();
        }
        // 环形山（暗+亮边）
        for (var i = 0; i < 70; i++) {
          var x = Math.random() * w, y = Math.random() * h;
          var r = 4 + Math.random() * 20;
          ctx.fillStyle = 'rgba(80, 70, 60, 0.25)';
          ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = 'rgba(255, 240, 215, 0.45)';
          ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
        }
      });
    });

    var moonGeom = new THREE.SphereGeometry(10, 64, 48);
    var moonMat = new THREE.MeshStandardMaterial({
      map: moonTex, color: 0xe8e4da,
      roughness: 0.85, metalness: 0.02,
      emissive: 0xffefd0, emissiveIntensity: 0.0,
      transparent: true, opacity: 1.0
    });
    moonMat.userData.fadeManual = true;
    var moon = new THREE.Mesh(moonGeom, moonMat);
    moon.position.set(0, 95, -60);
    g.add(moon);

    // halo Sprite
    var haloTex = makeHaloTex(0xffeac0);
    var haloMat = new THREE.SpriteMaterial({
      map: haloTex, color: 0xffeac0,
      transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    haloMat.userData.fadeManual = true;
    var halo = new THREE.Sprite(haloMat);
    halo.scale.setScalar(30);
    halo.position.copy(moon.position);
    g.add(halo);

    // 信笺弱光 PointLight
    var moonLight = new THREE.PointLight(0xfff0d0, 0, 100, 1.2);
    g.add(moonLight);

    g.userData.moon = moon;
    g.userData.halo = halo;
    g.userData.moonLight = moonLight;

    layerData.push({
      update: function (dt, w) {
        var moon = g.userData.moon;
        var halo = g.userData.halo;
        var moonLight = g.userData.moonLight;
        var alt = BG.S.altitude || 0;

        // 三档接近感：0.60→0.72 从远到近
        var approach = BG.smoothstep(0.60, 0.72, alt);
        var scale = BG.lerp(0.5, 3.0, approach);
        moon.scale.setScalar(scale);
        halo.scale.setScalar(BG.lerp(25, 70, approach));

        // 让位给火星（0.72→0.85 fadeOut）
        var fadeOut = 1 - BG.smoothstep(0.72, 0.85, alt);

        moon.material.emissiveIntensity = BG.lerp(0.0, 0.55, approach) * w * fadeOut;
        moon.material.opacity = w * fadeOut;
        halo.material.opacity = BG.lerp(0.0, 0.75, approach) * w * fadeOut;
        moonLight.intensity = BG.lerp(0, 1.8, approach) * w * fadeOut;
      }
    });

    return g;
  }

  // ============================================================
  // Layer 9: mars (0.72~0.84) — 火星 + 远处太阳
  // ============================================================
  function buildMars() {
    var g = new THREE.Group();

    // 火星（贴图加载，fallback 为程序化火星）
    var marsTex = getOrCreateTex('mars', function () {
      return makeCanvas(256, 128, function (ctx, w, h) {
        ctx.fillStyle = '#c1440e';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(60, 30, 10, 0.5)';
        for (var i = 0; i < 40; i++) {
          var x = Math.random() * w, y = Math.random() * h;
          var r = 3 + Math.random() * 18;
          ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        }
        // 极冠白色小斑
        ctx.fillStyle = 'rgba(230, 220, 200, 0.7)';
        ctx.fillRect(0, 0, w, 12);
        ctx.fillRect(0, h - 12, w, 12);
      });
    });
    var mars = new THREE.Mesh(
      new THREE.SphereGeometry(2.6, 32, 24),
      new THREE.MeshStandardMaterial({
        map: marsTex, roughness: 0.85, metalness: 0.02,
        emissive: 0xc1440e, emissiveIntensity: 0.05
      })
    );
    mars.position.set(-22, 75, -55);
    mars.userData.spin = 0.04;
    g.add(mars);

    // 远处太阳（贴图加载，fallback 为纯色）
    var sunTex = getOrCreateTex('sun', function () {
      var c = document.createElement('canvas');
      c.width = c.height = 4;
      var cx = c.getContext('2d');
      cx.fillStyle = '#ffeacc';
      cx.fillRect(0, 0, 4, 4);
      var t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    });
    var sunMat = new THREE.MeshBasicMaterial({ map: sunTex, color: 0xffffff });
    var sun = new THREE.Mesh(new THREE.SphereGeometry(14, 24, 18), sunMat);
    sun.position.set(35, 85, -100);
    g.add(sun);

    var sunHaloTex = makeHaloTex(0xffd58a);
    var sunHaloMat = new THREE.SpriteMaterial({
      map: sunHaloTex, color: 0xffd58a,
      transparent: true, opacity: 0.7,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    sunHaloMat.userData.fadeManual = true;
    var sunHalo = new THREE.Sprite(sunHaloMat);
    sunHalo.scale.setScalar(60);
    sunHalo.position.copy(sun.position);
    g.add(sunHalo);

    g.userData.sunHaloBase = sunHaloMat.opacity;

    layerData.push({
      update: function (dt, w) {
        g.children.forEach(function (c) {
          if (c.userData.spin != null) c.rotation.y += c.userData.spin * dt;
        });
        sunHaloMat.opacity = g.userData.sunHaloBase * w;
      }
    });

    return g;
  }

  // ============================================================
  // Layer 10: planets (0.84~0.96) — 土星（Cassini 双环）+ 木星
  // 土星环：A 环(2.7~3.4) + 暗隙(3.4~3.9 Cassini Division) + B 环(3.9~5.2)
  // ============================================================
  function buildPlanets() {
    var g = new THREE.Group();

    var saturn = makeSaturn();
    saturn.position.set(28, 80, -65);
    saturn.userData.spin = 0.025;
    g.add(saturn);

    // 木星（贴图加载，fallback 为程序化木星）
    var jupTex = getOrCreateTex('jupiter', function () {
      return makeCanvas(256, 128, function (ctx, w, h) {
        ctx.fillStyle = '#d6a05a';
        ctx.fillRect(0, 0, w, h);
        var bands = ['#e8c890', '#c08850', '#b07040', '#e0b888', '#a86838'];
        for (var i = 0; i < 12; i++) {
          ctx.fillStyle = bands[i % bands.length];
          var y = (i / 12) * h;
          var bh = (h / 12) * (0.7 + Math.random() * 0.4);
          ctx.fillRect(0, y, w, bh);
        }
        // 大红斑
        ctx.fillStyle = 'rgba(170, 60, 30, 0.85)';
        ctx.beginPath();
        ctx.ellipse(w * 0.7, h * 0.6, 24, 11, 0, 0, Math.PI * 2);
        ctx.fill();
      });
    });
    var jupiter = new THREE.Mesh(
      new THREE.SphereGeometry(3.8, 32, 24),
      new THREE.MeshStandardMaterial({
        map: jupTex, roughness: 0.75, metalness: 0.05
      })
    );
    jupiter.position.set(0, 68, -85);
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

    // 本体（贴图加载，fallback 为程序化土星）
    var satTex = getOrCreateTex('saturn', function () {
      return makeCanvas(256, 128, function (ctx, w, h) {
        ctx.fillStyle = '#d8b27a';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(180, 130, 70, 0.4)';
        for (var i = 0; i < 10; i++) {
          var y = (i / 10) * h;
          ctx.fillRect(0, y, w, 4);
        }
      });
    });
    var planet = new THREE.Mesh(
      new THREE.SphereGeometry(3.0, 32, 24),
      new THREE.MeshStandardMaterial({
        map: satTex, roughness: 0.75, metalness: 0.05
      })
    );
    g.add(planet);

    // 土星环（贴图加载，fallback 为纯色双环）
    var ringTex = getOrCreateTex('saturn_ring', function () {
      // fallback：模拟 A 环 + Cassini 暗隙 + B 环
      return makeCanvas(256, 32, function (ctx, w, h) {
        ctx.fillStyle = 'rgba(216, 178, 122, 0)';
        ctx.fillRect(0, 0, w, h);
        // A 环
        ctx.fillStyle = 'rgba(216, 178, 122, 0.85)';
        ctx.fillRect(0, 0, w * 0.55, h * 0.45);
        // Cassini 暗隙（保持透明）
        // B 环
        ctx.fillRect(w * 0.62, h * 0.30, w * 0.38, h * 0.50);
      });
    });
    var ringMat = new THREE.MeshBasicMaterial({
      map: ringTex,
      side: THREE.DoubleSide,
      transparent: true, opacity: 0.92, depthWrite: false
    });
    // 单环 + 贴图（贴图本身已包含 A 环 / Cassini 缝 / B 环）
    var ring = new THREE.Mesh(new THREE.RingGeometry(3.4, 5.6, 96), ringMat);
    ring.rotation.x = Math.PI / 2 - 0.35;
    g.add(ring);

    return g;
  }

  // ============================================================
  // Layer 11: solaredge (0.96~1.20) — 柯伊伯带冰粒子 + 少量多面体冰块
  // ============================================================
  function buildSolaredge() {
    var g = new THREE.Group();

    // 柯伊伯带冰粒子（球壳分布，冷白蓝）
    var count = MOBILE ? 250 : 500;
    var positions = new Float32Array(count * 3);
    var colors = new Float32Array(count * 3);
    for (var i = 0; i < count; i++) {
      var r = 70 + Math.random() * 60;
      var theta = Math.random() * Math.PI * 2;
      var phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi) + 80;
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
      var c = 0.7 + Math.random() * 0.3;
      colors[i * 3]     = c * 0.85;
      colors[i * 3 + 1] = c * 0.92;
      colors[i * 3 + 2] = c;
    }
    var geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    var mat = new THREE.PointsMaterial({
      size: 0.4, vertexColors: true,
      transparent: true, opacity: 0.7,
      sizeAttenuation: true, depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    var kuiper = new THREE.Points(geom, mat);
    kuiper.userData.count = count;
    g.add(kuiper);

    // 少量多面体冰块（点缀）
    var ices = [];
    for (var i = 0; i < 8; i++) {
      var ice = new THREE.Mesh(
        new THREE.DodecahedronGeometry(0.4 + Math.random() * 0.5, 0),
        new THREE.MeshStandardMaterial({
          color: 0xb8c8e0, roughness: 0.6, metalness: 0.2,
          emissive: 0x6680a0, emissiveIntensity: 0.05
        })
      );
      var ang = Math.random() * Math.PI * 2;
      var rad = 25 + Math.random() * 20;
      ice.position.set(
        Math.cos(ang) * rad,
        60 + Math.random() * 30,
        Math.sin(ang) * rad - 30
      );
      ice.userData.driftSpeed = 0.15 + Math.random() * 0.2;
      g.add(ice);
      ices.push(ice);
    }

    registerFade(g);

    layerData.push({
      update: function (dt, w) {
        // 冰粒子缓慢漂移
        var posArr = kuiper.geometry.attributes.position.array;
        var n = kuiper.userData.count;
        for (var i = 0; i < n; i++) {
          posArr[i * 3] += dt * 0.05;
          if (posArr[i * 3] > 100) posArr[i * 3] = -100;
        }
        kuiper.geometry.attributes.position.needsUpdate = true;
        ices.forEach(function (ice) {
          ice.position.x += ice.userData.driftSpeed * dt;
          if (ice.position.x > 60) ice.position.x = -60;
          ice.rotation.y += dt * 0.2;
        });
      }
    });

    return g;
  }

  // ============================================================
  // Layer 12: galaxy (1.20) — 银河螺旋盘 + 4 色星云 + 远景亮星
  // ============================================================
  function buildGalaxy() {
    var g = new THREE.Group();

    // 银河螺旋粒子（4 臂）
    var count = MOBILE ? 800 : 1500;
    var positions = new Float32Array(count * 3);
    var colors = new Float32Array(count * 3);
    var arms = 4;

    for (var i = 0; i < count; i++) {
      var armIdx = i % arms;
      var dist = Math.pow(Math.random(), 0.6) * 60;
      var angle = armIdx * (Math.PI * 2 / arms) + dist * 0.18 + (Math.random() - 0.5) * 0.4;
      var y = (Math.random() - 0.5) * (3 + dist * 0.08);

      positions[i * 3]     = Math.cos(angle) * dist;
      positions[i * 3 + 1] = y + 130;
      positions[i * 3 + 2] = Math.sin(angle) * dist - 15;

      // 中心暖白 → 边缘冷蓝紫
      var t = Math.min(dist / 60, 1);
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

    // 4 色星云
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
      neb.userData._baseOp = nebMat.opacity;
      g.add(neb);
    }

    // 远景亮星
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
    farMat.userData._baseOp = farMat.opacity;
    var farPoints = new THREE.Points(farGeom, farMat);
    g.add(farPoints);

    registerFade(g);

    layerData.push({
      update: function (dt, w) {
        galaxy.rotation.z += dt * 0.01;
        // fadeManual 跟随 phase 权重
        g.children.forEach(function (c) {
          if (c.material && c.material.userData && c.material.userData.fadeManual &&
              c.userData._baseOp != null) {
            c.material.opacity = c.userData._baseOp * w;
          }
        });
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

    // 天空（独立挂 scene，不参与 root 层级）
    scene.add(buildSky());

    // 根 Group（13 层 + 远景星空）
    root = new THREE.Group();
    scene.add(root);

    // 13 层（顺序对齐 PHASES）
    layerGroups = [
      buildGround(),      //  0 ground        0.000
      buildTree(),        //  1 tree          0.040
      buildBuilding(),    //  2 building      0.080
      buildRooftop(),     //  3 rooftop       0.120
      buildClouds(),      //  4 cloud         0.220
      buildPlane(),       //  5 plane         0.360
      buildNearspace(),   //  6 nearspace     0.480
      buildOrbit(),       //  7 orbit         0.540
      buildMoon(),        //  8 moon          0.600 (letter)
      buildMars(),        //  9 mars          0.720
      buildPlanets(),     // 10 planets       0.840
      buildSolaredge(),   // 11 solaredge     0.960
      buildGalaxy()       // 12 galaxy        1.200
    ];

    layerGroups.forEach(function (lg) {
      root.add(lg);
    });

    // 独立远景星空（不参与 phase weight）
    starfieldGroup = buildStarfield();
    root.add(starfieldGroup);

    // 异步预加载所有素材贴图（加载完后自动升级对应 Texture 的 image）
    preloadTextures();
  }

  // ========== 每帧更新 ==========
  function update(dt) {
    if (!initialized) return;

    var alt = BG.S.altitude || 0;
    var w = computeWeights(alt);

    // 天空色板（13 层权重插值）
    updateSky(alt);

    // 远景星空（独立控制）
    updateStarfield(alt);

    // 13 层
    for (var i = 0; i < layerGroups.length; i++) {
      var lg = layerGroups[i];
      var wi = w[i] || 0;

      // visibility 硬切换（weight 太低时直接隐藏，省渲染开销）
      lg.visible = wi > 0.02;

      // 自动 fade managed 透明材质
      if (lg.visible) applyFade(lg, wi);

      // 自定义 update（动态行为 + fadeManual 自管）
      var ld = layerData[i];
      if (ld && ld.update) ld.update(dt, wi);
    }
  }

  BG.register('world', {
    init: init,
    update: update
  });
})();