/* ============================================================
 * audio.js — 音频模块（fairy 实现）
 *
 * 职责：纯 WebAudio 实时合成竹蜻蜓桨叶声，零音频文件（硬约束）。
 *       转速驱动一切：f0 = rpm/30 Hz（2 叶片 × rpm/60 的桨叶通过频率 BPF），
 *       基频 + 2 个谐波（2×f0 / 3×f0）过低通模拟桨叶拍气声，
 *       白噪声过 500Hz 高通模拟风噪，rpm<5 时 0.4s 淡出防爆音。
 *
 * 接口：
 *   init()     创建 AudioContext（挂 window.__audioCtx）并构建节点图（静音待命）
 *   unlock()   用户手势后调用：ctx.resume()（自动播放策略解锁）
 *   update(dt) 每帧读取 S.rpm 驱动音高/响度/滤波（主循环固定调用）
 *   dispose()  停止并断开全部节点、关闭 AudioContext
 *
 * 事件：无（纯输出模块）
 *
 * 兼容性：
 * - 经典 script + IIFE，无 ES module；老浏览器回退 webkitAudioContext
 * - AudioContext 创建失败 / 不支持时静默降级（ready=false，update 空转）
 * - 所有参数集中在 CONST，云可在此调音色
 * ============================================================ */
