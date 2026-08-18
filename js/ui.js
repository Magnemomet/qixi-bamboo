/* ============================================================
 * ui.js — HUD / 层级横幅 / 照片卡 / 成就提示 / 信笺的 DOM 交互
 *
 * 设计哲学：温柔克制，不施压
 *   - HUD 始终可见但不闪烁
 *   - 横幅 2.5s 后自动淡出
 *   - 照片 8s 后淡出
 *   - 成就 4s 后淡出
 *   - 信笺全屏覆盖，点击信笺外任意处关闭
 *
 * DOM 元素已在 index.html 中预留，class 'show'/'hidden' 控制显隐
 *
 * 接口：{init(), update(dt)}
 * ============================================================ */
(function () {
  'use strict';

  var BG = window.BambooGame;
  if (!BG) { console.error('[ui] BambooGame 未加载'); return; }

  // ========== DOM 引用 ==========
  var dom = {};

  // ========== 计时器 ==========
  var bannerTimer = null;
  var photoTimer = null;
  var toastTimer = null;
  var letterCloseHandler = null;
  // 本局已展示的照片 id（每局每张最多一次，跨局可重温）
  var shownPhotos = [];

  // ========== 工具 ==========
  function $(id) { return document.getElementById(id); }

  function show(el) {
    if (!el) return;
    el.classList.remove('hidden');
    // 触发重排以激活 transition
    void el.offsetWidth;
    el.classList.add('show');
  }

  function hide(el, afterMs, doHidden) {
    if (!el) return;
    el.classList.remove('show');
    if (doHidden !== false) {
      setTimeout(function () { el.classList.add('hidden'); }, afterMs || 700);
    }
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // 信笺文本 → <p> 分段（空行作为段落分隔）
  // 以「——」或「- 」开头的短行视为落款，右对齐
  function renderLetterText(text) {
    if (!text) return '';
    var lines = String(text).split('\n');
    var html = '';
    var inPara = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var trimmed = line.trim();
      if (!trimmed) {
        inPara = false;
        continue;
      }
      // 落款：以破折号开头且较短
      var isEnd = /^[——\-\u2014\u2013\s]*[^\s]/.test(trimmed) &&
                  (trimmed.indexOf('——') >= 0 || /^(——|-|—)/.test(trimmed)) &&
                  trimmed.length <= 20;
      if (isEnd) {
        html += '<p class="letter-end">' + escapeHtml(trimmed) + '</p>';
        inPara = false;
      } else {
        html += '<p>' + escapeHtml(trimmed) + '</p>';
        inPara = true;
      }
    }
    return html;
  }

  // ========== 事件处理 ==========
  function onPhase(d) {
    if (!dom.banner) return;
    var idx = d && d.index;
    if (idx == null) return;
    var ph = BG.PHASES[idx];
    if (!ph) return;

    dom.banner.textContent = ph.name;
    show(dom.banner);

    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(function () {
      hide(dom.banner, 900);
    }, 2500);

    // 照片回忆触发：进入新层级时，找出该层级本局未展示的照片，稍候浮现
    var photos = BG.PHOTOS || [];
    for (var i = 0; i < photos.length; i++) {
      var p = photos[i];
      if (p.phase === ph.id && shownPhotos.indexOf(p.id) < 0) {
        shownPhotos.push(p.id);
        (function (pp) {
          setTimeout(function () {
            BG.bus.emit('photo', { file: pp.file, caption: pp.caption });
          }, 900);
        })(p);
        break;
      }
    }
  }

  function onPhoto(d) {
    if (!dom.photoCard || !dom.photoImg || !dom.photoCaption) return;
    var file = d && d.file;
    if (!file) return;
    var caption = (d && d.caption) || '';

    dom.photoImg.src = 'assets/photos/' + file;
    dom.photoImg.alt = caption || '回忆';
    dom.photoCaption.textContent = caption;

    show(dom.photoCard);

    if (photoTimer) clearTimeout(photoTimer);
    photoTimer = setTimeout(function () {
      hide(dom.photoCard, 700);
    }, 8000);
  }

  function onAchievement(d) {
    if (!dom.toast || !dom.toastTitle || !dom.toastDesc) return;
    var name = d && d.name;
    if (!name) return;
    var desc = (d && d.desc) || '';
    var icon = (d && d.icon) || '🏆';

    var iconEl = dom.toast.querySelector('.toast-icon');
    if (iconEl) iconEl.textContent = icon;
    dom.toastTitle.textContent = name;
    dom.toastDesc.textContent = desc;

    show(dom.toast);

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      hide(dom.toast, 600);
    }, 4000);
  }

  function onLanded() {
    if (!dom.toast || !dom.toastTitle || !dom.toastDesc) return;
    var iconEl = dom.toast.querySelector('.toast-icon');
    if (iconEl) iconEl.textContent = '🎋';
    dom.toastTitle.textContent = '竹蜻蜓落回地面了';
    dom.toastDesc.textContent = '再搓一次，还能飞得更高。';

    show(dom.toast);

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      hide(dom.toast, 600);
    }, 4000);
  }

  function onLetter(d) {
    if (!dom.letterOverlay || !dom.letterContent) return;

    // 优先用 event data，其次读 BambooGame.LETTER_TEXT
    var text = '';
    if (d && d.text) text = d.text;
    else if (BG.LETTER_TEXT) {
      text = BG.LETTER_TEXT.text || BG.LETTER_TEXT.body ||
             BG.LETTER_TEXT.content || BG.LETTER_TEXT;
    }
    if (!text) return;

    dom.letterContent.innerHTML = renderLetterText(text);
    show(dom.letterOverlay);
  }

  function hideLetter() {
    if (!dom.letterOverlay) return;
    dom.letterOverlay.classList.remove('show');
    setTimeout(function () {
      dom.letterOverlay.classList.add('hidden');
    }, 1000);
  }

  function onInputStatus(d) {
    if (!dom.gestureHint) return;
    if (d && d.gesture) {
      show(dom.gestureHint);
    } else {
      hide(dom.gestureHint, 0, false);
      dom.gestureHint.classList.add('hidden');
    }
  }

  // ========== 初始化 ==========
  function init() {
    dom = {
      btnStart:        $('btn-start'),
      hud:             $('hud'),
      hudAlt:          $('hud-altitude-km'),
      hudRpm:          $('hud-rpm'),
      hudScore:        $('hud-score'),
      hudBest:         $('hud-best'),
      hudPhase:        $('hud-phase'),
      banner:          $('phase-banner'),
      photoCard:       $('photo-card'),
      photoImg:        $('photo-img'),
      photoCaption:    $('photo-caption'),
      toast:           $('toast'),
      toastTitle:      $('toast-title'),
      toastDesc:       $('toast-desc'),
      gestureHint:     $('gesture-hint'),
      letterOverlay:   $('letter-overlay'),
      letterContent:   $('letter-content')
    };

    // 开始按钮：只发事件，游戏启动逻辑由 main.js 处理
    if (dom.btnStart) {
      dom.btnStart.addEventListener('click', function () {
        BG.bus.emit('game-start', {});
      });
    }

    // 信笺点击外部关闭
    if (dom.letterOverlay) {
      letterCloseHandler = function (e) {
        if (e.target === dom.letterOverlay) {
          hideLetter();
        }
      };
      dom.letterOverlay.addEventListener('click', letterCloseHandler);
    }

    // 事件总线订阅
    BG.bus.on('phase', onPhase);
    BG.bus.on('photo', onPhoto);
    BG.bus.on('achievement', onAchievement);
    BG.bus.on('landed', onLanded);
    BG.bus.on('letter', onLetter);
    BG.bus.on('input-status', onInputStatus);

    // best 从 localStorage 读取（如未在 main 里读）
    try {
      var raw = localStorage.getItem('bamboo_best');
      var best = parseInt(raw || '0', 10);
      if (!isNaN(best) && best > (BG.S.best || 0)) BG.S.best = best;
    } catch (e) { /* localStorage 可能不可用 */ }
  }

  // ========== 每帧更新 ==========
  function update(dt) {
    if (!dom.hud) return;

    // 游戏开始后显示 HUD
    if (BG.S.started && dom.hud.classList.contains('hidden')) {
      dom.hud.classList.remove('hidden');
    }

    // 数值
    var altKm = BG.S.altitudeKm || 0;
    var altUnit = BG.S.altitudeUnit || 'km';
    if (dom.hudAlt) {
      dom.hudAlt.textContent = altKm < 10 ? altKm.toFixed(1) : Math.round(altKm);
    }
    var altUnitEl = dom.hudAlt && dom.hudAlt.parentNode ? dom.hudAlt.parentNode.querySelector('small') : null;
    if (altUnitEl) altUnitEl.textContent = altUnit;
    if (dom.hudRpm) dom.hudRpm.textContent = Math.round(BG.S.rpm || 0);
    if (dom.hudScore) dom.hudScore.textContent = Math.round(BG.S.score || 0);
    if (dom.hudBest) dom.hudBest.textContent = Math.round(BG.S.best || 0);

    // 当前层级
    var phIdx = BG.S.phaseIndex || 0;
    var ph = BG.PHASES[phIdx];
    if (ph && dom.hudPhase) dom.hudPhase.textContent = ph.name;
  }

  BG.register('ui', {
    init: init,
    update: update
  });
})();