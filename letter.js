/* =====================================================================
   letter.js — letter.html（彩花ちゃんへの手紙）專用。
   頁首（只有品牌字標與語言切換）、頁尾與語言切換和首頁一樣（文字來自 data.js），信的內容來自 letter-data.js。
   - 只用 textContent / createElement 寫入資料，不用 innerHTML
   - localStorage 的讀寫都包在 try/catch 裡（和首頁共用同一個語言設定）
   - 不依賴任何第三方程式庫
   ===================================================================== */
(function () {
  'use strict';

  var DATA = window.SITE_DATA;
  var LETTER = window.LETTER_DATA;
  if (!DATA || !LETTER) {
    // data.js／letter-data.js 載入失敗或有語法錯誤：和 app.js 一樣改套 nojs.css，
    // 只留下提示與字標，不顯示空白的便箋。改完文字請先跑 node --test。
    var fallback = document.createElement('link');
    fallback.rel = 'stylesheet';
    fallback.href = 'nojs.css';
    document.head.appendChild(fallback);
    return;
  }

  // 被別的網站用 iframe 嵌入時：和 app.js 一樣，只留下一個開啟連結（說明見 SECURITY.md）
  if (window.top !== window.self) {
    try { window.top.location.replace(window.location.href); } catch (e) { /* 跨來源且沒有 user activation 時會失敗 */ }
    var body = document.body;
    while (body.firstChild) { body.removeChild(body.firstChild); }
    var notice = document.createElement('p');
    notice.className = 'framed-notice';
    notice.textContent = DATA.ui.framedNotice.ja + '／' + DATA.ui.framedNotice.zh;
    var link = document.createElement('a');
    link.className = 'framed-notice__link';
    link.href = window.location.href;
    link.target = '_top';
    link.rel = 'noopener noreferrer';
    link.textContent = DATA.ui.framedOpen.ja + '／' + DATA.ui.framedOpen.zh;
    body.appendChild(notice);
    body.appendChild(link);
    return;
  }

  var LANGS = ['ja', 'zh'];
  var HTML_LANG = { ja: 'ja', zh: 'zh-Hant' };
  var doc = document;
  var state = { lang: 'ja' };

  /* ---------- 小工具（和 app.js 相同） ---------- */
  function t(obj) {
    if (obj == null) { return ''; }
    if (typeof obj === 'string') { return obj; }
    if (obj[state.lang] != null) { return String(obj[state.lang]); }
    return obj.ja != null ? String(obj.ja) : '';
  }
  function ui(key) { return t(DATA.ui[key]); }
  function fill(template, params) {
    return String(template).replace(/\{(\w+)\}/g, function (m, k) {
      return params && Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m;
    });
  }
  function el(tag, className, text) {
    var node = doc.createElement(tag);
    if (className) { node.className = className; }
    if (text != null) { node.textContent = text; }
    return node;
  }
  function clear(node) { while (node.firstChild) { node.removeChild(node.firstChild); } }
  function qs(sel, root) { return (root || doc).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || doc).querySelectorAll(sel)); }
  function setText(id, text) { var node = doc.getElementById(id); if (node) { node.textContent = text; } }

  function formatDate(str) {
    if (!str) { return ui('dateUnknown'); }
    var parts = String(str).split('-').map(Number);
    var y = parts[0], m = parts[1], d = parts[2];
    if (state.lang === 'zh') { return y + ' 年 ' + m + ' 月 ' + d + ' 日'; }
    return y + '年' + m + '月' + d + '日';
  }

  function loadLang() {
    try {
      var saved = window.localStorage.getItem(DATA.site.storageKey);
      if (LANGS.indexOf(saved) !== -1) { return saved; }
    } catch (e) { /* 無痕模式或被封鎖時會失敗，忽略即可 */ }
    return LANGS.indexOf(DATA.site.defaultLang) !== -1 ? DATA.site.defaultLang : 'ja';
  }
  function saveLang(lang) {
    try { window.localStorage.setItem(DATA.site.storageKey, lang); } catch (e) { /* 忽略 */ }
  }

  /* ---------- 頁首、頁尾（和首頁相同的文字） ---------- */
  function renderChrome() {
    doc.documentElement.lang = HTML_LANG[state.lang];
    doc.title = t(LETTER.title);
    var meta = qs('meta[name="description"]');
    if (meta) { meta.setAttribute('content', t(LETTER.description)); }

    qsa('[data-ui]').forEach(function (node) { node.textContent = ui(node.getAttribute('data-ui')); });
    qsa('[data-ui-aria-label]').forEach(function (node) { node.setAttribute('aria-label', ui(node.getAttribute('data-ui-aria-label'))); });
    qsa('[data-hero]').forEach(function (node) { node.textContent = t(DATA.hero[node.getAttribute('data-hero')]); });
    qsa('.lang-switch__btn').forEach(function (btn) {
      btn.setAttribute('aria-pressed', btn.getAttribute('data-lang') === state.lang ? 'true' : 'false');
    });

    setText('footer-disclaimer', t(DATA.footer.disclaimer));
    setText('footer-updated', fill(ui('footerUpdated'), { date: formatDate(DATA.site.lastUpdated) }));
  }

  /* ---------- 手紙本文 ---------- */
  function appendParagraphs(box, list) {
    (list || []).forEach(function (p) { box.appendChild(el('p', 'letter__p', t(p))); });
  }

  function renderLetter() {
    setText('letter-title', t(LETTER.heading));
    setText('letter-lead', t(LETTER.lead));
    setText('letter-salutation', t(LETTER.salutation));
    setText('letter-date', t(LETTER.signoff));
    setText('letter-signature', t(LETTER.signature));
    setText('letter-back', t(LETTER.backLink));

    var body = qs('#letter-body');
    if (!body) { return; }
    clear(body);
    (LETTER.sections || []).forEach(function (section) {
      var sec = el('section', 'letter__section');
      sec.id = 'letter-' + section.id;
      var headingId = sec.id + '-heading';
      sec.setAttribute('aria-labelledby', headingId);
      var h = el('h2', 'letter__h', t(section.heading));
      h.id = headingId;
      sec.appendChild(h);

      appendParagraphs(sec, section.paragraphs);

      // 當時「準備過的日文」：原文照放，中文版也保留日文（標 lang="ja"）
      if (section.words && section.words.length) {
        var ul = el('ul', 'letter__words');
        ul.setAttribute('role', 'list');
        ul.setAttribute('lang', 'ja');
        section.words.forEach(function (w) {
          // 一句可以是字串，或是「幾小塊」的陣列：每一塊不會被拆到兩行，換行只發生在塊和塊之間
          var li = el('li', 'letter__word');
          if (Array.isArray(w)) {
            w.forEach(function (chunk) { li.appendChild(el('span', 'letter__chunk', String(chunk))); });
          } else {
            li.textContent = String(w);
          }
          ul.appendChild(li);
        });
        sec.appendChild(ul);
      }

      appendParagraphs(sec, section.paragraphsAfter);

      if (section.link && section.link.href) {
        var p = el('p', 'letter__link');
        var a = el('a', 'link-arrow', t(section.link.label));
        a.href = String(section.link.href);
        p.appendChild(a);
        sec.appendChild(p);
      }
      body.appendChild(sec);
    });
  }

  function renderAll() {
    renderChrome();
    renderLetter();
  }

  function setLang(lang) {
    if (LANGS.indexOf(lang) === -1 || lang === state.lang) { return; }
    state.lang = lang;
    saveLang(lang);
    renderAll();
  }

  function init() {
    state.lang = loadLang();
    qsa('.lang-switch__btn').forEach(function (btn) {
      btn.addEventListener('click', function () { setLang(btn.getAttribute('data-lang')); });
    });
    renderAll();
  }

  if (doc.readyState === 'loading') { doc.addEventListener('DOMContentLoaded', init); } else { init(); }
}());
