/* ============================================================
 * ui.js — HUD / 层级横幅 / 照片卡 / 成就提示 / 信笺 / 收藏馆的 DOM 交互
 *
 * 设计哲学：温柔克制，不施压
 *   - HUD 始终可见但不闪烁
 *   - 横幅 2.5s 后自动淡出
 *   - 照片 8s 后淡出
 *   - 成就 4s 后淡出
 *   - 信笺全屏覆盖，点击信笺外任意处关闭
 *   - 成就馆 / 照片馆：点击外部或 × 或 ESC 关闭，打开时重渲染
 *
 * 收藏数据来源：
 *   - 成就：BG.achievements.list() + isUnlocked(id) + localStorage('bamboo_achievements')
 *   - 照片：BG.PHOTOS（20 张） + localStorage('bamboo_photos'，新 key)
 *   - 信重看：S.letterUnlocked === true → 复用 letter overlay
 *
 * DOM 元素已在 index.html 中预留，class 'show'/'hidden' 控制显隐
 *
 * 接口：{init(), update(dt)}
 * ============================================================ */
(function () {
  'use strict';

  var BG = window.BambooGame;
  if (!BG) { console.error('[ui] BambooGame 未加载'); return; }
  var S = BG.S;

  // ========== DOM 引用 ==========
  var dom = {};

  // ========== 计时器 ==========
  var bannerTimer = null;
  var photoTimer = null;
  var toastTimer = null;
  var letterCloseHandler = null;
  // 本局已展示的照片 id（每局每张最多一次，跨局可重温）
  var shownPhotos = [];

  // ========== 收藏馆常量 ==========
  // 已收集照片的 localStorage key（JSON id 数组，新 key）
  var LS_PHOTOS = 'bamboo_photos';

  // PHASES 名称查表（按 phase id 查中文名，用来提示「月亮层 · 未解锁」）
  function phaseName(phaseId) {
    var arr = BG.PHASES || [];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].id === phaseId) return arr[i].name;
    }
    return phaseId || '';
  }

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

  /* ---------- 收藏馆数据读写（照片已收集集合） ---------- */
  function loadCollectedPhotos() {
    try {
      var raw = localStorage.getItem(LS_PHOTOS);
      if (raw) {
        var arr = JSON.parse(raw);
        if (Object.prototype.toString.call(arr) === '[object Array]') {
          // 仅保留数字或字符串 id
          return arr.filter(function (v) { return typeof v === 'number' || typeof v === 'string'; });
        }
      }
    } catch (e) { /* 静默降级 */ }
    return [];
  }

  function saveCollectedPhotos(arr) {
    try { localStorage.setItem(LS_PHOTOS, JSON.stringify(arr)); } catch (e) { /* 静默 */ }
  }

  // 记录一张新照片已收集（id 去重；S.photosCollected 以本函数为权威）
  function markPhotoCollected(id) {
    var arr = loadCollectedPhotos();
    var key = String(id);
    var exists = false;
    for (var i = 0; i < arr.length; i++) {
      if (String(arr[i]) === key) { exists = true; break; }
    }
    if (!exists) {
      arr.push(id);
      saveCollectedPhotos(arr);
    }
    // 以本 UI 为准：photosCollected 计数统一为 localStorage 数组长度。
    // physics.js 仍在 on('photo') 里 photosCollected++，但 emit 是同步调用链：
    // 物理先 +1，本函数随后覆盖为数组长度，同一 emit 结束后二者一致；
    // 跨局场景下以 localStorage 为权威，避免累计偏差。physics.js 未修改。
    S.photosCollected = arr.length;
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
            // payload 增加 id 字段，供 UI 在 onPhoto 里写入 localStorage('bamboo_photos')
            BG.bus.emit('photo', { id: pp.id, file: pp.file, caption: pp.caption });
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
    var pid = (d && d.id);

    // 记录已收集照片：payload 带 id 时直接写；以本 UI 为权威同步 photosCollected。
    // 若 payload 缺 id（旧版兼容），则按 file 反查 PHOTOS。
    if (pid == null) {
      var photos = BG.PHOTOS || [];
      for (var i = 0; i < photos.length; i++) {
        if (photos[i].file === file) { pid = photos[i].id; break; }
      }
    }
    if (pid != null) markPhotoCollected(pid);

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
    openLetter(d);
  }

  // 打开信笺：被初次解锁（bus 'letter'）与照片馆“信重看”按钮复用
  function openLetter(d) {
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

  // ========== 收藏馆：渲染 / 打开 / 关闭 ==========

  // 读取已收集照片 id 数组（以 localStorage 为准）
  function isPhotoUnlocked(id) {
    var arr = loadCollectedPhotos();
    var key = String(id);
    for (var i = 0; i < arr.length; i++) {
      if (String(arr[i]) === key) return true;
    }
    return false;
  }

  // 渲染成就馆网格（每次打开都重渲染）
  function renderAchievementGallery() {
    var grid = $('achievement-grid');
    if (!grid) return;
    var ach = BG.getModule('achievements');
    var all = (ach && typeof ach.list === 'function') ? ach.list() : [];
    var html = '';
    for (var i = 0; i < all.length; i++) {
      var a = all[i];
      var unlocked = ach && typeof ach.isUnlocked === 'function' ? ach.isUnlocked(a.id) : false;
      var cls = unlocked ? 'achievement-card is-unlocked' : 'achievement-card is-locked';
      html += '<div class="' + cls + '">'
            +   '<div class="ac-icon">' + escapeHtml(a.icon || '🏆') + '</div>'
            +   '<div class="ac-name">' + escapeHtml(a.name) + '</div>'
            +   '<div class="ac-desc">' + (unlocked ? escapeHtml(a.desc) : '未解锁') + '</div>'
            + '</div>';
    }
    grid.innerHTML = html;
  }

  // 渲染照片馆：信卡（顶部） + 20 张照片网格
  function renderPhotoGallery() {
    // 信卡：未解锁 → 灰、按钮禁用；已解锁 → 可点重看
    var card = $('photo-letter-card');
    var desc = $('photo-letter-desc');
    var btn = $('photo-letter-btn');
    if (card && desc && btn) {
      if (S.letterUnlocked) {
        card.classList.remove('is-locked');
        card.classList.add('is-unlocked');
        desc.textContent = '重温那封信';
        btn.textContent = '重看';
        btn.disabled = false;
      } else {
        card.classList.remove('is-unlocked');
        card.classList.add('is-locked');
        desc.textContent = '飞到月亮解锁';
        btn.textContent = '未解锁';
        btn.disabled = true;
      }
    }

    var grid = $('photo-grid');
    if (!grid) return;
    var photos = BG.PHOTOS || [];
    var html = '';
    for (var i = 0; i < photos.length; i++) {
      var p = photos[i];
      var unlocked = isPhotoUnlocked(p.id);
      var cls = unlocked ? 'photo-card is-unlocked' : 'photo-card is-locked';
      var thumb;
      if (unlocked) {
        thumb = '<div class="pc-thumb" style="background-image:url(\'assets/photos/' + escapeHtml(p.file) + '\')"></div>';
      } else {
        thumb = '<div class="pc-thumb">🔒</div>';
      }
      var phaseLabel = phaseName(p.phase);
      var nameText = unlocked ? p.caption : (phaseLabel + ' · 未解锁');
      html += '<div class="' + cls + '">'
            +   thumb
            +   '<div class="pc-name">' + escapeHtml(nameText) + '</div>'
            +   '<div class="pc-phase">' + escapeHtml(phaseLabel) + '</div>'
            + '</div>';
    }
    grid.innerHTML = html;
  }

  // 打开馆
  function openGallery(which) {
    if (which === 'achievements') {
      renderAchievementGallery();
      show(dom.galleryAchievements);
    } else if (which === 'photos') {
      renderPhotoGallery();
      show(dom.galleryPhotos);
    }
  }

  // 关闭馆
  function closeGallery(which) {
    if (which === 'achievements' && dom.galleryAchievements) {
      hide(dom.galleryAchievements, 550);
    } else if (which === 'photos' && dom.galleryPhotos) {
      hide(dom.galleryPhotos, 550);
    } else {
      // ESC 全部关闭
      if (dom.galleryAchievements) hide(dom.galleryAchievements, 550);
      if (dom.galleryPhotos) hide(dom.galleryPhotos, 550);
    }
  }

  // 点击 overlay 背景关闭（点在 inner 区域不关）
  function bindGalleryBackdropClose(overlay, which) {
    if (!overlay) return;
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeGallery(which);
    });
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
      btnStart:            $('btn-start'),
      hud:                 $('hud'),
      hudAlt:              $('hud-altitude-km'),
      hudRpm:              $('hud-rpm'),
      hudScore:            $('hud-score'),
      hudBest:             $('hud-best'),
      hudPhase:            $('hud-phase'),
      banner:              $('phase-banner'),
      photoCard:           $('photo-card'),
      photoImg:            $('photo-img'),
      photoCaption:        $('photo-caption'),
      toast:               $('toast'),
      toastTitle:          $('toast-title'),
      toastDesc:           $('toast-desc'),
      gestureHint:         $('gesture-hint'),
      letterOverlay:       $('letter-overlay'),
      letterContent:       $('letter-content'),
      galleryAchievements: $('gallery-achievements'),
      galleryPhotos:       $('gallery-photos')
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

    // ---------- 收藏馆事件绑定 ----------
    // 打开入口（开始界面 + HUD 右上的两个图标）
    var openers = document.querySelectorAll('[data-gallery-open]');
    for (var oi = 0; oi < openers.length; oi++) {
      (function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          openGallery(btn.getAttribute('data-gallery-open'));
        });
      })(openers[oi]);
    }
    // 关闭按钮（×）：data-gallery-close 直接指明关闭哪个馆
    var closers = document.querySelectorAll('[data-gallery-close]');
    for (var ci = 0; ci < closers.length; ci++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          closeGallery(btn.getAttribute('data-gallery-close'));
        });
      })(closers[ci]);
    }
    // 点击 overlay 背景关闭
    bindGalleryBackdropClose(dom.galleryAchievements, 'achievements');
    bindGalleryBackdropClose(dom.galleryPhotos, 'photos');

    // 信重看按钮
    var letterBtn = $('photo-letter-btn');
    if (letterBtn) {
      letterBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!S.letterUnlocked) return; // 未解锁不响应
        openLetter({}); // 从 LETTER_TEXT 取文本
      });
    }

    // ESC 关闭任意馆
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' || e.keyCode === 27) {
        var anyOpen = false;
        if (dom.galleryAchievements && dom.galleryAchievements.classList.contains('show')) anyOpen = true;
        if (dom.galleryPhotos && dom.galleryPhotos.classList.contains('show')) anyOpen = true;
        if (anyOpen) closeGallery();
      }
    });

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

    // photosCollected 与 localStorage 同步（以本 UI 为权威）
    var collectedArr = loadCollectedPhotos();
    S.photosCollected = collectedArr.length;
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