/* ============================================================
 * physics.js — 物理模块（fairy 实现）
 *
 * 职责：竹蜻蜓核心物理。搓动加转速、角速度阻尼衰减、起飞判定、
 *       高度爬升/下落、落地结算存档、层级检测、信件解锁、温柔计分。
 *
 * 接口：
 *   init()              初始化：读 localStorage 存档（best/totalFlights）、
 *                       监听 bus 'photo' 事件加积分
 *   step(dt)            每帧推进物理（主循环固定调用）
 *   spin(rps, source)   搓动一次：S.omega += rps*2π*0.9（正增量，节流由调用方负责）
 *                       source: 'mouse'|'touch'|'gesture'|'shake'|'key'
 *   reset()             新一局：清空本局状态，best/totalFlights 保留
 *
 * 事件（emit）：
 *   spin   {rps, source}   搓动
 *   launch {}              起飞（rpm > 300 且未在飞）
 *   landed {}              落地结算（本局结束）
 *   phase  {from, to, index}  层级切换（按 BambooGame.PHASES 阈值）
 *   letter {}              到达月亮高度（≥0.85）解锁信件
 *
 * 事件（监听）：
 *   photo   → 照片收集：按 id 去重并持久化（bamboo_photos 由 physics 统一维护，
 *              ui.js 只发事件和读存储渲染照片馆，不写）+ 本局积分 +50
 *
 * 设计说明：
 * - 阻尼 dω/dt = -(k1·ω + k2·ω²)：k1 线性段负责低速衰减，k2 平方项在高速时
 *   刹住转速。K1=0.08（默认）时 40rps→5rps（=300rpm）约 21.2 秒，落在规格
 *   20-25 秒目标区间（解析解推导见 CONST 注释；若想更短可调回 0.12 约 15s）。
 * - 计分仅在 S.flying 时累积（落地后转速残留不再加分，best 结算才准确）。
 * - letterUnlocked 跨局保留：信解锁过一次就永久拥有（与成就 moon-messenger 一致）。
 * ============================================================ */
