/* ============================================================
 * auth.js — 进入密码页（仪式性保护，防君子不防小人）
 *
 * 说明：
 * - 纯前端鉴权无法真正保护资源文件（懂技术的人可直接访问
 *   assets/photos/ 下的 URL），它挡住的是通过网页链接进入的
 *   普通访问者，给礼物加一层"暗号"仪式感。
 * - 密码不存明文：代码里只存 SHA-256 哈希（AUTH_PASS_HASH）。
 * - 解锁成功后 localStorage 记录时间戳，24 小时内免密。
 * ============================================================ */
(function () {
  'use strict';

  var G = window.BambooGame;
  if (!G) { console.error('[auth] BambooGame 未加载'); return; }

  /* 云设定密码后，把下方 SHA-256 换成新密码的哈希。
   * 生成方法：在浏览器 console 执行
   *   crypto.subtle.digest('SHA-256', new TextEncoder().encode('你的密码'))
   *     .then(h => console.log([...new Uint8Array(h)].map(b => b.toString(16).padStart(2,'0')).join('')))
   */
  /* 密码哈希（云设定 2026-08-19）：hjx5201314 的 SHA-256 */
  var AUTH_PASS_HASH = 'fbcb5440cbaf38ef227a5cf6be9acd7b6e9dd7f93c24a808b8153173ee664724';
  var AUTH_KEY = 'bamboo_auth';
  var AUTH_TTL = 24 * 3600 * 1000; // 24 小时免密

  function $(id) { return document.getElementById(id); }

  function sha256(str) {
    if (window.crypto && crypto.subtle && crypto.subtle.digest) {
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (buf) {
        return Array.prototype.map.call(new Uint8Array(buf), function (b) {
          return ('0' + b.toString(16)).slice(-2);
        }).join('');
      });
    }
    // 降级：FNV-1a 简单摘要（仅 file:// 老环境）
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return Promise.resolve('fnv' + h.toString(16));
  }

  function isAuthed() {
    try {
      var ts = parseInt(localStorage.getItem(AUTH_KEY) || '0', 10);
      return ts > 0 && (Date.now() - ts) < AUTH_TTL;
    } catch (e) { return false; }
  }

  function showStart() {
    var ps = $('password-screen');
    if (ps) {
      ps.classList.add('fade-out');
      setTimeout(function () { ps.classList.add('hidden'); }, 800);
    }
    var ss = $('start-screen');
    if (ss) ss.classList.remove('hidden');
  }

  function init() {
    // 未解锁：隐藏开始界面，停留在密码页
    if (!isAuthed()) {
      var ss0 = $('start-screen');
      if (ss0) ss0.classList.add('hidden');
    }
    // 已解锁且在有效期内 → 直接进开始界面
    if (isAuthed()) {
      showStart();
      return;
    }
    var input = $('password-input');
    var btn = $('btn-password');
    var err = $('password-error');
    if (!input || !btn) return;

    function check() {
      var v = (input.value || '').trim();
      if (!v) return;
      sha256(v).then(function (h) {
        if (AUTH_PASS_HASH && h === AUTH_PASS_HASH) {
          try { localStorage.setItem(AUTH_KEY, String(Date.now())); } catch (e) {}
          err.classList.add('hidden');
          showStart();
        } else {
          err.classList.remove('hidden');
          input.value = '';
          input.focus();
        }
      });
    }

    btn.addEventListener('click', check);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') check();
    });
    input.focus();
  }

  G.register('auth', { init: init });
})();
