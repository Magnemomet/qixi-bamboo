/* ============================================================
 * achievements.js — 成就模块（fairy 实现）
 *
 * 职责：12 个成就的定义、进度检查、解锁广播与 localStorage 持久化。
 *       解锁后 bus.emit('achievement', {id, name, desc, icon})，
 *       UI（toast 等）监听该事件展示；已解锁的成就不会重复广播。
 *
 * 接口：
 *   init()         从 localStorage('bamboo_achievements') 载入已解锁 id 数组
 *   check()        每帧检查一次条件（主循环固定调用，未解锁才判，开销极小）
 *   list()         返回全部成就定义数组（浅拷贝）
 *   isUnlocked(id) 是否已解锁
 *
 * 持久化：localStorage('bamboo_achievements') = JSON 字符串数组（file:// 下
 *         被禁用时 try/catch 静默降级为仅内存记录）。
 *
 * 数据来源全部读 BambooGame.S（唯一状态源），不直接依赖其他模块。
 * ============================================================ */
(function () {
  'use strict';

  var B = window.BambooGame;
  var S = B.S;

  var LS_KEY = 'bamboo_achievements';

  /* ---------- 成就定义（id / name / desc / icon / 解锁条件） ---------- */
  var DEFS = [
    { id: 'first-launch',    name: '初次起飞',     desc: '竹蜻蜓第一次离开地面',                     icon: '🎋',
      test: function () { return S.flying; } },
    { id: 'tree-top',        name: '树梢之上',     desc: '飞越树梢，看一眼远处的城市',               icon: '🌿',
      test: function () { return S.altitude >= 0.05; } },
    { id: 'through-cloud',   name: '穿过云层',     desc: '一头扎进软绵绵的积云',                     icon: '☁️',
      test: function () { return S.altitude >= 0.15; } },
    { id: 'stratosphere',    name: '平流层漫步',   desc: '平流层很安静，只有风声',                   icon: '✈️',
      test: function () { return S.altitude >= 0.35; } },
    { id: 'out-of-atmo',     name: '冲出大气层',   desc: '大气层的边缘，星星更亮了',                 icon: '🚀',
      test: function () { return S.altitude >= 0.5; } },
    { id: 'star-sea',        name: '星海漫游',     desc: '在星星的海洋里漂一会儿',                   icon: '✨',
      test: function () { return S.altitude >= 0.7; } },
    { id: 'moon-messenger',  name: '月亮信使',     desc: '到达月亮，那里有一封信在等你',             icon: '🌙',
      test: function () { return S.altitude >= 0.85; } },
    { id: 'galaxy-end',      name: '银河尽头',     desc: '再远一点，就是银河的尽头',                 icon: '🌌',
      test: function () { return S.altitude >= 1.05; } },
    { id: 'fast-spin',       name: '风驰电掣',     desc: '转速飙到 2400 转/分',                     icon: '💨',
      test: function () { return S.rpm >= 2400; } },
    { id: 'gentle-driver',   name: '浪漫驾驶',     desc: '单局飞行超过 120 秒，慢慢来',             icon: '🕊️',
      test: function () { return S.flightTime >= 120; } },
    { id: 'collector',       name: '回忆收集者',   desc: '收集 5 张沿途的照片',                     icon: '📷',
      test: function () { return S.photosCollected >= 5; } },
    { id: 'come-back',       name: '熟悉的感觉',   desc: '累计放飞 3 次，这里永远欢迎你回来',       icon: '🌸',
      test: function () { return S.totalFlights >= 3; } }
  ];

  /* ---------- 内部状态 ---------- */
  var unlocked = [];      // 已解锁 id 数组（保持解锁顺序）
  var unlockedMap = {};   // id → true 快速查询

  /* ---------- 持久化 ---------- */
  function load() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var arr = JSON.parse(raw);
        if (Object.prototype.toString.call(arr) === '[object Array]') {
          unlocked = arr.filter(function (id) { return typeof id === 'string'; });
        }
      }
    } catch (e) {
      unlocked = []; // 存储被禁用：降级为内存记录
    }
    unlockedMap = {};
    for (var i = 0; i < unlocked.length; i++) unlockedMap[unlocked[i]] = true;
  }

  function save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(unlocked));
    } catch (e) { /* 静默降级 */ }
  }

  function unlock(def) {
    unlocked.push(def.id);
    unlockedMap[def.id] = true;
    save();
    B.bus.emit('achievement', {
      id: def.id, name: def.name, desc: def.desc, icon: def.icon
    });
  }

  /* ---------- 接口 ---------- */
  function init() { load(); }

  function check() {
    for (var i = 0; i < DEFS.length; i++) {
      var d = DEFS[i];
      if (unlockedMap[d.id]) continue; // 已解锁不重复 emit
      var ok = false;
      try { ok = d.test(); } catch (e) { ok = false; }
      if (ok) unlock(d);
    }
  }

  function list() { return DEFS.slice(); }

  function isUnlocked(id) { return !!unlockedMap[id]; }

  /* ---------- 注册 ---------- */
  B.register('achievements', {
    init: init,
    check: check,
    list: list,
    isUnlocked: isUnlocked
  });
})();
