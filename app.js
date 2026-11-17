/* =====================================================================
   app.js — 把 data.js 的內容畫到畫面上、語言切換、生日倒數、相簿（活動照片＋視訊回憶）燈箱、分享按鈕。
   - 只用 textContent / createElement 寫入資料，不用 innerHTML
   - localStorage 的讀寫都包在 try/catch 裡
   - 不依賴任何第三方程式庫
   ===================================================================== */
(function () {
  'use strict';

  var DATA = window.SITE_DATA;
  var Countdown = window.AyakaCountdown;
  var Share = window.AyakaShare;   // share.js；沒載到時只會藏起分享按鈕，其他功能照常
  if (!DATA || !Countdown) {
    // data.js／countdown.js 載入失敗或有語法錯誤（例如少一個逗號）：改套 nojs.css，
    // 只留下字標與主視覺照片，不顯示空膠囊、「0 0 0 0」倒數格和空區塊。改完 data.js 請先跑 node --test。
    var fallback = document.createElement('link');
    fallback.rel = 'stylesheet';
    fallback.href = 'nojs.css';
    document.head.appendChild(fallback);
    return;
  }

  // 被別的網站用 iframe 嵌入時：GitHub Pages 無法設定 X-Frame-Options／frame-ancestors，
  // 而且瀏覽器不允許跨來源 iframe 在沒有使用者互動時導向最上層，所以改成「把內容藏起來，只留一個開啟連結」。
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

  // 「生日當天」的預覽開關（#birthday-preview）只在本機預覽時有效：正式站上任何人都能貼的「假生日」連結不會生效
  var LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname) || window.location.protocol === 'file:';
  function wantsBirthdayPreview() { return LOCAL && window.location.hash === '#birthday-preview'; }

  var state = {
    lang: 'ja',
    photoGroup: 0,           // 燈箱目前顯示的照片組（GROUPS 的索引）
    photoIndex: -1,          // 燈箱目前顯示的照片（組內索引）；-1 表示關閉
    lastFocus: null,         // 開燈箱前的焦點元素，關閉後要還回去
    fallbackOpen: false,     // 瀏覽器不支援 dialog.showModal 時的備援模式
    birthdayPreview: wantsBirthdayPreview(),
    countdownState: null,
    shareStatus: null        // 分享按鈕旁的狀態：null、{ kind: 'copied' } 或 { kind: 'manual', url }
  };

  /* ---------- 小工具 ---------- */
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
  /** 把一句話依「、」「，」切成幾小塊放進 node：換行只發生在逗號之後，不會把詞拆到兩行（文字本身完全不變） */
  function setPhrases(node, text) {
    clear(node);
    (String(text).match(/[^、，]+[、，]?|[、，]/g) || []).forEach(function (chunk) {
      node.appendChild(el('span', 'phrase', chunk));
    });
  }
  function qs(sel, root) { return (root || doc).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || doc).querySelectorAll(sel)); }
  function photoAlt(photo) { return state.lang === 'zh' ? (photo.alt_zh || photo.alt_ja || '') : (photo.alt_ja || photo.alt_zh || ''); }
  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  /** 'YYYY-MM-DD' / 'YYYY-MM' / 'YYYY' → 日文或中文日期；null → 「日付：確認中／日期：待補」 */
  function formatDate(str) {
    if (!str) { return ui('dateUnknown'); }
    var parts = String(str).split('-').map(Number);
    var y = parts[0], m = parts[1], d = parts[2];
    if (state.lang === 'zh') {
      if (parts.length === 1) { return y + ' 年'; }
      if (parts.length === 2) { return y + ' 年 ' + m + ' 月'; }
      return y + ' 年 ' + m + ' 月 ' + d + ' 日';
    }
    if (parts.length === 1) { return y + '年'; }
    if (parts.length === 2) { return y + '年' + m + '月'; }
    return y + '年' + m + '月' + d + '日';
  }

  /* ---------- 出處與外部連結 ----------
     每一筆公開資料的 sources: ['代號'] 對應 data.js 最下面的 sources（來源名稱、網址、刊登日期、查證日期）。 */
  var SOURCES = DATA.sources || {};

  /** 外部連結：新分頁開啟，一律加 rel="noopener noreferrer"（SECURITY.md）。只接受 https:// 的網址，其他只顯示文字。
      hidden 是只唸給螢幕閱讀器聽的補充（例如歌名），讓文字相同的連結分得出來。 */
  function extLink(url, text, hidden) {
    if (!/^https:\/\//.test(String(url))) { return el('span', null, text); }
    var a = el('a', 'ext-link', text);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.appendChild(el('span', 'visually-hidden', (hidden ? '（' + hidden + '）' : '') + ui('newTab')));
    return a;
  }

  /** 來源的顯示文字：「ORICON NEWS（2025年9月12日）」；沒有刊登日期的（官方網站的常設頁面等）只顯示名稱 */
  function sourceText(src) {
    var name = t(src.name);
    return src.published ? fill(ui('sourceDated'), { name: name, date: formatDate(src.published) }) : name;
  }
  function sourceLink(id, hidden) {
    var src = SOURCES[id];
    return src ? extLink(src.url, sourceText(src), hidden) : null;
  }

  /** 把「項目 → 出處」畫成清單（items：[{ label, sources }]）。出處完全相同的項目合併成一列：
      「名前・生年月日・出身地・血液型：ORICON NEWS（2020年）」。沒有任何出處時，整個 <details> 隱藏。 */
  function renderSources(list, items) {
    if (!list) { return; }
    clear(list);
    var groups = [], byKey = {};
    items.forEach(function (item) {
      var ids = (item.sources || []).filter(function (id) { return SOURCES[id]; });
      if (!ids.length) { return; }
      var key = ids.join('|');
      if (!byKey[key]) { byKey[key] = { ids: ids, labels: [] }; groups.push(byKey[key]); }
      if (byKey[key].labels.indexOf(item.label) === -1) { byKey[key].labels.push(item.label); }
    });
    var joiner = state.lang === 'zh' ? '、' : '・';
    groups.forEach(function (group) {
      var li = el('li', 'sources__item');
      li.appendChild(el('span', 'sources__for', group.labels.join(joiner) + '：'));
      group.ids.forEach(function (id, i) {
        if (i) { li.appendChild(doc.createTextNode('、')); }
        li.appendChild(sourceLink(id));
      });
      list.appendChild(li);
    });
    if (list.parentNode && list.parentNode.tagName === 'DETAILS') { list.parentNode.hidden = !groups.length; }
  }

  /* ---------- 語言：讀取／儲存（都包 try/catch） ---------- */
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

  /* ---------- 靜態文字：data-ui / data-hero / aria-label ---------- */
  function renderStaticText() {
    doc.documentElement.lang = HTML_LANG[state.lang];
    doc.title = t(DATA.site.title);
    var meta = qs('meta[name="description"]');
    if (meta) { meta.setAttribute('content', t(DATA.site.description)); }

    qsa('[data-ui]').forEach(function (node) {
      node.textContent = ui(node.getAttribute('data-ui'));
    });
    qsa('[data-ui-aria-label]').forEach(function (node) {
      node.setAttribute('aria-label', ui(node.getAttribute('data-ui-aria-label')));
    });
    qsa('[data-hero]').forEach(function (node) {
      var key = node.getAttribute('data-hero');
      var value = t(DATA.hero[key]);
      if (key === 'slogan') { setPhrases(node, value); } else { node.textContent = value; }
      if (node.hasAttribute('hidden') || key === 'sloganNote') { node.hidden = !value; }
    });

    qsa('.lang-switch__btn').forEach(function (btn) {
      btn.setAttribute('aria-pressed', btn.getAttribute('data-lang') === state.lang ? 'true' : 'false');
    });
    renderRoomEntry();
  }

  /* ---------- 「合言葉のページ」的入口：data.js 的 site.roomUrl 有填（而且是 https 網址）才顯示 ----------
     那是另一個網站（backend/ 裡的訪客端）；這裡只放連結，並把目前的語言帶過去 */
  function renderRoomEntry() {
    var entry = doc.getElementById('room-entry');
    if (!entry) { return; }
    var link = qs('a', entry);
    var target = null;
    try {
      var parsed = new URL(String(DATA.site.roomUrl || ''));
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) { target = parsed; }
    } catch (e) { /* 沒填或不是網址：不顯示 */ }
    if (!target || !link) { entry.hidden = true; return; }
    target.searchParams.set('lang', state.lang);
    link.href = target.href;
    entry.hidden = false;
  }

  /* ---------- 圖片：WebP 版本（<picture>）----------
     photos/ayaka-01.jpg → photos/ayaka-01-480.webp / -800.webp / -1024.webp / -full.webp（scripts/make_images.py 產生） */
  function webpSrcset(photo) {
    var stem = String(photo.src).replace(/\.jpe?g$/i, '');
    var parts = [stem + '-480.webp 480w', stem + '-800.webp 800w', stem + '-1024.webp 1024w'];
    if (photo.width) { parts.push(stem + '-full.webp ' + photo.width + 'w'); }
    return parts.join(', ');
  }
  function applyWebpSource(source, photo, sizes) {
    if (!source) { return; }
    if (DATA.site.webp) {
      source.setAttribute('type', 'image/webp');
      source.setAttribute('srcset', webpSrcset(photo));
      if (sizes) { source.setAttribute('sizes', sizes); }
    } else {
      source.removeAttribute('srcset');
      source.removeAttribute('sizes');
    }
  }
  var SIZES_GALLERY = '(min-width: 1100px) 340px, (min-width: 700px) 30vw, 46vw';
  var SIZES_GALLERY_FIRST = '(min-width: 1100px) 340px, (min-width: 700px) 30vw, 92vw';   // 699px 以下第一格是整寬
  // 主視覺：欄寬在 720～1099px 是 360～420px（.hero__inner 的 minmax(360px, 0.9fr)），橫向手機兩欄約 41vw，
  // 直向手機照片佔滿欄寬（約 92vw），高度上限 48vh、超出的部分上下裁切。這裡仍寫 min(92vw, 40vh)：
  // 比實際寬度略小，DPR 3 的手機因此挑 1024px 而不是 1280px 的檔案（最多放大 6%，檔案小三成）。
  // index.html 的 <source sizes> 也是同一句，調整 .hero__inner 欄寬時兩處要一起改
  var SIZES_HERO = '(min-width: 1100px) 460px, (min-width: 720px) clamp(360px, 41vw, 460px), (min-width: 560px) and (orientation: landscape) 41vw, min(92vw, 40vh)';
  // 燈箱：4:5 的直式照片扣掉上下列後約佔 85vh 高，寬度約 68vh；桌機不必抓 full 尺寸
  var SIZES_LIGHTBOX = 'min(100vw, 68vh)';

  /* ---------- 首頁主視覺 ---------- */
  function renderHero() {
    var img = qs('#hero-img');
    var photo = DATA.hero.photo;
    if (img && photo) {
      if (img.getAttribute('src') !== photo.src) { img.setAttribute('src', photo.src); }
      if (photo.width) { img.setAttribute('width', photo.width); }
      if (photo.height) { img.setAttribute('height', photo.height); }
      img.setAttribute('alt', photoAlt(photo));
      applyWebpSource(qs('#hero-source'), photo, SIZES_HERO);
    }
    var caption = qs('#hero-caption');
    if (caption) {
      caption.textContent = photo && photo.date ? fill(ui('photoCaptionDate'), { date: formatDate(photo.date) }) : '';
    }
  }

  /* ---------- 個人資料 ---------- */
  function renderProfile() {
    var list = qs('#profile-list');
    if (!list) { return; }
    clear(list);
    // 還沒確認的欄位（value 是 null）留在 data.js 裡，但不顯示：頁面上只有查證過的資料
    var rows = DATA.profile.filter(function (row) { return row.value != null; });
    rows.forEach(function (row) {
      var wrap = el('div', 'profile__row');
      wrap.appendChild(el('dt', 'profile__label', t(row.label)));
      var dd = el('dd', 'profile__value', t(row.value));
      // 內容是另一種語言的原文（例如中文版裡的日文自我介紹用語）：標上語言，螢幕閱讀器才會用對的發音
      if (row.lang && HTML_LANG[row.lang] && row.lang !== state.lang) { dd.setAttribute('lang', HTML_LANG[row.lang]); }
      if (row.showAge && state.countdownState) {
        var age = state.countdownState.age;
        var sep = state.lang === 'zh' ? '\u00a0' : '';
        dd.appendChild(el('span', 'profile__age', '（' + age + sep + ui('ageSuffix') + '）'));
      }
      wrap.appendChild(dd);
      list.appendChild(wrap);
    });
    renderHobbies();
    // 出處：個人資料每一列，加上「興趣」小區塊
    var items = rows.map(function (row) { return { label: t(row.label), sources: row.sources }; });
    var hobbies = DATA.hobbies || {};
    if ((hobbies.items || []).length) { items.push({ label: ui('hobbiesTitle'), sources: hobbies.sources }); }
    renderSources(qs('#profile-sources-list'), items);
  }

  /** 個人資料下面的小區塊：有年份的興趣（data.js 的 hobbies）。沒有資料時整塊隱藏 */
  function renderHobbies() {
    var box = qs('#profile-hobbies'), list = qs('#hobbies-list');
    if (!box || !list) { return; }
    clear(list);
    var items = (DATA.hobbies && DATA.hobbies.items) || [];
    box.hidden = !items.length;
    items.forEach(function (item) {
      var wrap = el('div', 'profile__row');
      wrap.appendChild(el('dt', 'profile__label', t(item.label)));
      wrap.appendChild(el('dd', 'profile__value', t(item.text)));
      list.appendChild(wrap);
    });
  }

  /* ---------- 生日倒數 ---------- */
  function computeState() {
    var now = Date.now();
    var birthday = DATA.site.birthday;
    if (state.birthdayPreview) {
      // 預覽模式：假裝現在是今年生日當天的中午（用來檢查版面）
      var jstNow = Countdown.jstParts(now);
      now = Countdown.jstMidnightMs(jstNow.year, birthday.month, birthday.day) + 12 * 3600 * 1000;
    }
    return Countdown.computeBirthdayState(now, birthday);
  }

  function renderBirthdayText() {
    var s = state.countdownState;
    if (!s) { return; }
    var lead = qs('#birthday-lead');
    var until = qs('#birthday-until');
    var greeting = qs('#birthday-greeting');
    var greetingLead = qs('#birthday-greeting-lead');
    if (lead) { lead.textContent = ui('birthdayLead'); }
    if (until) { until.textContent = fill(ui('birthdayUntil'), { age: s.nextAge }); }
    if (greeting) { greeting.textContent = ui('birthdayToday'); }
    if (greetingLead) { greetingLead.textContent = fill(ui('birthdayTodayLead'), { age: s.age }); }
    var countdown = qs('#countdown');
    if (countdown) { countdown.setAttribute('aria-label', ui('countdownLabel')); }
  }

  function tick() {
    var s = computeState();
    var wasBirthday = state.countdownState ? state.countdownState.isBirthday : null;
    var prevAge = state.countdownState ? state.countdownState.age : null;
    state.countdownState = s;

    var box = qs('#birthday-countdown');
    var today = qs('#birthday-today');
    if (box) { box.hidden = s.isBirthday; }
    if (today) { today.hidden = !s.isBirthday; }

    if (!s.isBirthday) {
      var nums = { days: s.days, hours: pad2(s.hours), minutes: pad2(s.minutes), seconds: pad2(s.seconds) };
      qsa('#countdown [data-unit]').forEach(function (node) {
        var v = String(nums[node.getAttribute('data-unit')]);
        if (node.textContent !== v) { node.textContent = v; }
      });
    }
    // 跨過生日或年齡變了（例如頁面開著跨日）就更新相關文字
    if (wasBirthday !== s.isBirthday || prevAge !== s.age) {
      renderBirthdayText();
      renderProfile();
    }
  }

  function startClock() {
    tick();
    // 每 250ms 檢查一次、只在數字真的變了才改 DOM，秒數才不會因為主執行緒忙碌而跳格
    window.setInterval(tick, 250);
    doc.addEventListener('visibilitychange', function () {
      if (doc.visibilityState === 'visible') { tick(); }
    });
  }

  /* ---------- 年表 ---------- */
  function renderTimeline() {
    var list = qs('#timeline-list');
    if (!list) { return; }
    clear(list);
    DATA.timeline.forEach(function (item) {
      var li = el('li', 'timeline__item');
      if (item.placeholder) {
        li.className += ' timeline__item--placeholder';
        li.appendChild(el('p', 'timeline__placeholder', ui('timelinePlaceholder')));
        list.appendChild(li);
        return;
      }
      var date = el('time', 'timeline__date', formatDate(item.date));
      if (item.date) { date.setAttribute('datetime', item.date); } else { date.className += ' timeline__date--unknown'; }
      li.appendChild(date);
      li.appendChild(el('h3', 'timeline__title', t(item.title)));
      var note = t(item.note);
      var work = item.link ? workById(item.link) : null;
      if (note || work) {
        var p = el('p', 'timeline__note', note);
        if (work) {
          // 連到「作品」區的那一首歌；兩筆年表的連結文字相同，用 aria-label 補上歌名
          var a = el('a', 'timeline__link', ui('timelineWorkLink'));
          a.href = '#work-' + work.id;
          a.setAttribute('aria-label', ui('timelineWorkLink') + '：' + t(work.title));
          if (note) { p.appendChild(doc.createTextNode(' ')); }   // 空格：連結接在同一行時留一點距離，換到下一行時會自動消失
          p.appendChild(a);
        }
        li.appendChild(p);
      }
      list.appendChild(li);
    });
    renderSources(qs('#timeline-sources-list'), DATA.timeline.filter(function (item) { return !item.placeholder; }).map(function (item) {
      return { label: formatDate(item.date), sources: item.sources };
    }));
  }

  /* ---------- 作品與訪談 ---------- */
  function workById(id) {
    return (DATA.works || []).filter(function (work) { return work.id === id; })[0] || null;
  }

  /** 一則條目：標題（h4）、小字說明、內文、連結列。年表的連結會跳到條目，所以條目可以接收焦點（tabindex="-1"） */
  function buildEntry(title, metas, texts, links) {
    var item = el('article', 'entry');
    item.tabIndex = -1;
    item.appendChild(el('h4', 'entry__title', title));
    metas.forEach(function (meta) { if (meta) { item.appendChild(el('p', 'entry__meta', meta)); } });
    texts.forEach(function (text) { if (text) { item.appendChild(el('p', 'entry__text', text)); } });
    var row = el('p', 'entry__links');
    links.forEach(function (link) { if (link) { row.appendChild(link); } });
    if (row.firstChild) { item.appendChild(row); }
    return item;
  }

  function renderWorks() {
    var list = qs('#works-list');
    if (!list) { return; }
    clear(list);
    (DATA.works || []).forEach(function (work) {
      var title = t(work.title);
      var official = SOURCES[work.official];
      var links = [official ? extLink(official.url, ui('workOfficial'), title) : null];
      (work.sources || []).forEach(function (id) { links.push(sourceLink(id, title)); });
      var item = buildEntry(title, [t(work.members), t(work.release)], [t(work.text)], links);
      item.id = 'work-' + work.id;
      list.appendChild(item);
    });
  }

  function renderInterviews() {
    var list = qs('#interviews-list');
    if (!list) { return; }
    clear(list);
    (DATA.interviews || []).forEach(function (item) {
      var links = (item.sources || []).map(function (id) { return sourceLink(id); });
      list.appendChild(buildEntry(t(item.title), [], [t(item.text), t(item.more)], links));
    });
  }

  /* ---------- 相簿：兩組照片（活動照片、視訊回憶），各自有格子與日期說明，燈箱在組內循環 ---------- */
  var callPhotos = DATA.callPhotos || {};
  var GROUPS = [
    // firstWide：699px 以下第一張整寬（styles.css 的 .gallery__item:first-child），sizes 要用 92vw 那組
    // dateEl：整組同一天時，日期只在這裡寫一次（第一組用「{date} 撮影」這句，第二組只寫日期，接在小標後面）
    { grid: '#gallery-grid', idPrefix: 'gallery', firstWide: true, photos: DATA.photos || [], date: null, captionKey: 'photoCaptionDate', dateEl: '#gallery-date', dateKey: 'photoCaptionDate' },
    // wrap：整組的外層（小標＋日期＋說明）；photos 為空時整個隱藏。idPrefix：每格說明與日期的 id 前綴。第二組第一張不全寬（J-06）
    { grid: '#gallery-grid-call', idPrefix: 'gallery-call', wrap: '#gallery-call', photos: callPhotos.items || [], date: callPhotos.date || null, captionKey: 'callPhotoCaptionDate', dateEl: '#gallery-call-date' }
  ];
  function photoDate(group, photo) { return photo.date || group.date; }
  /** 整組照片都是同一天就回傳那個日期，否則回傳 null（那時每張底下各自顯示日期） */
  function sharedDate(group) {
    var first = group.photos.length ? photoDate(group, group.photos[0]) : null;
    if (!first) { return null; }
    return group.photos.every(function (photo) { return photoDate(group, photo) === first; }) ? first : null;
  }
  function photoCaption(group, photo) {
    var date = photoDate(group, photo);
    return date ? fill(ui(group.captionKey), { date: formatDate(date) }) : '';
  }

  /* 格子只建立一次，切換語言時只更新文字 */
  function buildGallery() {
    GROUPS.forEach(function (group, groupIndex) { buildGrid(group, groupIndex); });
  }
  function buildGrid(group, groupIndex) {
    var grid = qs(group.grid);
    if (!grid) { return; }
    var wrap = group.wrap ? qs(group.wrap) : null;
    if (wrap) { wrap.hidden = !group.photos.length; }
    clear(grid);
    group.photos.forEach(function (photo, index) {
      var li = el('li', 'gallery__item');
      var btn = el('button', 'gallery__btn');
      btn.type = 'button';
      btn.setAttribute('data-group', String(groupIndex));
      btn.setAttribute('data-index', String(index));
      var frame = el('div', 'gallery__frame');
      var picture = el('picture');
      var source = el('source');
      applyWebpSource(source, photo, group.firstWide && index === 0 ? SIZES_GALLERY_FIRST : SIZES_GALLERY);
      var img = el('img', 'gallery__img');
      img.setAttribute('src', photo.src);
      img.setAttribute('loading', 'lazy');
      img.setAttribute('decoding', 'async');
      if (photo.width) { img.setAttribute('width', photo.width); }
      if (photo.height) { img.setAttribute('height', photo.height); }
      img.setAttribute('alt', '');
      if (DATA.site.webp) { picture.appendChild(source); }
      picture.appendChild(img);
      frame.appendChild(picture);
      btn.appendChild(frame);
      // 按鈕的無障礙名稱只來自下方的說明一次（圖片 alt 仍保留，給沒有 CSS 時用）；
      // 說明本身標成 aria-hidden，螢幕閱讀器才不會把同一句唸兩遍。日期放進按鈕的描述
      // （整組同一天時，畫面上每格的日期用 CSS 收起來，但仍是按鈕的描述，螢幕閱讀器照樣唸得到）。
      // id 以組別區分（gallery-caption-1、gallery-call-caption-1），兩組才不會撞名。
      var capId = group.idPrefix + '-caption-' + (index + 1);
      var dateId = group.idPrefix + '-date-' + (index + 1);
      btn.setAttribute('aria-labelledby', capId);
      btn.setAttribute('aria-describedby', 'gallery-hint ' + dateId);
      btn.addEventListener('click', function () { openLightbox(groupIndex, index, btn); });
      li.appendChild(btn);
      var caption = el('p', 'gallery__caption');
      caption.setAttribute('aria-hidden', 'true');
      var capText = el('span', 'gallery__caption-text');
      capText.id = capId;
      caption.appendChild(capText);
      var dateEl = el('span', 'gallery__date');
      dateEl.id = dateId;
      caption.appendChild(dateEl);
      li.appendChild(caption);
      grid.appendChild(li);
    });
  }

  function renderGalleryText() {
    var hint = qs('#gallery-hint');
    if (hint) { hint.textContent = ui('galleryOpen'); }
    GROUPS.forEach(function (group) {
      qsa(group.grid + ' .gallery__item').forEach(function (item) {
        var btn = qs('.gallery__btn', item);
        var photo = group.photos[Number(btn.getAttribute('data-index'))];
        if (!photo) { return; }
        var alt = photoAlt(photo);
        qs('.gallery__img', btn).setAttribute('alt', alt);
        qs('.gallery__caption-text', item).textContent = alt;
        qs('.gallery__date', item).textContent = photoCaption(group, photo);
      });
    });
    // 每組的日期：整組同一天時只在格子上方寫一次，每格底下的日期收起來（.gallery--dated）；
    // 之後同一組放進不同日期的照片時，每格會改回各自顯示日期
    GROUPS.forEach(function (group) {
      var grid = qs(group.grid);
      var dateEl = group.dateEl ? qs(group.dateEl) : null;
      var shared = sharedDate(group);
      var headDate = shared || group.date || null;   // 第二組有整組的預設日期（callPhotos.date）
      if (grid) { grid.classList.toggle('gallery--dated', !!(shared && dateEl)); }
      if (!dateEl) { return; }
      dateEl.hidden = !headDate;
      dateEl.textContent = !headDate ? '' : (group.dateKey ? fill(ui(group.dateKey), { date: formatDate(headDate) }) : formatDate(headDate));
      if (dateEl.tagName === 'TIME') {
        if (headDate) { dateEl.setAttribute('datetime', headDate); } else { dateEl.removeAttribute('datetime'); }
      }
    });
  }

  /* ---------- 燈箱 ---------- */
  var lightbox = qs('#lightbox');
  var lbImg = qs('#lightbox-img');

  function showPhoto(groupIndex, index) {
    var group = GROUPS[groupIndex];
    var total = group ? group.photos.length : 0;
    if (!total) { return; }
    index = ((index % total) + total) % total;   // 在同一組內循環
    state.photoGroup = groupIndex;
    state.photoIndex = index;
    var photo = group.photos[index];
    applyWebpSource(qs('#lightbox-source'), photo, SIZES_LIGHTBOX);
    if (lbImg.getAttribute('src') !== photo.src) { lbImg.setAttribute('src', photo.src); }
    if (photo.width) { lbImg.setAttribute('width', photo.width); }
    if (photo.height) { lbImg.setAttribute('height', photo.height); }
    lbImg.setAttribute('alt', photoAlt(photo));
    qs('#lightbox-caption').textContent = photoAlt(photo);
    qs('#lightbox-date').textContent = photoCaption(group, photo);
    qs('#lightbox-counter').textContent = fill(ui('lightboxCounter'), { current: index + 1, total: total });
    announcePhoto();
    // 先把前後兩張抓進快取，切換時才不會等：用和 <picture> 相同的 srcset／sizes，
    // 瀏覽器會挑和燈箱一樣的尺寸（支援 WebP 的瀏覽器抓 WebP）
    [index + 1, index - 1].forEach(function (i) {
      var p = group.photos[((i % total) + total) % total];
      if (!p || p.src === photo.src) { return; }
      var pre = new Image();
      if (DATA.site.webp && supportsWebp()) {
        pre.sizes = SIZES_LIGHTBOX;
        pre.srcset = webpSrcset(p);
      } else {
        pre.src = p.src;
      }
    });
  }

  // 螢幕閱讀器用的宣告（aria-live）：換照片時唸出「9枚中3枚目：…」，文字來自 data.js；張數以目前的組為準
  function announcePhoto() {
    var status = qs('#lightbox-status');
    var group = GROUPS[state.photoGroup];
    var photo = group ? group.photos[state.photoIndex] : null;
    if (!status || !photo) { return; }
    status.textContent = fill(ui('lightboxAnnounce'), { current: state.photoIndex + 1, total: group.photos.length, caption: photoAlt(photo) });
  }

  var webpSupport = null;
  function supportsWebp() {
    if (webpSupport === null) {
      try {
        var c = doc.createElement('canvas');
        webpSupport = !!(c.getContext && c.getContext('2d')) && c.toDataURL('image/webp').indexOf('data:image/webp') === 0;
      } catch (e) { webpSupport = false; }
    }
    return webpSupport;
  }

  function openLightbox(groupIndex, index, trigger) {
    if (!lightbox) { return; }
    state.lastFocus = trigger || doc.activeElement;
    showPhoto(groupIndex, index);
    doc.body.classList.add('is-locked');
    if (typeof lightbox.showModal === 'function') {
      if (!lightbox.open) { lightbox.showModal(); }
    } else {
      state.fallbackOpen = true;
      lightbox.setAttribute('open', '');
    }
    lightbox.focus();   // 焦點放在 dialog 本身：會唸出標籤，也不會在點按時出現焦點框
    announcePhoto();    // 開啟前 dialog 還是隱藏的，顯示之後再寫一次宣告區才會被唸出來
  }

  function closeLightbox() {
    if (!lightbox) { return; }
    if (state.fallbackOpen) {
      lightbox.removeAttribute('open');
      state.fallbackOpen = false;
      onLightboxClosed();
    } else if (lightbox.open) {
      lightbox.close();   // 會觸發 close 事件 → onLightboxClosed
    }
  }

  function onLightboxClosed() {
    doc.body.classList.remove('is-locked');
    state.photoIndex = -1;
    var back = state.lastFocus;
    state.lastFocus = null;
    if (back && typeof back.focus === 'function' && doc.contains(back)) { back.focus(); }
  }

  function stepPhoto(delta) {
    if (state.photoIndex < 0) { return; }
    showPhoto(state.photoGroup, state.photoIndex + delta);
  }

  function setupLightbox() {
    if (!lightbox) { return; }
    lightbox.addEventListener('close', onLightboxClosed);
    qs('#lightbox-close').addEventListener('click', closeLightbox);
    qs('#lightbox-prev').addEventListener('click', function () { stepPhoto(-1); });
    qs('#lightbox-next').addEventListener('click', function () { stepPhoto(1); });

    lightbox.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { e.preventDefault(); stepPhoto(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); stepPhoto(-1); }
      else if (e.key === 'Escape' && state.fallbackOpen) { e.preventDefault(); closeLightbox(); }
      else if (e.key === 'Tab') { trapFocus(e); }   // Tab 在燈箱內循環，不會跑到瀏覽器介面
    });

    // 點在照片以外的暗色區域就關閉
    lightbox.addEventListener('click', function (e) {
      if (e.target === lightbox || e.target === qs('#lightbox-stage') || e.target.classList.contains('lightbox__figure')) {
        closeLightbox();
      }
    });

    // 觸控滑動切換
    var touchX = null, touchY = null;
    var stage = qs('#lightbox-stage');
    stage.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) { touchX = null; return; }
      touchX = e.touches[0].clientX; touchY = e.touches[0].clientY;
    }, { passive: true });
    stage.addEventListener('touchend', function (e) {
      if (touchX == null || !e.changedTouches.length) { return; }
      var dx = e.changedTouches[0].clientX - touchX;
      var dy = e.changedTouches[0].clientY - touchY;
      touchX = null;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) { stepPhoto(dx < 0 ? 1 : -1); }
    }, { passive: true });
  }

  function trapFocus(e) {
    var focusables = qsa('button, [href], [tabindex]:not([tabindex="-1"])', lightbox).filter(function (n) { return !n.disabled; });
    if (!focusables.length) { return; }
    var first = focusables[0], last = focusables[focusables.length - 1];
    // 剛開啟時焦點在 dialog 本身：Shift+Tab 也要留在燈箱裡（落在最後一顆按鈕），不跑到瀏覽器介面
    if (e.shiftKey && (doc.activeElement === first || doc.activeElement === lightbox)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* ---------- 應援留言、關於、頁尾 ---------- */
  function renderMessages() {
    var list = qs('#messages-list');
    if (!list) { return; }
    clear(list);
    var messages = DATA.messages || [];
    list.hidden = !messages.length;   // 目前沒有留言：這一區只有「給彩花的信」的入口小卡
    var other = state.lang === 'zh' ? 'ja' : 'zh';
    var from = ui('messageFrom');
    messages.forEach(function (msg) {
      var li = el('li', 'message');
      li.appendChild(el('p', 'message__text', t(msg)));
      if (msg[other]) {   // 日中對照：另一種語言用小字顯示
        var sub = el('p', 'message__text message__text--sub', msg[other]);
        sub.setAttribute('lang', HTML_LANG[other]);
        li.appendChild(sub);
      }
      if (from) { li.appendChild(el('p', 'message__from', from)); }
      list.appendChild(li);
    });
  }

  function renderAbout() {
    var box = qs('#about-text');
    if (!box) { return; }
    clear(box);
    (DATA.about.paragraphs || []).forEach(function (p) { box.appendChild(el('p', null, t(p))); });
    renderLinks();
  }

  /** 官方連結（data.js 的 links）。連結下面的一行小字說明帳號是依哪個來源確認的（ui.linksNote 的 {source} 換成出處連結） */
  function renderLinks() {
    var box = qs('#official-links'), list = qs('#links-list'), note = qs('#links-note');
    if (!box || !list) { return; }
    clear(list);
    var links = DATA.links || [];
    box.hidden = !links.length;
    var noteSource = null;
    links.forEach(function (link) {
      var li = el('li');
      li.appendChild(extLink(link.url, t(link.label)));
      // 帳號名稱放在連結外面：底線會蓋掉帳號裡的「_」，放在連結裡會看不清楚
      if (link.handle) { li.appendChild(el('span', 'links__handle', link.handle)); }
      list.appendChild(li);
      if (!noteSource && link.sources && SOURCES[link.sources[0]]) { noteSource = link.sources[0]; }
    });
    if (!note) { return; }
    clear(note);
    note.hidden = !noteSource;
    if (noteSource) {
      var parts = ui('linksNote').split('{source}');
      note.appendChild(doc.createTextNode(parts[0]));
      note.appendChild(sourceLink(noteSource));
      note.appendChild(doc.createTextNode(parts.slice(1).join('')));
    }
  }

  function renderFooter() {
    var d = qs('#footer-disclaimer'), p = qs('#footer-photo'), u = qs('#footer-updated');
    if (d) { d.textContent = t(DATA.footer.disclaimer); }
    if (p) { p.textContent = t(DATA.footer.photoNotice); }
    if (u) { u.textContent = fill(ui('footerUpdated'), { date: formatDate(DATA.site.lastUpdated) }); }
  }

  /* ---------- 分享這個網站 ----------
     1. 有 navigator.share（手機、部分桌機瀏覽器）：開系統分享選單，分享標題、一句說明（data.js）和網址；
        使用者自己取消（AbortError）時什麼都不顯示，其他失敗則退回 2。
     2. 沒有：用剪貼簿複製網址，按鈕旁的 aria-live 狀態文字顯示「URLをコピーしました／已複製網址」，幾秒後淡出。
     3. 連剪貼簿也不能用：狀態文字直接顯示網址，讓使用者自己複製（不會消失）。
     網址一律來自 <link rel="canonical">（share.js 的 resolveShareUrl）。 */
  var SHARE_STATUS_MS = 4000;
  var shareTimers = [];

  function clearShareTimers() {
    shareTimers.forEach(function (id) { window.clearTimeout(id); });
    shareTimers = [];
  }

  function shareUrl() {
    var canonical = qs('link[rel="canonical"]');
    return Share.resolveShareUrl(canonical ? canonical.getAttribute('href') : null, window.location.href);
  }

  /** 依 state.shareStatus 重畫狀態文字（切換語言時也會呼叫，文字才會跟著換） */
  function renderShareStatus() {
    var status = qs('#share-status');
    if (!status) { return; }
    var s = state.shareStatus;
    clear(status);
    status.classList.toggle('share__status--ok', !!s && s.kind === 'copied');
    status.classList.toggle('is-visible', !!s);
    if (!s) { return; }
    if (s.kind === 'copied') {
      status.textContent = ui('shareCopied');
    } else {
      // 顯示網址的狀態：網址做成指向同一個 canonical 網址的連結，鍵盤使用者與螢幕閱讀器也能取用（複製連結網址）
      status.appendChild(doc.createTextNode(ui('shareCopyManual')));
      var link = el('a', 'share__url', s.url);
      link.href = s.url;
      status.appendChild(link);
    }
  }

  function showShareStatus(kind, url) {
    clearShareTimers();
    state.shareStatus = { kind: kind, url: url };
    renderShareStatus();
    if (kind !== 'copied') { return; }   // 顯示網址的狀態不會自動消失
    shareTimers.push(window.setTimeout(function () {
      state.shareStatus = null;
      var status = qs('#share-status');
      if (status) { status.classList.remove('is-visible'); }   // 先淡出（reduced-motion 時直接消失）
      shareTimers.push(window.setTimeout(function () {
        if (!state.shareStatus) { renderShareStatus(); }        // 淡出後再清掉文字（不會被再唸一次）
      }, 500));
    }, SHARE_STATUS_MS));
  }

  function copyShareUrl(url) {
    var nav = window.navigator;
    if (!Share.canCopy(nav)) { showShareStatus('manual', url); return; }
    var p;
    try { p = nav.clipboard.writeText(url); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then(function () {
      showShareStatus('copied');
    }, function () {
      showShareStatus('manual', url);
    });
  }

  function shareSite() {
    var url = shareUrl();
    var nav = window.navigator;
    if (Share.shareMethod(nav) !== 'share') { copyShareUrl(url); return; }
    var data = Share.buildShareData(t(DATA.site.title), ui('shareText'), url);
    var p;
    try { p = nav.share(data); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then(function () {
      state.shareStatus = null;
      clearShareTimers();
      renderShareStatus();
    }, function (err) {
      if (Share.isAbortError(err)) { return; }   // 使用者取消：不顯示任何訊息
      copyShareUrl(url);                         // 其他失敗（不支援這組資料等）：退回複製網址
    });
  }

  function setupShare() {
    var btn = qs('#share-btn');
    var box = qs('.share');
    if (!btn) { return; }
    if (!Share) { if (box) { box.hidden = true; } return; }
    btn.addEventListener('click', shareSite);
  }

  /* ---------- 全部重畫（切換語言時） ---------- */
  function renderAll() {
    renderStaticText();
    renderHero();
    renderProfile();
    renderBirthdayText();
    renderTimeline();
    renderWorks();
    renderInterviews();
    renderGalleryText();
    if (state.photoIndex >= 0) { showPhoto(state.photoGroup, state.photoIndex); }
    renderMessages();
    renderAbout();
    renderShareStatus();
    renderFooter();
  }

  function setLang(lang) {
    if (LANGS.indexOf(lang) === -1 || lang === state.lang) { return; }
    state.lang = lang;
    saveLang(lang);
    renderAll();
  }

  /* ---------- 導覽列：標示目前所在的區塊 ---------- */
  function setupNavHighlight() {
    if (!('IntersectionObserver' in window)) { return; }
    var links = qsa('.site-nav__list a[href^="#"]');
    var current = null;
    function setCurrent(id) {
      if (id === current) { return; }
      current = id;
      if (!id) {
        // 回到主視覺：清掉高亮（和第一次載入時相同），手機導覽列也捲回最左
        links.forEach(function (link) { link.removeAttribute('aria-current'); });
        var navList = qs('.site-nav__list');
        if (navList && typeof navList.scrollTo === 'function') {
          try { navList.scrollTo({ left: 0, behavior: 'auto' }); } catch (e) { /* 舊瀏覽器 */ }
        }
        return;
      }
      links.forEach(function (link) {
        var on = link.getAttribute('href') === '#' + id;
        if (on) {
          link.setAttribute('aria-current', 'true');
          // 把目前區塊的膠囊捲到導覽列中間。直接捲動清單，不用 link.scrollIntoView()：
          // 那會把「下一個 Tab 的起點」重設回導覽連結，鍵盤使用者按導覽後就進不了目標區塊。
          var list = link.parentNode && link.parentNode.parentNode;
          if (list && typeof list.scrollTo === 'function') {
            try { list.scrollTo({ left: link.offsetLeft - (list.clientWidth - link.offsetWidth) / 2, behavior: 'auto' }); } catch (e) { /* 舊瀏覽器 */ }
          }
        } else {
          link.removeAttribute('aria-current');
        }
      });
    }
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) { return; }
        setCurrent(entry.target.id === 'top' ? null : entry.target.id);   // 主視覺（#top）不是導覽目標：進入視窗就清掉高亮
      });
    }, { rootMargin: '-35% 0px -55% 0px', threshold: 0 });
    links.forEach(function (link) {
      var section = doc.getElementById(link.getAttribute('href').slice(1));
      if (section) { observer.observe(section); }
    });
    var hero = doc.getElementById('top');
    if (hero) { observer.observe(hero); }
  }

  /* 手機的導覽列可以左右捲動，右側有一段淡出遮罩。鍵盤焦點移到某一項時，瀏覽器只會在它「超出捲動範圍」時才捲；
     剛好停在遮罩底下的那一項不會動，焦點框就被蓋住一部分。這裡把它捲到遮罩之外。
     （直接捲動清單，不用 scrollIntoView()：理由和 setupNavHighlight 相同。） */
  var NAV_FADE = 56;   // 和 styles.css 的 .site-nav__list { scroll-padding-inline } 右側相同
  function setupNavFocus() {
    qsa('.site-nav__list a').forEach(function (link) {
      link.addEventListener('focus', function () {
        var list = link.parentNode && link.parentNode.parentNode;
        if (!list || typeof list.scrollTo !== 'function' || list.scrollWidth <= list.clientWidth) { return; }   // 桌機：不能捲動，不用處理
        var box = list.getBoundingClientRect();
        var rect = link.getBoundingClientRect();
        var over = rect.right - (box.right - NAV_FADE);
        var under = (box.left + 8) - rect.left;
        if (over > 0 || under > 0) {
          try { list.scrollTo({ left: list.scrollLeft + (over > 0 ? over : -under), behavior: 'auto' }); } catch (e) { /* 舊瀏覽器 */ }
        }
      });
    });
  }

  function setupLangSwitch() {
    qsa('.lang-switch__btn').forEach(function (btn) {
      btn.addEventListener('click', function () { setLang(btn.getAttribute('data-lang')); });
    });
    // 手機版頁首只有導覽列固定，品牌列與語言鈕會跟著頁首黏在視窗上方看不見；
    // 鍵盤往回（Shift+Tab）移到它們時把頁面捲回最上面，焦點才看得見。
    function revealHeader() {
      var header = qs('.site-header');
      if (header && header.getBoundingClientRect().top < 0) {
        // 'instant'：'auto' 會跟著 html 的 scroll-behavior: smooth 變成平滑捲動，接著被瀏覽器自己的捲動蓋掉
        try { window.scrollTo({ top: 0, behavior: 'instant' }); } catch (e) { window.scrollTo(0, 0); }
      }
    }
    // 從導覽第一項或語言鈕按 Shift+Tab：在焦點移動之前先捲回頂端，瀏覽器就不會再用平滑捲動去找看不見的元素
    var firstNav = qs('.site-nav__list a');
    qsa('.lang-switch__btn').concat(firstNav ? [firstNav] : []).forEach(function (node) {
      node.addEventListener('keydown', function (e) { if (e.key === 'Tab' && e.shiftKey) { revealHeader(); } });
    });
    qsa('.brand, .lang-switch__btn').forEach(function (node) {
      node.addEventListener('focus', function () {
        revealHeader();
        window.setTimeout(revealHeader, 80);   // 瀏覽器自己的「把焦點元素捲進畫面」在 focus 事件之後才做，再補一次
      });
    });
  }

  /* ---------- 啟動 ---------- */
  function init() {
    state.lang = loadLang();
    state.countdownState = computeState();
    buildGallery();
    setupLightbox();
    setupLangSwitch();
    setupNavFocus();
    setupShare();
    setupNavHighlight();
    renderAll();
    startClock();
    window.addEventListener('hashchange', function () {
      var preview = wantsBirthdayPreview();
      if (preview !== state.birthdayPreview) { state.birthdayPreview = preview; tick(); }
    });
  }

  if (doc.readyState === 'loading') { doc.addEventListener('DOMContentLoaded', init); } else { init(); }
}());