(function () {
  'use strict';

  var B = window.BambooGame;
  var S = B.S;

  /* ---------- 调参常量（云可在此集中微调） ---------- */
  var CONST = {
    K1: 0.08,             // 线性阻尼系数（解析解推导：40rps→5rps 用时 = (1/K1)·ln[ω0(K1+K2·ω)/(ω(K1+K2·ω0))]。
                          //   K1=0.12 → 约 15s（偏快）；K1=0.08 → 约 21.2s，落在规格 20-25s 目标区间）
    K2: 0.00018,          // 平方阻尼系数（rad/s 为单位，高转速刹車，防爆表）
    SPIN_EFF: 0.9,        // 搓动效率：omega 增量 = rps * 2π * 0.9
    LAUNCH_RPM: 300,      // 起飞阈值（rpm > 300 且未在飞 → launch）
    LAND_RPM: 600,        // 落地阈值（贴地且 rpm < 600 → landed）
    FULL_RPM: 2400,       // 满爬升率转速（rpm ≥ 此值爬升率封顶，不再更快）
    CLIMB_SPEED: 0.004,   // 满速爬升率（归一高度/s）：持续满速爬升 5 分钟（300s）到达 ALTITUDE_MAX=1.2
                          //   时刻表：0.12 楼顶低空(30s) / 0.36 平流层飞机(90s) / 0.60 月亮(150s) / 1.20 银河(300s)
    FALL_RATE_MIN: -0.5,  // 下落阻尼（最大下沉率 -0.5/s）
    LETTER_ALT: 0.60,     // 信件解锁高度（与 PHASES moon.t 一致，飞到月亮约 5 分钟）
    PHOTO_SCORE: 50,      // 每张照片加分
    LS_BEST: 'bamboo_best',
    LS_FLIGHTS: 'bamboo_total_flights',
    LS_PHOTOS: 'bamboo_photos'  // 已收集照片 id 列表（bamboo_photos 由 physics 统一维护）
  };

  /* ---------- 存档（file:// 下 localStorage 可能被禁用，全部 try/catch） ---------- */
  function loadSave() {
    try {
      var b = localStorage.getItem(CONST.LS_BEST);
      if (b !== null) S.best = parseFloat(b) || 0;
    } catch (e) { /* 静默降级 */ }
    try {
      var t = localStorage.getItem(CONST.LS_FLIGHTS);
      if (t !== null) S.totalFlights = parseInt(t, 10) || 0;
    } catch (e) { /* 静默降级 */ }
  }
  function saveBest() {
    try { localStorage.setItem(CONST.LS_BEST, String(S.best)); } catch (e) { /* 静默 */ }
  }
  function saveFlights() {
    try { localStorage.setItem(CONST.LS_FLIGHTS, String(S.totalFlights)); } catch (e) { /* 静默 */ }
  }

  /* ---------- 照片收集持久化 ----------
   * bamboo_photos 由 physics 统一维护：写入只发生在本模块（savePhotos）。
   * ui.js 只负责发带 id 的 photo 事件，以及读 localStorage('bamboo_photos') 渲染照片馆，不写。
   * photoIds 是内存副本：localStorage 不可用（file:// 隐私模式）时静默降级为纯内存计数，
   * 不持久化但不报错。 */
  var photoIds = [];

  function loadPhotos() {
    try {
      var raw = localStorage.getItem(CONST.LS_PHOTOS);
      var arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr)) photoIds = arr;
    } catch (e) { /* 静默降级：保持内存空数组 */ }
    S.photosCollected = photoIds.length;
  }

  function savePhotos() {
    try { localStorage.setItem(CONST.LS_PHOTOS, JSON.stringify(photoIds)); } catch (e) { /* 静默降级 */ }
  }

  /* ---------- 核心接口 ---------- */

  function init() {
    loadSave();
    loadPhotos();
    // 照片收集：事件总线，跨模块通信（photo 由 ui 层触发，payload: {file, caption, id}）。
    // 计数以 localStorage('bamboo_photos') 的 id 数组长度为唯一来源（去重后写回），
    // 不再是简单 ++；持久化写入统一由 physics 完成（bamboo_photos 由 physics 统一维护）。
    B.bus.on('photo', function (ev) {
      S.score += CONST.PHOTO_SCORE;
      var id = ev && ev.id;
      if (id !== undefined && id !== null && id !== '') {
        if (photoIds.indexOf(id) === -1) {
          photoIds.push(id);
          savePhotos();
        }
        S.photosCollected = photoIds.length;
      } else {
        // 兜底：旧版事件无 id（ui.js 改造前）无法去重/持久化，退化为内存计数
        S.photosCollected++;
      }
    });
  }

  /**
   * 搓动一次。rps 是转速增量（正值），omega += rps*2π*0.9。
   * 注意这是正增量接口：高频输入源（mousemove/touchmove）必须在调用侧节流，
   * 否则一帧灌入多次会把转速顶爆。source 取值 'mouse'|'touch'|'gesture'|'shake'|'key'。
   */
  function spin(rps, source) {
    if (!(rps > 0) || !isFinite(rps)) return;
    // 本局已结束（落地）：再次搓动自动开新局，零操作成本
    if (S.finished) reset();
    S.omega += rps * 2 * Math.PI * CONST.SPIN_EFF;
    S.spinCount++;
    B.bus.emit('spin', { rps: rps, source: source || 'key' });
  }

  /* 当前高度对应的层级下标：取 PHASES 中最后一个 t <= altitude 的层（双向自然） */
  function phaseIndexFor(alt) {
    var idx = 0;
    for (var i = 0; i < B.PHASES.length; i++) {
      if (alt >= B.PHASES[i].t) idx = i;
    }
    return idx;
  }

  function updatePhase() {
    var idx = phaseIndexFor(S.altitude);
    if (idx !== S.phaseIndex) {
      var from = S.phase;
      var to = B.PHASES[idx].id;
      S.phase = to;
      S.phaseIndex = idx;
      B.bus.emit('phase', { from: from, to: to, index: idx });
    }
  }

  /* 落地结算：best 更新 + 累计放飞 + 落盘（必须在 emit('landed') 之前完成） */
  function settle() {
    if (S.score > S.best) {
      S.best = S.score;
      saveBest();
    }
    S.totalFlights++;
    saveFlights();
  }

  function step(dt) {
    if (!(dt > 0)) return;

    /* 1. 角速度阻尼衰减：dω = -(k1·ω + k2·ω²)·dt，不反向 */
    var w = S.omega;
    var dw = -(CONST.K1 * w + CONST.K2 * w * w) * dt;
    S.omega = Math.max(0, w + dw);

    /* 2. 起飞判定（rpm 由主循环每帧从 omega 刷新）。
     * 加 !S.finished 滞回：落地后本局结束，必须 reset() 才能再起飞。
     * 否则 rpm 落在 [300, 600) 区间时会“起飞→落地→再起飞”无限震荡，
     * 每次震荡都结算一次 totalFlights（实测 1 秒内能刷几百次）。 */
    if (S.rpm > CONST.LAUNCH_RPM && !S.flying && !S.finished) {
      S.flying = true;
      S.started = true;
      B.bus.emit('launch', {});
    }

    /* 3. 高度与飞行时间（仅飞行中）
     * 爬升模型（云拍板）：循序渐进、移速固定。
     * rate = CLIMB_SPEED × clamp((rpm-300)/2100, 0, 1)
     * 起飞后即可缓慢爬升（300rpm 时 0，随 rpm 线性到 2400rpm 满速 0.002/s），
     * rpm ≥ 2400 后爬升率封顶恒定，不会因转速爆表而瞬间冲顶。
     * 满速持续爬升：10 分钟到银河尽头（1.2），5 分钟到月亮（0.60）。 */
    if (S.flying) {
      var t01 = B.clamp((S.rpm - CONST.LAUNCH_RPM) / (CONST.FULL_RPM - CONST.LAUNCH_RPM), 0, 1);
      var rate = CONST.CLIMB_SPEED * t01;
      if (rate < CONST.FALL_RATE_MIN) rate = CONST.FALL_RATE_MIN;
      S.altitude = B.clamp(S.altitude + rate * dt, 0, B.ALTITUDE_MAX);
      S.flightTime += dt;
    }

    /* 4. 落地：贴地 + 转速不足 → 本局结束 */
    if (S.flying && S.altitude <= 0 && S.rpm < CONST.LAND_RPM) {
      S.altitude = 0;
      S.flying = false;
      S.finished = true;
      settle();
      B.bus.emit('landed', {});
    }

    /* 5. 层级检测（跨过 PHASES 阈值，升/降都触发） */
    updatePhase();

    /* 6. 信件解锁（月亮高度） */
    if (S.altitude >= CONST.LETTER_ALT && !S.letterUnlocked) {
      S.letterUnlocked = true;
      B.bus.emit('letter', {});
    }

    /* 7. 温柔计分：altitude 与转速共同累积，飞行中才加分 */
    if (S.flying) {
      S.score += (S.altitude * 10 + S.rpm / 1000) * dt * 0.5;
    }
  }

  /* 新一局：清空本局状态，跨局存档（best/totalFlights）与
   * 永久解锁（letterUnlocked/photosCollected）保留 */
  function reset() {
    S.omega = 0;
    S.altitude = 0;
    S.score = 0;
    S.flightTime = 0;
    S.flying = false;
    S.finished = false;
    // phase 归位（不 emit，reset 一般伴随场景重置）
    S.phase = B.PHASES[0].id;
    S.phaseIndex = 0;
  }

  /* ---------- 注册 ---------- */
  B.register('physics', {
    init: init,
    step: step,
    spin: spin,
    reset: reset
  });
})();
