/* ============================================================
 * game.js — 全局契约（所有模块的地基，谁都不能破坏）
 *
 * 约定：
 * 1. 所有模块挂 window.BambooGame 下，经典 script，禁止 ES module
 * 2. 全局状态 BambooGame.S（唯一状态源）
 * 3. 模块间通信走 BambooGame.bus（事件总线），禁止直接跨模块调用业务函数
 * 4. 主循环顺序固定：physics.step → audio.update → scene.render → ui.update → achievements.check
 * 5. 新增模块：实现接口后 BambooGame.register('名字', mod)，main.js 里统一 init
 * ============================================================ */
(function () {
  'use strict';

  /* ---------- 全局状态（唯一状态源） ---------- */
  var S = {
    omega: 0,          // 角速度 rad/s（物理核心）
    rpm: 0,            // 转速 = omega/(2π)*60，每帧由 omega 刷新
    altitude: 0,       // 归一高度 0..ALTITUDE_MAX（1=月亮，>1 冲出银河）
    altitudeKm: 0,     // 展示高度（艺术化，game.js 每帧派生）
    altitudeUnit: 'km',// 高度单位（km / 万光年）
    flying: false,     // 是否升空（omega 超过起飞阈值）
    phase: 'ground',   // 当前层级 id（见 PHASES）
    phaseIndex: 0,     // 当前层级下标
    score: 0,          // 本局积分（温柔计分，不施压）
    best: 0,           // 历史最佳（localStorage）
    flightTime: 0,     // 本局累计飞行秒
    totalFlights: 0,   // 累计放飞次数
    spinCount: 0,      // 累计搓动次数
    photosCollected: 0,// 已收集照片数
    letterUnlocked: false, // 信是否已解锁
    started: false,    // 是否已开始游戏
    finished: false    // 本局是否已结束（落地）
  };

  /* ---------- 层级表（契约数据） ----------
   * t: 进入该层级的归一高度阈值（0~ALTITUDE_MAX）
   * 13 层，满速爬升（0.002/s）时刻表：树梢 20s / 楼群 40s / 楼顶低空 60s / 积云 110s /
   * 平流层飞机 180s / 近地太空 240s / 轨道 270s / 月亮 300s（信）/ 火星 360s /
   * 外行星带 420s / 太阳系边缘 480s / 银河尽头 600s
   * ditto 负责视觉实现，fairy 负责把 altitude 映射到 phase */
  var PHASES = [
    { id: 'ground',    name: '草地与花丛', t: 0.000, letter: false },
    { id: 'tree',      name: '树梢之上',   t: 0.040, letter: false },
    { id: 'building',  name: '城市楼群',   t: 0.080, letter: false },
    { id: 'rooftop',   name: '楼顶与低空', t: 0.120, letter: false },
    { id: 'cloud',     name: '积云层',     t: 0.220, letter: false },
    { id: 'plane',     name: '平流层',     t: 0.360, letter: false },
    { id: 'nearspace', name: '近地太空',   t: 0.480, letter: false },
    { id: 'orbit',     name: '地球轨道',   t: 0.540, letter: false },
    { id: 'moon',      name: '月亮',       t: 0.600, letter: true  },
    { id: 'mars',      name: '火星',       t: 0.720, letter: false },
    { id: 'planets',   name: '外行星带',   t: 0.840, letter: false },
    { id: 'solaredge', name: '太阳系边缘', t: 0.960, letter: false },
    { id: 'galaxy',    name: '银河尽头',   t: 1.200, letter: false }
  ];
  var ALTITUDE_MAX = 1.2; // 封顶（银河尽头之上）

  /* ---------- 事件总线 ---------- */
  var bus = {
    _m: {},
    on: function (evt, fn) {
      (this._m[evt] = this._m[evt] || []).push(fn);
    },
    off: function (evt, fn) {
      var list = this._m[evt];
      if (!list) return;
      var i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    emit: function (evt, data) {
      var list = this._m[evt];
      if (!list) return;
      for (var i = 0; i < list.length; i++) {
        try { list[i](data); } catch (e) { console.error('[bus:' + evt + ']', e); }
      }
    }
  };

  /* ---------- 模块注册 ---------- */
  var modules = {};
  function register(name, mod) {
    if (modules[name]) console.warn('[game] 模块重复注册:', name);
    modules[name] = mod;
  }
  function getModule(name) { return modules[name]; }

  /* ---------- 工具 ---------- */
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(edge0, edge1, x) {
    var t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  /* ---------- 主循环 ---------- */
  var lastT = 0;
  function frame(t) {
    var dt = Math.min((t - lastT) / 1000 || 0.016, 0.05);
    lastT = t;

    // 刷新派生状态
    S.rpm = S.omega / (2 * Math.PI) * 60;
    S.altitude = clamp(S.altitude, 0, ALTITUDE_MAX);

    // 艺术化高度映射（物理层只输出归一高度，这里换算成可感知单位）
    // 0~0.12: 地面到楼顶 500m；0.12~0.36: 楼顶到平流层飞机 12000m；
    // 0.36~0.60: 指数放大到月球距离 384400km；0.60~1.20: 换万光年，银河尽头约 5.2 万光年
    var t = S.altitude;
    if (t < 0.12) {
      S.altitudeKm = t / 0.12 * 500;
      S.altitudeUnit = 'm';
    } else if (t < 0.36) {
      S.altitudeKm = 500 + (t - 0.12) / 0.24 * 11500;
      S.altitudeUnit = 'm';
    } else if (t < 0.60) {
      S.altitudeKm = 12 * Math.pow(384400 / 12, (t - 0.36) / 0.24);
      S.altitudeUnit = 'km';
    } else {
      S.altitudeKm = (t - 0.60) / 0.60 * 5.2;
      S.altitudeUnit = '万光年';
    }

    if (modules.physics) modules.physics.step(dt);
    if (modules.audio) modules.audio.update(dt);
    if (modules.scene) modules.scene.render(dt);
    if (modules.ui) modules.ui.update(dt);
    if (modules.achievements) modules.achievements.check();

    requestAnimationFrame(frame);
  }

  function start() {
    requestAnimationFrame(frame);
  }

  window.BambooGame = {
    S: S,
    PHASES: PHASES,
    ALTITUDE_MAX: ALTITUDE_MAX,
    bus: bus,
    register: register,
    getModule: getModule,
    clamp: clamp,
    lerp: lerp,
    smoothstep: smoothstep,
    start: start
  };
})();
