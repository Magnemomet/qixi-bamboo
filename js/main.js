/* ============================================================
 * main.js — 装配与启动
 * 页面加载：读取持久化 → 初始化各模块（音频/物理/场景/UI/成就）
 * game-start（用户点击开始）：解锁音频 → 初始化输入（摄像头授权需用户手势）
 *   → 启动主循环 → 显示 HUD
 * ============================================================ */
(function () {
  'use strict';

  var G = window.BambooGame;
  var S = G.S;
  var doc = document;

  /* ---------- 持久化状态恢复 ---------- */
  try {
    S.best = parseInt(localStorage.getItem('bamboo_best') || '0', 10) || 0;
    S.totalFlights = parseInt(localStorage.getItem('bamboo_total_flights') || '0', 10) || 0;
  } catch (e) { /* file:// 下 localStorage 异常则静默 */ }

  /* ---------- 初始化（页面加载即执行，主循环等待 game-start） ---------- */
  function init() {
    var auth = G.getModule('auth');
    var physics = G.getModule('physics');
    var audio = G.getModule('audio');
    var scene = G.getModule('scene');
    var bamboo = G.getModule('bamboo');
    var world = G.getModule('world');
    var ui = G.getModule('ui');
    var achievements = G.getModule('achievements');

    if (auth && auth.init) auth.init();
    if (physics) physics.init();
    if (audio) audio.init();
    if (scene) scene.init(doc.getElementById('game-container'));
    if (bamboo && bamboo.init) bamboo.init();
    if (world && world.init) world.init();
    if (ui) ui.init();
    if (achievements) achievements.init();
  }

  /* ---------- 开始游戏 ---------- */
  G.bus.on('game-start', function () {
    var audio = G.getModule('audio');
    var input = G.getModule('input');

    if (audio && audio.unlock) { try { audio.unlock(); } catch (e) {} }
    if (input && !input._inited) {
      try { input.init(); input._inited = true; } catch (e) { console.warn('input init failed:', e); }
    }

    S.started = true;

    var ss = doc.getElementById('start-screen');
    if (ss) {
      ss.classList.add('fade-out');
      setTimeout(function () { ss.classList.add('hidden'); }, 900);
    }
    var hud = doc.getElementById('hud');
    if (hud) hud.classList.remove('hidden');

    G.start();
  });

  /* ---------- 窗口尺寸 ---------- */
  window.addEventListener('resize', function () {
    var scene = G.getModule('scene');
    if (scene && scene.resize) scene.resize();
  });

  init();
})();