(function () {
  'use strict';

  var B = window.BambooGame;
  var S = B.S;

  /* ---------- 调参常量（音色设计中心） ---------- */
  var CONST = {
    /* 振荡器：基频 sawtooth + 谐波 */
    OSC_TYPE: 'sawtooth',   // 基频波形（桨叶主音）
    HARM2_TYPE: 'square',   // 2×f0 波形
    HARM3_TYPE: 'sawtooth', // 3×f0 波形
    GAIN_F0: 0.30,          // 基频相对权重
    GAIN_H2: 0.15,          // 2 次谐波相对权重
    GAIN_H3: 0.08,          // 3 次谐波相对权重
    OSC_INIT_FREQ: 20,      // 节点初始频率（未起飞前的占位值）

    /* 低通滤波（桨叶声整形） */
    FILTER_BASE: 400,       // cutoff = FILTER_BASE + fCur * FILTER_PER_HZ
    FILTER_PER_HZ: 8,       // 每 1Hz f0 提升的 cutoff
    FILTER_MAX: 6000,       // cutoff 上限
    FILTER_Q: 0.7,

    /* 噪声层（风噪） */
    NOISE_GAIN_MAX: 0.06,   // rpm=3000 时的噪声增益：gain = (rpm/3000)² * 0.06
    NOISE_HP: 500,          // 高通 500Hz，滤掉"轰"的低频直流感
    NOISE_SECONDS: 2,       // 白噪声 buffer 时长（loop）

    /* 响度曲线：rpm<5 静音；5~60 线性 0.05→0.3；60~3000 幂 0.3→0.9 */
    GAIN_IDLE: 0,
    IDLE_RPM: 5,
    GAIN_LOW: 0.05,         // rpm = IDLE_RPM 处
    LOW_RPM: 60,
    GAIN_HIGH: 0.3,         // rpm = LOW_RPM 处
    HIGH_RPM: 3000,
    GAIN_MAX: 0.9,          // rpm ≥ HIGH_RPM 处
    GAIN_POW: 0.7,          // 幂函数指数

    /* 平滑与淡出 */
    SMOOTH_FREQ: 6,         // fCur 指数平滑系数（/s），约 0.17s 跟上转速
    SMOOTH_GAIN: 8,         // 响度指数平滑系数（/s）
    FADE_TIME: 0.4          // 停转（rpm<5）淡出秒数，防爆音
  };

  var ready = false;
  var ctx = null;
  var master = null;
  var filter = null;
  var osc1 = null, osc2 = null, osc3 = null;
  var g1 = null, g2 = null, g3 = null;
  var noise = null, noiseHP = null, noiseGain = null;

  var fCur = 0;      // 平滑后的基频（Hz）
  var gainCur = 0;   // 平滑后的主增益
  var noiseCur = 0;  // 平滑后的噪声增益

  /* ---------- 节点图 ----------
   * osc1(saw, f0) ─┐
   * osc2(sq, 2f0) ─┼→ g1/g2/g3 ─→ lowpass ─┐
   * osc3(saw, 3f0) ─┘                        ├→ master → destination
   * noise(白, loop) → highpass(500) → gn ───┘
   * master.gain = gainCur（统一淡出，防爆音）
   */
  function buildGraph() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;

    if (window.__audioCtx) {
      ctx = window.__audioCtx; // 复用（防止 main.js 重复 init 时叠加）
    } else {
      ctx = new AC();
      window.__audioCtx = ctx;
    }

    master = ctx.createGain();
    master.gain.value = 0; // 先不发声
    master.connect(ctx.destination);

    filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = CONST.FILTER_BASE;
    filter.Q.value = CONST.FILTER_Q;
    filter.connect(master);

    var odefs = [
      { type: CONST.OSC_TYPE, freq: CONST.OSC_INIT_FREQ, g: CONST.GAIN_F0 },
      { type: CONST.HARM2_TYPE, freq: CONST.OSC_INIT_FREQ * 2, g: CONST.GAIN_H2 },
      { type: CONST.HARM3_TYPE, freq: CONST.OSC_INIT_FREQ * 3, g: CONST.GAIN_H3 }
    ];
    var os = [], gs = [];
    for (var i = 0; i < 3; i++) {
      var o = ctx.createOscillator();
      o.type = odefs[i].type;
      o.frequency.value = odefs[i].freq;
      var gn = ctx.createGain();
      gn.gain.value = 0;
      o.connect(gn);
      gn.connect(filter);
      o.start(); // 静音待命（master gain=0），update 只调频率/增益
      os.push(o);
      gs.push(gn);
    }
    osc1 = os[0]; osc2 = os[1]; osc3 = os[2];
    g1 = gs[0]; g2 = gs[1]; g3 = gs[2];

    /* 白噪声 buffer（2 秒 loop） */
    var len = Math.floor(ctx.sampleRate * CONST.NOISE_SECONDS);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var j = 0; j < len; j++) data[j] = Math.random() * 2 - 1;

    noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    noiseHP = ctx.createBiquadFilter();
    noiseHP.type = 'highpass';
    noiseHP.frequency.value = CONST.NOISE_HP;
    noiseGain = ctx.createGain();
    noiseGain.gain.value = 0;
    noise.connect(noiseHP);
    noiseHP.connect(noiseGain);
    noiseGain.connect(master);
    noise.start();

    return true;
  }

  /* ---------- 接口 ---------- */

  function init() {
    try {
      ready = buildGraph();
    } catch (e) {
      ready = false;
      console.warn('[audio] WebAudio 初始化降级:', e);
    }
  }

  /* 必须由用户手势调用（开始按钮/首次触摸），解锁自动播放 */
  function unlock() {
    if (!window.__audioCtx) return;
    try {
      if (window.__audioCtx.state === 'suspended') {
        window.__audioCtx.resume();
      }
    } catch (e) { /* 静默 */ }
  }

  function update(dt) {
    if (!ready || !(dt > 0)) return;
    var rpm = S.rpm || 0;

    /* 音高：f0 = rpm/30 = 2 叶片 × rpm/60（桨叶通过频率 BPF） */
    var f0 = rpm / 30;
    fCur += (f0 - fCur) * Math.min(1, dt * CONST.SMOOTH_FREQ);

    /* 响度目标 */
    var target = 0;
    if (rpm >= CONST.IDLE_RPM) {
      if (rpm < CONST.LOW_RPM) {
        /* 5~60 rpm：0.05 → 0.3 线性 */
        target = CONST.GAIN_LOW +
          (rpm - CONST.IDLE_RPM) * (CONST.GAIN_HIGH - CONST.GAIN_LOW) /
          (CONST.LOW_RPM - CONST.IDLE_RPM);
      } else if (rpm < CONST.HIGH_RPM) {
        /* 60~3000 rpm：0.3 → 0.9 幂函数 */
        var t = (rpm - CONST.LOW_RPM) / (CONST.HIGH_RPM - CONST.LOW_RPM);
        target = CONST.GAIN_HIGH + (CONST.GAIN_MAX - CONST.GAIN_HIGH) * Math.pow(t, CONST.GAIN_POW);
      } else {
        target = CONST.GAIN_MAX;
      }
    }
    /* 平滑：正常跟手（dt*8），停转时 0.4s 淡出防爆音 */
    var k = (rpm < CONST.IDLE_RPM)
      ? Math.min(1, dt / CONST.FADE_TIME)
      : Math.min(1, dt * CONST.SMOOTH_GAIN);
    gainCur += (target - gainCur) * k;

    /* 噪声层：rpm² 曲线，平滑系数同上 */
    var nTarget = Math.pow(Math.min(rpm / CONST.HIGH_RPM, 1), 2) * CONST.NOISE_GAIN_MAX;
    noiseCur += (nTarget - noiseCur) * k;

    /* 应用（谐波跟随 fCur 整数倍） */
    var f = Math.max(fCur, 0.5);
    osc1.frequency.value = f;
    osc2.frequency.value = f * 2;
    osc3.frequency.value = f * 3;
    g1.gain.value = gainCur * CONST.GAIN_F0;
    g2.gain.value = gainCur * CONST.GAIN_H2;
    g3.gain.value = gainCur * CONST.GAIN_H3;
    filter.frequency.value = Math.min(
      CONST.FILTER_BASE + fCur * CONST.FILTER_PER_HZ, CONST.FILTER_MAX);
    noiseGain.gain.value = noiseCur;
    master.gain.value = gainCur;
  }

  function dispose() {
    ready = false;
    try {
      function stop(node) {
        if (!node) return;
        try { node.stop(); } catch (e) { /* 已停止 */ }
        try { node.disconnect(); } catch (e) { /* 已断开 */ }
      }
      stop(noise); stop(osc1); stop(osc2); stop(osc3);
      if (window.__audioCtx) {
        try { window.__audioCtx.close(); } catch (e) { /* 已关闭 */ }
        window.__audioCtx = null;
      }
    } catch (e) { /* 静默 */ }
    ctx = master = filter = osc1 = osc2 = osc3 = g1 = g2 = g3 = null;
    noise = noiseHP = noiseGain = null;
    fCur = gainCur = noiseCur = 0;
  }

  /* ---------- 注册 ---------- */
  B.register('audio', {
    init: init,
    unlock: unlock,
    update: update,
    dispose: dispose
  });
})();
