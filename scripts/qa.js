// 品質檢查（headless Chromium + Playwright）：截圖、跑版、橫向捲動、CSP、語言切換、燈箱、倒數、深色模式、減少動態、無障礙（axe-core）。
// 先安裝：npm install（會裝 playwright 與 axe-core），再 npx playwright install chromium
// 然後在另一個終端機執行 python3 -m http.server 8000 --bind 127.0.0.1（只讓自己的電腦看得到），接著：
//   node scripts/qa.js http://127.0.0.1:8000/ qa-output
// 截圖與 report.json 會放在 qa-output/（已在 .gitignore 裡）。
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const baseUrl = process.argv[2] || 'http://127.0.0.1:8000/';
const outDir = process.argv[3] || path.join(__dirname, '..', 'qa-output');
const scale = Number((process.argv.find(a => a.startsWith('--scale=')) || '--scale=1').split('=')[1]);
fs.mkdirSync(outDir, { recursive: true });

let axeSource = null;
try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch (e) { /* optional */ }

const report = { baseUrl, pass: [], fail: [], warn: [], info: {} };
const ok = (name, cond, detail) => { (cond ? report.pass : report.fail).push(detail ? `${name}: ${detail}` : name); };
const warn = (name, detail) => report.warn.push(detail ? `${name}: ${detail}` : name);

async function newPage(browser, opts = {}) {
  const context = await browser.newContext({
    viewport: { width: opts.width || 375, height: opts.height || 812 },
    deviceScaleFactor: scale,
    colorScheme: opts.colorScheme || 'light',
    reducedMotion: opts.reducedMotion || 'no-preference',
    hasTouch: !!opts.hasTouch,
    isMobile: !!opts.isMobile,
    locale: opts.locale || 'ja-JP',
    timezoneId: opts.timezoneId || 'Asia/Taipei',
    bypassCSP: !!opts.bypassCSP,
    permissions: opts.permissions || [],
  });
  const page = await context.newPage();
  const errors = [];
  const csp = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', e => {
      window.__cspViolations.push(e.violatedDirective + ' blocked ' + (e.blockedURI || 'inline') + ' @' + e.sourceFile + ':' + e.lineNumber);
    });
  });
  page.__errors = errors; page.__csp = csp;
  return { context, page };
}

async function settle(page) {
  await page.waitForFunction(() => document.querySelectorAll('#gallery img').length >= 18, null, { timeout: 15000 });
  await page.waitForTimeout(400);
}
async function loadAllImages(page) {
  await page.evaluate(async () => {
    const h = document.documentElement.scrollHeight;
    for (let y = 0; y < h; y += 400) { window.scrollTo({ top: y, behavior: 'instant' }); await new Promise(r => setTimeout(r, 120)); }
    window.scrollTo({ top: 0, behavior: 'instant' });
    const pending = Array.from(document.images).filter(i => i.getAttribute('src') && !i.closest('dialog:not([open])') && !i.complete);
    await Promise.race([
      Promise.all(pending.map(i => new Promise(r => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))),
      new Promise(r => setTimeout(r, 8000)),
    ]);
  });
  await page.waitForTimeout(300);
}

async function collectText(page) {
  return page.evaluate(() => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = n.textContent.replace(/\s+/g, ' ').trim();
      if (!t) continue;
      const el = n.parentElement;
      if (!el || el.closest('script,style,noscript')) continue;
      // text explicitly marked as another language (e.g. the bilingual message cards) is intentional
      const langEl = el.closest('[lang]');
      if (langEl && langEl !== document.documentElement && langEl.getAttribute('lang') !== document.documentElement.lang) continue;
      out.push(t);
    }
    // attributes that carry text
    document.querySelectorAll('[alt],[aria-label],[title]').forEach(el => {
      for (const a of ['alt', 'aria-label', 'title']) if (el.hasAttribute(a) && el.getAttribute(a).trim()) out.push(`@${a}=` + el.getAttribute(a).trim());
    });
    return out;
  });
}

// 900～1099px 的單列頁首：高度不超過 64px，導覽最後一項完整、沒有被裁切
async function checkHeaderFits(page, width, lang) {
  const h = await page.evaluate(() => {
    const inner = document.querySelector('.site-header__inner');
    const list = document.querySelector('.site-nav__list');
    const links = Array.from(document.querySelectorAll('.site-nav__list a'));
    const last = links[links.length - 1];
    const lr = last.getBoundingClientRect(), cr = list.getBoundingClientRect();
    return { height: Math.round(inner.getBoundingClientRect().height), scrollWidth: list.scrollWidth, clientWidth: list.clientWidth, lastRight: Math.round(lr.right), listRight: Math.round(cr.right), lastText: last.textContent };
  });
  ok(`header stays one row (<= 64px) @${width} (${lang})`, h.height <= 64, JSON.stringify(h));
  ok(`last nav item is not clipped @${width} (${lang})`, h.scrollWidth <= h.clientWidth && h.lastRight <= h.listRight + 1, JSON.stringify(h));
}

// 分享按鈕：真正的 <button>、有文字、放在「關於本站」區塊裡，旁邊有 aria-live="polite" 的狀態文字
async function shareButtonInfo(page) {
  return page.evaluate(() => {
    const btn = document.getElementById('share-btn');
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    const status = document.getElementById('share-status');
    return {
      tag: btn.tagName, type: btn.getAttribute('type'), text: btn.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height),
      inAbout: !!btn.closest('#about'), live: status ? status.getAttribute('aria-live') : null, statusText: status ? status.textContent.trim() : null,
      statusOpacity: status ? parseFloat(getComputedStyle(status).opacity) : null, hidden: !!btn.closest('[hidden]'),
    };
  });
}
async function checkShareButton(page, width, lang) {
  const s = await shareButtonInfo(page);
  ok(`share button exists in the About section with text @${width} (${lang})`, !!s && s.tag === 'BUTTON' && s.type === 'button' && s.text.length > 0 && s.inAbout && !s.hidden && s.w > 0 && s.h >= 40, JSON.stringify(s));
  ok(`share status is an empty polite live region before use @${width} (${lang})`, !!s && s.live === 'polite' && s.statusText === '', JSON.stringify(s));
  return s;
}

async function switchLang(page, lang) {
  const label = lang === 'zh' ? '繁體中文' : '日本語';
  const btn = page.locator('button', { hasText: label }).first();
  // 手機捲動後品牌列（含語言鈕）會捲走、只剩導覽列固定，所以先回到頁面最上方再點
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForTimeout(100);
  await btn.click();
  await page.waitForTimeout(300);
}

(async () => {
  // QA_CHROME_PATH: use an installed Chrome/Chromium instead of Playwright's bundled browser
  const browser = await chromium.launch(process.env.QA_CHROME_PATH ? { executablePath: process.env.QA_CHROME_PATH } : {});
  try {
    // ---------- per-width light-mode checks in both languages ----------
    for (const width of [320, 375, 768, 1024, 1280, 1440]) {
      const { context, page } = await newPage(browser, { width, height: width < 700 ? 812 : 900 });
      await page.goto(baseUrl, { waitUntil: 'load' });
      await settle(page);
      const lang0 = await page.evaluate(() => document.documentElement.lang);
      ok(`default lang is ja @${width}`, lang0 === 'ja', lang0);
      const over = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      ok(`no horizontal overflow @${width} (ja)`, over.sw <= over.iw, JSON.stringify(over));
      // 精修後的版面約定（DESIGN.md）：版面本身不溢出（不靠 body 的 overflow-x: hidden 藏起來）；
      // 標語的文字照 data.js 原樣顯示，換行只發生在逗號之後；相簿每組的日期只寫一次，每格的日期仍是按鈕的描述
      const refine = await page.evaluate(() => {
        const vis = (el) => { if (!el) return false; const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
        const phrases = Array.from(document.querySelectorAll('.hero__slogan .phrase'));
        const tileDates = Array.from(document.querySelectorAll('#gallery .gallery__date'));
        const groupDate = document.querySelector('#gallery-date');
        return {
          bodyOverflowX: getComputedStyle(document.body).overflowX,
          leftovers: document.querySelectorAll('.eyebrow, .hero__glow, .hero__kana-vertical, .gallery__index, .birthday__mark').length,
          slogan: (document.querySelector('.hero__slogan') || {}).textContent || '',
          dataSlogan: window.SITE_DATA.hero.slogan.ja,
          phrases: phrases.length,
          phraseSplit: phrases.filter(p => p.getClientRects().length > 1).map(p => p.textContent),
          groupDate: vis(groupDate) ? groupDate.textContent : '',
          tileDatesVisible: tileDates.filter(vis).length,
          tileDatesFilled: tileDates.filter(e => e.textContent.trim()).length,
          describedBy: Array.from(document.querySelectorAll('#gallery button')).every(b => (b.getAttribute('aria-describedby') || '').split(/\s+/).every(id => document.getElementById(id))),
          messages: window.SITE_DATA.messages.length,
          messagesShown: vis(document.querySelector('#messages-list')),
          countdownRows: new Set(Array.from(document.querySelectorAll('.countdown__tile')).map(t => Math.round(t.getBoundingClientRect().top))).size,
        };
      });
      ok(`layout fits without hiding overflow on body @${width}`, refine.bodyOverflowX === 'visible', refine.bodyOverflowX);
      ok(`hero sentence is shown exactly as written in data.js @${width}`, refine.slogan === refine.dataSlogan && refine.phrases >= 1, JSON.stringify({ slogan: refine.slogan, phrases: refine.phrases }));
      if (width >= 375) ok(`hero sentence wraps only after commas @${width}`, refine.phraseSplit.length === 0, JSON.stringify(refine.phraseSplit));
      ok(`each photo group shows its date once; tile dates remain as button descriptions @${width}`, /2026/.test(refine.groupDate) && refine.tileDatesVisible === 0 && refine.tileDatesFilled === 18 && refine.describedBy, JSON.stringify({ g: refine.groupDate, v: refine.tileDatesVisible, f: refine.tileDatesFilled, d: refine.describedBy }));
      ok(`countdown stays on one row @${width}`, refine.countdownRows === 1, String(refine.countdownRows));
      if (width === 375) {
        ok('no section labels, glow layer, vertical decoration, tile numbers or birthday mark remain', refine.leftovers === 0, String(refine.leftovers));
        ok('message list is shown only when data.js has messages', refine.messagesShown === (refine.messages > 0), JSON.stringify({ n: refine.messages, shown: refine.messagesShown }));
        // 還沒捲動時，視訊回憶的照片不應該已經載入（lazy loading 生效、不影響第一屏）
        const callLoadedEarly = await page.evaluate(() => Array.from(document.querySelectorAll('#gallery-grid-call img')).filter(i => i.complete && i.naturalWidth > 0).length);
        ok('call photos are not loaded before scrolling', callLoadedEarly === 0, String(callLoadedEarly));
      }
      if ([375, 768, 1024, 1280].includes(width)) { await loadAllImages(page); await page.screenshot({ path: path.join(outDir, `ja-${width}.png`), fullPage: true }); }
      const jaText = await collectText(page);
      const jaTitle = await page.title();
      if (width >= 900 && width <= 1099) await checkHeaderFits(page, width, 'ja');
      const shareJa = await checkShareButton(page, width, 'ja');

      await switchLang(page, 'zh');
      if (width >= 900 && width <= 1099) await checkHeaderFits(page, width, 'zh');
      const shareZh = await checkShareButton(page, width, 'zh');
      ok(`share button text changes with language @${width}`, !!shareJa && !!shareZh && shareJa.text !== shareZh.text && /シェア/.test(shareJa.text) && /分享/.test(shareZh.text), `${shareJa && shareJa.text} / ${shareZh && shareZh.text}`);
      const lang1 = await page.evaluate(() => document.documentElement.lang);
      ok(`lang attr becomes zh-Hant @${width}`, lang1 === 'zh-Hant', lang1);
      const over2 = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      ok(`no horizontal overflow @${width} (zh)`, over2.sw <= over2.iw, JSON.stringify(over2));
      if ([375, 768, 1280].includes(width)) { await loadAllImages(page); await page.screenshot({ path: path.join(outDir, `zh-${width}.png`), fullPage: true }); }
      const zhText = await collectText(page);
      const zhTitle = await page.title();
      ok(`title changes with language @${width}`, jaTitle !== zhTitle, `${jaTitle} / ${zhTitle}`);

      if (width === 375) {
        // i18n completeness heuristic: texts unchanged between languages
        const zhSet = new Set(zhText);
        const unchanged = jaText.filter(t => zhSet.has(t));
        const suspicious = unchanged.filter(t => /[぀-ヿ]/.test(t) || (/[一-鿿]/.test(t) && t.length > 2 && !/^(AYAKA|彩花|あやか|NiziU|Step and a step|Portfolio|日本語|繁體中文)$/.test(t)));
        report.info.unchangedBetweenLanguages = unchanged;
        ok('no Japanese-kana text left after switching to zh', suspicious.filter(t => /[぀-ヿ]/.test(t) && t !== 'あやか' && !t.startsWith('@')).length === 0, JSON.stringify(suspicious.filter(t => /[぀-ヿ]/.test(t))));
        report.info.suspiciousUnchanged = suspicious;
        // persistence
        await page.reload({ waitUntil: 'load' });
        await settle(page);
        const langAfter = await page.evaluate(() => document.documentElement.lang);
        ok('language persists after reload', langAfter === 'zh-Hant', langAfter);
        const stored = await page.evaluate(() => { try { return Object.entries(localStorage); } catch (e) { return 'ERR ' + e.message; } });
        report.info.localStorage = stored;
        // switch back
        await switchLang(page, 'ja');
        const langBack = await page.evaluate(() => document.documentElement.lang);
        ok('switching back to ja works', langBack === 'ja', langBack);
        const pressed = await page.evaluate(() => Array.from(document.querySelectorAll('button[aria-pressed]')).map(b => b.textContent.trim() + '=' + b.getAttribute('aria-pressed')));
        ok('toggle buttons expose aria-pressed', pressed.length >= 2 && pressed.some(p => p.endsWith('=true')) && pressed.some(p => p.endsWith('=false')), JSON.stringify(pressed));
      }

      // images
      const imgs = await page.evaluate(() => Array.from(document.images).filter(i => !i.closest('dialog:not([open])')).map(i => ({ src: i.getAttribute('src'), alt: i.getAttribute('alt'), w: i.getAttribute('width'), h: i.getAttribute('height'), loading: i.getAttribute('loading') })));
      ok(`every img has alt @${width}`, imgs.every(i => i.alt && i.alt.trim()), JSON.stringify(imgs.filter(i => !i.alt)));
      ok(`every img has width/height @${width}`, imgs.every(i => i.w && i.h), JSON.stringify(imgs.filter(i => !i.w || !i.h).map(i => i.src)));
      if (width === 375) {
        report.info.images = imgs;
        ok('gallery images are lazy', imgs.filter(i => /ayaka-0[1-9]/.test(i.src || '')).filter(i => i.loading === 'lazy').length >= 9, JSON.stringify(imgs.map(i => i.src + ':' + i.loading)));
        ok('call photos are lazy', imgs.filter(i => /call-0[1-9]/.test(i.src || '')).filter(i => i.loading === 'lazy').length === 9, JSON.stringify(imgs.filter(i => /call-/.test(i.src || '')).map(i => i.src + ':' + i.loading)));
        // 只有主視覺是 eager，其餘（兩組相簿）都要 lazy
        const eager = imgs.filter(i => i.loading !== 'lazy');
        ok('only the hero image is eager', eager.length === 1 && /ayaka-07/.test(eager[0].src || ''), JSON.stringify(eager.map(i => i.src)));
        // scroll to bottom to trigger lazy load and ensure all images load
        await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 400) { window.scrollTo({ top: y, behavior: 'instant' }); await new Promise(r => setTimeout(r, 60)); } window.scrollTo({ top: 0, behavior: 'instant' }); });
        await page.waitForTimeout(1500);
        const broken = await page.evaluate(() => Array.from(document.images).filter(i => !i.closest('dialog:not([open])')).filter(i => i.complete && i.naturalWidth === 0).map(i => i.getAttribute('src')));
        ok('no broken images', broken.length === 0, JSON.stringify(broken));
        const webp = await page.evaluate(() => ({ enabled: !!(window.SITE_DATA && window.SITE_DATA.site.webp), hero: (document.querySelector('#hero-img') || {}).currentSrc || '', gallery: Array.from(document.querySelectorAll('#gallery img')).map(i => i.currentSrc || '') }));
        if (webp.enabled) ok('WebP versions are served when enabled', /\.webp$/.test(webp.hero) && webp.gallery.every(u => /\.webp$/.test(u)), JSON.stringify(webp).slice(0, 300));
      }

      // inline-script/style/on* scan + CSP presence
      const sec = await page.evaluate(() => ({
        inlineScripts: Array.from(document.scripts).filter(s => !s.src).length,
        styleEls: document.querySelectorAll('style').length,
        styleAttrs: document.querySelectorAll('[style]').length,
        onAttrs: Array.from(document.querySelectorAll('*')).filter(el => Array.from(el.attributes).some(a => /^on/i.test(a.name))).length,
        csp: (document.querySelector('meta[http-equiv="Content-Security-Policy"]') || {}).content || null,
        referrer: (document.querySelector('meta[name="referrer"]') || {}).content || null,
        external: Array.from(document.querySelectorAll('script[src],link[href]:not([rel~="canonical"]):not([rel~="alternate"]),img[src],source[srcset]')).map(e => e.src || e.href || e.srcset).filter(u => u && !u.startsWith(location.origin) && !/^photos\//.test(u)),
      }));
      if (width === 375) {
        report.info.security = sec;
        ok('no inline scripts', sec.inlineScripts === 0, String(sec.inlineScripts));
        ok('no <style> elements', sec.styleEls === 0, String(sec.styleEls));
        ok('no style attributes', sec.styleAttrs === 0, String(sec.styleAttrs));
        ok('no on* attributes', sec.onAttrs === 0, String(sec.onAttrs));
        ok('CSP meta present', !!sec.csp, sec.csp);
        ok('CSP enforces Trusted Types and forbids creating policies', /require-trusted-types-for 'script'/.test(sec.csp || '') && /trusted-types 'none'/.test(sec.csp || ''), sec.csp);
        ok('referrer meta no-referrer', sec.referrer === 'no-referrer', sec.referrer);
        ok('no external resources', sec.external.length === 0, JSON.stringify(sec.external));
      }
      const csp = await page.evaluate(() => window.__cspViolations);
      ok(`no CSP violations @${width}`, csp.length === 0, JSON.stringify(csp));
      ok(`no console errors @${width}`, page.__errors.length === 0, JSON.stringify(page.__errors));
      await context.close();
    }

    // ---------- landscape phone (667x375): hero photo keeps a usable size ----------
    for (const [w, h] of [[667, 375], [900, 768], [1024, 768]]) {
      const { context, page } = await newPage(browser, { width: w, height: h, hasTouch: w < 700, isMobile: w < 700 });
      await page.goto(baseUrl, { waitUntil: 'load' });
      await settle(page);
      await page.screenshot({ path: path.join(outDir, `fold-${w}x${h}.png`), fullPage: false });
      const over = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      ok(`no horizontal overflow @${w}x${h}`, over.sw <= over.iw, JSON.stringify(over));
      if (w === 667) {
        const hero = await page.evaluate(() => { const r = document.querySelector('.hero__img').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) }; });
        ok(`landscape hero photo is at least 200px wide @${w}x${h}`, hero.w >= 200, JSON.stringify(hero));
        await switchLang(page, 'zh');
        const hero2 = await page.evaluate(() => Math.round(document.querySelector('.hero__img').getBoundingClientRect().width));
        ok(`landscape hero photo is at least 200px wide @${w}x${h} (zh)`, hero2 >= 200, String(hero2));
      } else {
        // 900～1099px：頁首單列、導覽最後一項沒有被裁切（1024 在上面的主迴圈也會檢查）
        await page.waitForTimeout(800);
        await page.locator('.site-header').screenshot({ path: path.join(outDir, `header-${w}-ja.png`) });
        await checkHeaderFits(page, w, 'ja');
        await switchLang(page, 'zh');
        await checkHeaderFits(page, w, 'zh');
        await page.locator('.site-header').screenshot({ path: path.join(outDir, `header-${w}-zh.png`) });
      }
      await context.close();
    }

    // ---------- lightbox & keyboard (375 touch + 1280) ----------
    for (const width of [375, 1280]) {
      const { context, page } = await newPage(browser, { width, height: width < 700 ? 812 : 900, hasTouch: width < 700, isMobile: width < 700 });
      await page.goto(baseUrl, { waitUntil: 'load' });
      await settle(page);
      const tiles = page.locator('#gallery-grid button');
      const count = await tiles.count();
      ok(`gallery has 9 tile buttons @${width}`, count === 9, String(count));
      if (width === 375) {
        // 每顆按鈕的名稱只來自說明（aria-labelledby），說明本身不再被唸第二次（兩組都檢查）
        const names = await page.evaluate(() => Array.from(document.querySelectorAll('#gallery button')).map(b => {
          const lab = (b.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => (document.getElementById(id) || {}).textContent || '').join(' ').trim();
          const cap = b.parentElement.querySelector('.gallery__caption');
          return { lab, hidden: cap && cap.getAttribute('aria-hidden') === 'true', alt: b.querySelector('img').getAttribute('alt') };
        }));
        ok('gallery buttons are named once by their caption', names.every(n => n.lab && n.hidden && n.lab === n.alt), JSON.stringify(names.slice(0, 2)));
        const lists = await page.evaluate(() => ['.site-nav__list', '#timeline-list', '#gallery-grid', '#messages-list'].map(s => (document.querySelector(s) || {}).getAttribute && document.querySelector(s).getAttribute('role')));
        ok('nav, timeline, gallery and messages lists keep role="list"', lists.every(r => r === 'list'), JSON.stringify(lists));
        // 兩組的說明／日期 id 不能撞名（aria-labelledby 才會指到自己那一格）
        const ids = await page.evaluate(() => Array.from(document.querySelectorAll('#gallery .gallery__caption [id]')).map(e => e.id));
        ok('gallery caption ids are unique across both groups', ids.length === 36 && new Set(ids).size === ids.length, JSON.stringify(ids.slice(0, 4)));
      }
      const callCount = await page.locator('#gallery-grid-call button').count();
      ok(`call-photo group has 9 tile buttons @${width}`, callCount === 9, String(callCount));
      const third = tiles.nth(2);
      await third.scrollIntoViewIfNeeded();
      await third.focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      const open = await page.evaluate(() => { const d = document.querySelector('dialog'); return d ? d.open : null; });
      ok(`lightbox opens with Enter @${width}`, open === true, String(open));
      const focusInside = await page.evaluate(() => { const d = document.querySelector('dialog'); return !!(d && d.contains(document.activeElement)); });
      ok(`focus moves into dialog @${width}`, focusInside);
      // 剛開啟（焦點在 dialog 本身）就按 Shift+Tab：留在燈箱裡、落在最後一顆按鈕（A2-04）
      await page.keyboard.press('Shift+Tab');
      await page.waitForTimeout(100);
      const backFocus = await page.evaluate(() => document.activeElement.id);
      ok(`Shift+Tab right after opening stays in the dialog on the last button @${width}`, backFocus === 'lightbox-next', backFocus);
      const counter0 = await page.evaluate(() => (document.querySelector('dialog') || {}).textContent || '');
      const img0 = await page.evaluate(() => { const i = document.querySelector('dialog img'); return i ? i.getAttribute('src') : null; });
      ok(`lightbox shows 3rd photo @${width}`, img0 === 'photos/ayaka-03.jpg', String(img0));
      await page.waitForTimeout(500);
      const lbSrc = await page.evaluate(() => { const i = document.querySelector('dialog img'); const r = i.getBoundingClientRect(); return { cur: (i.currentSrc || '').split('/').pop(), w: Math.round(r.width), dpr: window.devicePixelRatio }; });
      report.info[`lightboxSrc${width}`] = lbSrc;
      if (lbSrc.dpr === 1 && width === 1280) ok('lightbox picks the 800px WebP on a 1280x900 desktop, not -full', /-800\.webp$/.test(lbSrc.cur), JSON.stringify(lbSrc));
      await page.screenshot({ path: path.join(outDir, `lightbox-${width}.png`), fullPage: false });
      const status0 = await page.evaluate(() => (document.querySelector('dialog [aria-live]') || {}).textContent || '');
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(300);
      const img1 = await page.evaluate(() => { const i = document.querySelector('dialog img'); return i ? i.getAttribute('src') : null; });
      ok(`ArrowRight advances to 4th photo @${width}`, img1 === 'photos/ayaka-04.jpg', String(img1));
      const status1 = await page.evaluate(() => (document.querySelector('dialog [aria-live]') || {}).textContent || '');
      ok(`lightbox live region announces the new photo @${width}`, status0 !== status1 && /4/.test(status1) && /9/.test(status1) && status1.length > 5, `${status0} -> ${status1}`);
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(300);
      const img2 = await page.evaluate(() => { const i = document.querySelector('dialog img'); return i ? i.getAttribute('src') : null; });
      ok(`ArrowLeft twice goes to 2nd photo @${width}`, img2 === 'photos/ayaka-02.jpg', String(img2));
      // wrap-around check: go to first then ArrowLeft
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(300);
      const imgWrap = await page.evaluate(() => { const i = document.querySelector('dialog img'); return i ? i.getAttribute('src') : null; });
      report.info[`wrapAt${width}`] = imgWrap;
      const bodyLocked = await page.evaluate(() => getComputedStyle(document.body).overflow === 'hidden' || getComputedStyle(document.documentElement).overflow === 'hidden' || document.body.className.length > 0);
      ok(`body scroll locked while open @${width}`, bodyLocked);
      // tab trap: tab several times, focus should stay inside dialog
      for (let i = 0; i < 8; i++) await page.keyboard.press('Tab');
      const stillInside = await page.evaluate(() => { const d = document.querySelector('dialog'); return !!(d && d.contains(document.activeElement)); });
      ok(`focus stays inside dialog after tabbing @${width}`, stillInside);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      const closed = await page.evaluate(() => { const d = document.querySelector('dialog'); return d ? !d.open : null; });
      ok(`Escape closes lightbox @${width}`, closed === true, String(closed));
      const focusBack = await page.evaluate(() => { const tiles = document.querySelectorAll('#gallery-grid button'); return document.activeElement === tiles[2]; });
      ok(`focus returns to the tile @${width}`, focusBack);
      // ---- 視訊回憶（第二組）：每張有 alt、燈箱可開、在組內循環、計數 1 / 9、焦點回到原格子 ----
      {
        const callAlts = await page.evaluate(() => Array.from(document.querySelectorAll('#gallery-grid-call img')).map(i => i.getAttribute('alt') || ''));
        ok(`call photos all have alt @${width}`, callAlts.length === 9 && callAlts.every(a => a.trim()), JSON.stringify(callAlts));
        const callHead = await page.evaluate(() => {
          const date = document.querySelector('#gallery-call-date');
          const list = document.querySelector('#gallery-grid-call');
          return {
            title: (document.querySelector('#gallery-call-title') || {}).textContent || '',
            date: date ? date.textContent : '',
            dt: date ? date.getAttribute('datetime') : null,
            dataDate: window.SITE_DATA.callPhotos.date,
            hidden: (document.querySelector('#gallery-call') || {}).hidden,
            role: list ? list.getAttribute('role') : null,
            labelledby: list ? list.getAttribute('aria-labelledby') : null,
          };
        });
        ok(`call group has heading and full date @${width}`, callHead.title.trim().length > 0 && /2026/.test(callHead.date) && /^\d{4}-\d{2}-\d{2}$/.test(callHead.dt || '') && callHead.dt === callHead.dataDate && callHead.hidden === false, JSON.stringify(callHead));
        ok(`call grid is a labelled list (role=list, title + date) @${width}`, callHead.role === 'list' && /\bgallery-call-title\b/.test(callHead.labelledby || '') && /\bgallery-call-date\b/.test(callHead.labelledby || ''), JSON.stringify(callHead));
        const callFirst = page.locator('#gallery-grid-call button').nth(0);
        await callFirst.scrollIntoViewIfNeeded();
        await callFirst.focus();
        await page.keyboard.press('Enter');
        await page.waitForTimeout(400);
        const callOpen = await page.evaluate(() => { const d = document.querySelector('dialog'); const i = d && d.querySelector('img'); return { open: d ? d.open : null, src: i ? i.getAttribute('src') : null, alt: i ? i.getAttribute('alt') : null, counter: (document.querySelector('#lightbox-counter') || {}).textContent || '', date: (document.querySelector('#lightbox-date') || {}).textContent || '' }; });
        ok(`lightbox opens call photo 1 @${width}`, callOpen.open === true && callOpen.src === 'photos/call-01.jpg', JSON.stringify(callOpen));
        ok(`call lightbox has alt, counter 1 / 9 and date @${width}`, !!(callOpen.alt && callOpen.alt.trim()) && /^1 \/ 9$/.test(callOpen.counter.trim()) && /2026/.test(callOpen.date), JSON.stringify(callOpen));
        await page.screenshot({ path: path.join(outDir, `lightbox-call-${width}.png`), fullPage: false });
        const callStatus0 = await page.evaluate(() => (document.querySelector('dialog [aria-live]') || {}).textContent || '');
        await page.keyboard.press('ArrowLeft');
        await page.waitForTimeout(300);
        const callWrap = await page.evaluate(() => { const i = document.querySelector('dialog img'); return i ? i.getAttribute('src') : null; });
        ok(`ArrowLeft from call photo 1 wraps to call photo 9 (stays in group) @${width}`, callWrap === 'photos/call-09.jpg', String(callWrap));
        // R-06 的宣告區對第二組也要唸出「9枚中9枚目：…」，而且說明要是第二組的
        const callStatus1 = await page.evaluate(() => ({ text: (document.querySelector('dialog [aria-live]') || {}).textContent || '', alt: (document.querySelector('dialog img') || {}).getAttribute('alt') || '' }));
        ok(`call lightbox live region announces the call photo @${width}`, callStatus0 !== callStatus1.text && /9/.test(callStatus1.text) && callStatus1.alt.length > 0 && callStatus1.text.includes(callStatus1.alt), `${callStatus0} -> ${JSON.stringify(callStatus1)}`);
        // 第二組的 <source sizes> 要和第一組（R-13／P-01 的新值）相同
        const sizes = await page.evaluate(() => [1, 2].map(n => (document.querySelector(`#gallery-grid .gallery__item:nth-child(${n}) source`) || {}).getAttribute('sizes')).concat([1, 2].map(n => (document.querySelector(`#gallery-grid-call .gallery__item:nth-child(${n}) source`) || {}).getAttribute('sizes'))));
        // 第一組只有第一張是整寬（92vw）；第二組第一張不全寬，所以兩張都用一般的 sizes（P2-02）
        ok(`call-photo group uses the regular sizes for its first tile too @${width}`, sizes[0] !== sizes[1] && /92vw/.test(sizes[0] || '') && sizes[2] === sizes[1] && sizes[3] === sizes[1] && /340px/.test(sizes[1] || ''), JSON.stringify(sizes));
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(300);
        const callNext = await page.evaluate(() => { const i = document.querySelector('dialog img'); return i ? i.getAttribute('src') : null; });
        ok(`ArrowRight twice reaches call photo 2 @${width}`, callNext === 'photos/call-02.jpg', String(callNext));
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        const callClosed = await page.evaluate(() => { const d = document.querySelector('dialog'); const tiles = document.querySelectorAll('#gallery-grid-call button'); return { closed: d ? !d.open : null, focusBack: document.activeElement === tiles[0] }; });
        ok(`Escape closes call lightbox and focus returns @${width}`, callClosed.closed === true && callClosed.focusBack, JSON.stringify(callClosed));
      }
      const unlocked = await page.evaluate(() => getComputedStyle(document.body).overflow !== 'hidden');
      ok(`body scroll unlocked after close @${width}`, unlocked);
      // close button via click
      await third.click();
      await page.waitForTimeout(300);
      const closeBtn = page.locator('dialog button').filter({ hasText: /閉じる|關閉/ }).first();
      const hasClose = await closeBtn.count();
      if (hasClose) { await closeBtn.click(); } else {
        const anyClose = page.locator('dialog button[aria-label*="閉じる"], dialog button[aria-label*="關閉"], dialog button.close, dialog button[data-action="close"]').first();
        if (await anyClose.count()) await anyClose.click(); else warn('no recognizable close button text/aria-label');
      }
      await page.waitForTimeout(300);
      const closed2 = await page.evaluate(() => { const d = document.querySelector('dialog'); return d ? !d.open : null; });
      ok(`close button closes lightbox @${width}`, closed2 === true, String(closed2));
      // swipe on touch
      if (width < 700) {
        await third.click();
        await page.waitForTimeout(300);
        const box = await page.locator('dialog img').first().boundingBox();
        if (box) {
          const cdp = await context.newCDPSession(page);
          const y = box.y + box.height / 2;
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width * 0.8, y }] });
          for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + box.width * (0.8 - 0.1 * i), y }] });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await page.waitForTimeout(400);
          const imgSw = await page.evaluate(() => { const i = document.querySelector('dialog img'); return i ? i.getAttribute('src') : null; });
          ok('swipe left advances photo @375', imgSw === 'photos/ayaka-04.jpg', String(imgSw));
        } else warn('could not find dialog img for swipe test');
        await page.keyboard.press('Escape');
      }
      ok(`no console errors in lightbox session @${width}`, page.__errors.length === 0, JSON.stringify(page.__errors));
      await context.close();
    }

    // ---------- lightbox in short viewports (landscape phone, 400% zoom): the photo is not squeezed into a thumbnail (A-04) ----------
    for (const [w, h] of [[568, 320], [320, 256]]) {
      const { context, page } = await newPage(browser, { width: w, height: h, hasTouch: true, isMobile: true });
      await page.goto(baseUrl, { waitUntil: 'load' });
      await settle(page);
      await page.locator('#gallery button').nth(3).click();
      await page.waitForTimeout(600);
      const lb = await page.evaluate(() => {
        const i = document.querySelector('dialog img').getBoundingClientRect(); const d = document.querySelector('dialog');
        const btns = Array.from(document.querySelectorAll('.lightbox__btn')).map(b => b.getBoundingClientRect());
        const overlap = btns.some(b => b.left < i.right && b.right > i.left && b.top < i.bottom && b.bottom > i.top);
        return { imgW: Math.round(i.width), imgH: Math.round(i.height), imgTop: Math.round(i.top), imgBottom: Math.round(i.bottom), vh: window.innerHeight, overlap, scrollable: d.scrollHeight > d.clientHeight, counterHidden: document.getElementById('lightbox-counter').getAttribute('aria-hidden') === 'true', hintHidden: document.getElementById('gallery-hint').hidden };
      });
      // 橫向手機（D2-02）：整張照片可見、不被按鈕遮住、不用捲動；400% 縮放的 320×256（A-04）：照片不縮成縮圖、可捲動
      if (w === 568) ok(`landscape lightbox shows the whole photo with the buttons beside it @${w}x${h}`, lb.imgTop >= 0 && lb.imgBottom <= lb.vh && lb.imgH >= lb.vh * 0.7 && !lb.overlap && !lb.scrollable, JSON.stringify(lb));
      else ok(`lightbox photo keeps a usable size in a short viewport @${w}x${h}`, lb.imgW >= Math.min(w, h) * 0.8 && lb.scrollable, JSON.stringify(lb));
      if (w === 568) ok('lightbox counter and gallery hint are not read twice (aria-hidden / hidden)', lb.counterHidden && lb.hintHidden, JSON.stringify(lb));
      await page.screenshot({ path: path.join(outDir, `lightbox-${w}x${h}.png`) });
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(300);
      const next = await page.evaluate(() => document.querySelector('dialog img').getAttribute('src'));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const closed = await page.evaluate(() => !document.querySelector('dialog').open);
      ok(`lightbox keys still work in a short viewport @${w}x${h}`, next === 'photos/ayaka-05.jpg' && closed, JSON.stringify({ next, closed }));
      await context.close();
    }

    // ---------- image sizes on high-DPR devices (P-01, P-02, P-04) and broken data.js fallback (P-03) ----------
    for (const [w, h, dpr, want] of [[375, 812, 2, { g0: /-800\.webp$/, hero: /-800\.webp$/ }], [375, 812, 3, { g0: /-full\.webp$/, hero: /-1024\.webp$/ }], [768, 1024, 2, { hero: /-800\.webp$/ }], [667, 375, 2, { hero: /-800\.webp$/ }], [1280, 900, 2, { hero: /-1024\.webp$/ }]]) {
      const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, locale: 'ja-JP' });
      const page = await context.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await settle(page);
      await loadAllImages(page);
      const pick = await page.evaluate(() => { const f = (i) => ({ cur: (i.currentSrc || '').split('/').pop(), css: Math.round(i.getBoundingClientRect().width) }); return { hero: f(document.querySelector('#hero-img')), g0: f(document.querySelector('#gallery img')) }; });
      for (const k of Object.keys(want)) ok(`${k === 'hero' ? 'hero' : 'first gallery'} image picks a fitting WebP @${w}x${h} dpr${dpr}`, want[k].test(pick[k].cur) && pick[k].css * dpr <= Number((pick[k].cur.match(/-(\d+)\.webp$/) || [0, 9999])[1]) * 1.05 + (pick[k].cur.includes('-full') ? 9999 : 0), JSON.stringify(pick[k]));
      await context.close();
    }
    {
      // Trusted Types 真的在執行期擋下字串型 innerHTML 與 createPolicy（這個探針本身會製造 CSP 違規與 console 錯誤，所以獨立開一個 context）
      const { context, page } = await newPage(browser, { width: 375 });
      await page.goto(baseUrl, { waitUntil: 'load' });
      await settle(page);
      const tt = await page.evaluate(() => { const out = {}; try { const d = document.createElement('div'); d.innerHTML = '<b>x</b>'; out.innerHTML = 'allowed'; } catch (e) { out.innerHTML = 'blocked'; } try { window.trustedTypes.createPolicy('default', { createHTML: s => s }); out.policy = 'allowed'; } catch (e) { out.policy = 'blocked'; } return out; });
      ok('string innerHTML and trustedTypes.createPolicy are both blocked by the CSP', tt.innerHTML === 'blocked' && tt.policy === 'blocked', JSON.stringify(tt));
      await context.close();
    }
    {
      const { context, page } = await newPage(browser, { width: 375 });
      await page.route('**/data.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.SITE_DATA = { broken: ,' }));
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForTimeout(800);
      const r = await page.evaluate(() => { const vis = (sel) => Array.from(document.querySelectorAll(sel)).some(el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; }); return { nojs: !!document.querySelector('link[href="nojs.css"]'), pills: vis('.site-nav__list a'), tiles: vis('.countdown__tile'), sections: vis('.section'), heroW: Math.round(document.querySelector('.hero__img').getBoundingClientRect().width) }; });
      ok('broken data.js falls back to the no-JS layout (no empty skeleton)', r.nojs && !r.pills && !r.tiles && !r.sections && r.heroW >= 200, JSON.stringify(r));
      const csp = await page.evaluate(() => window.__cspViolations);
      ok('broken data.js fallback causes no CSP violations', csp.length === 0, JSON.stringify(csp));
      await page.screenshot({ path: path.join(outDir, 'broken-data-375.png'), fullPage: true });
      await context.close();
    }

    // ---------- share button: without navigator.share it copies the canonical URL and announces it ----------
    for (const width of [375, 768, 1280]) {
      const { context, page } = await newPage(browser, { width, height: width < 700 ? 812 : 900, hasTouch: width < 700, isMobile: width < 700, permissions: ['clipboard-read', 'clipboard-write'] });
      // 明確拿掉 navigator.share（Linux 的 Chromium 本來就沒有），強制走「複製網址」的路徑
      await page.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'share', { value: undefined, configurable: true }); });
      await page.goto(baseUrl, { waitUntil: 'load' });
      await settle(page);
      const canonical = await page.evaluate(() => (document.querySelector('link[rel="canonical"]') || {}).href || null);
      ok(`canonical link exists for the share URL @${width}`, !!canonical && /^https:\/\//.test(canonical), String(canonical));
      const btn = page.locator('#share-btn');
      await btn.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.locator('.share').screenshot({ path: path.join(outDir, `share-idle-${width}.png`) });
      // keyboard: focus the button and press Enter (works like a click on a real <button>)
      await btn.focus();
      await page.waitForTimeout(100);
      await page.screenshot({ path: path.join(outDir, `share-focus-${width}.png`), fullPage: false });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(600);
      const s1 = await shareButtonInfo(page);
      ok(`pressing the share button shows the "copied" status (ja) @${width}`, !!s1 && /コピーしました/.test(s1.statusText) && s1.statusOpacity === 1, JSON.stringify(s1));
      const clip = await page.evaluate(() => navigator.clipboard.readText().catch(e => 'ERR ' + e.message));
      ok(`clipboard holds the canonical URL @${width}`, clip === canonical, `${clip} vs ${canonical}`);
      await page.locator('.share').screenshot({ path: path.join(outDir, `share-copied-${width}.png`) });
      const over = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      ok(`no horizontal overflow with the share status visible @${width}`, over.sw <= over.iw, JSON.stringify(over));
      // 切換語言：狀態文字跟著換
      await switchLang(page, 'zh');
      const s2 = await shareButtonInfo(page);
      ok(`share status text follows the language switch @${width}`, !!s2 && /已複製網址/.test(s2.statusText) && /分享/.test(s2.text), JSON.stringify(s2));
      await page.locator('.share').screenshot({ path: path.join(outDir, `share-copied-zh-${width}.png`) });
      // 幾秒後淡出並清空（不會留在無障礙樹裡被再唸一次）
      await page.waitForTimeout(5200);
      const s3 = await shareButtonInfo(page);
      ok(`share status fades out and clears after a few seconds @${width}`, !!s3 && s3.statusText === '' && s3.statusOpacity === 0, JSON.stringify(s3));
      ok(`no console errors in share session @${width}`, page.__errors.length === 0, JSON.stringify(page.__errors));
      await context.close();
    }
    // 連剪貼簿也不能用：狀態文字顯示網址本身（不會消失）
    {
      const { context, page } = await newPage(browser, { width: 375 });
      await page.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, 'share', { value: undefined, configurable: true });
        Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined, configurable: true });
      });
      await page.goto(baseUrl, { waitUntil: 'load' });
      await settle(page);
      const canonical = await page.evaluate(() => (document.querySelector('link[rel="canonical"]') || {}).href || null);
      await page.locator('#share-btn').click();
      await page.waitForTimeout(500);
      const s = await shareButtonInfo(page);
      ok('without clipboard the status shows the URL itself @375', !!s && !!canonical && s.statusText.includes(canonical) && s.statusOpacity === 1, JSON.stringify(s));
      // 網址是可聚焦的連結（鍵盤與螢幕閱讀器也能取用），冒號後沒有多餘的空格
      const urlLink = await page.evaluate(() => { const a = document.querySelector('#share-status a.share__url'); const t = document.querySelector('#share-status').firstChild; return { tag: a ? a.tagName : null, href: a ? a.href : null, before: t ? t.textContent : null }; });
      ok('the fallback URL is a link to the canonical URL with no space after the colon', urlLink.tag === 'A' && urlLink.href === canonical && !!urlLink.before && !/\s$/.test(urlLink.before), JSON.stringify(urlLink));
      const over = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      ok('no horizontal overflow with the URL shown @375', over.sw <= over.iw, JSON.stringify(over));
      await page.locator('.share').screenshot({ path: path.join(outDir, 'share-manual-375.png') });
      await page.waitForTimeout(4700);
      const s2 = await shareButtonInfo(page);
      ok('the URL stays visible (does not fade) @375', !!s2 && s2.statusText.includes(canonical) && s2.statusOpacity === 1, JSON.stringify(s2));
      ok('no console errors in manual-copy session @375', page.__errors.length === 0, JSON.stringify(page.__errors));
      await context.close();
    }
    // navigator.share 存在：會被呼叫、拿到標題／說明／網址；使用者取消（AbortError）時不顯示任何訊息
    {
      const { context, page } = await newPage(browser, { width: 375, permissions: ['clipboard-read', 'clipboard-write'] });
      await page.addInitScript(() => {
        window.__shared = [];
        Object.defineProperty(Navigator.prototype, 'share', {
          value: function (data) { window.__shared.push(data); const e = new Error('cancelled'); e.name = 'AbortError'; return Promise.reject(e); },
          configurable: true,
        });
      });
      await page.goto(baseUrl, { waitUntil: 'load' });
      await settle(page);
      await page.evaluate(() => navigator.clipboard.writeText('untouched'));
      await page.locator('#share-btn').click();
      await page.waitForTimeout(500);
      const shared = await page.evaluate(() => window.__shared);
      const canonical = await page.evaluate(() => (document.querySelector('link[rel="canonical"]') || {}).href || null);
      ok('navigator.share receives title, text and the canonical URL', shared.length === 1 && shared[0].url === canonical && /AYAKA/.test(shared[0].title || '') && (shared[0].text || '').length > 5, JSON.stringify(shared));
      const s = await shareButtonInfo(page);
      const clip = await page.evaluate(() => navigator.clipboard.readText().catch(e => 'ERR ' + e.message));
      ok('cancelling the share sheet (AbortError) shows nothing and does not copy', !!s && s.statusText === '' && s.statusOpacity === 0 && clip === 'untouched', JSON.stringify({ s, clip }));
      ok('no console errors in share-sheet session', page.__errors.length === 0, JSON.stringify(page.__errors));
      await context.close();
    }

    // ---------- JavaScript disabled: only the notice, the brand mark and the hero photo remain ----------
    for (const width of [375, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: width < 700 ? 812 : 900 }, deviceScaleFactor: scale, javaScriptEnabled: false, locale: 'ja-JP' });
      const page = await context.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(outDir, `nojs-${width}.png`), fullPage: true });
      const r = await page.evaluate(() => {
        const vis = (el) => { if (!el) return false; const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
        const anyVisible = (sel) => Array.from(document.querySelectorAll(sel)).some(vis);
        return {
          notice: Array.from(document.querySelectorAll('.noscript')).filter(vis).length,
          noticeFont: parseFloat(getComputedStyle(document.querySelector('.noscript')).fontSize),
          mark: vis(document.querySelector('.brand__mark')),
          heroW: Math.round((document.querySelector('.hero__img') || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width),
          navPills: anyVisible('.site-nav__list a'), langBtns: anyVisible('.lang-switch__btn'), tiles: anyVisible('.countdown__tile'),
          sections: anyVisible('.section'), cta: anyVisible('.hero__cta'), footer: anyVisible('.site-footer p'),
          docH: document.documentElement.scrollHeight, sw: document.documentElement.scrollWidth, iw: window.innerWidth,
        };
      });
      ok(`no-JS: notice is visible and readable @${width}`, r.notice >= 2 && r.noticeFont >= 16, JSON.stringify(r));
      ok(`no-JS: brand mark and hero photo remain @${width}`, r.mark && r.heroW >= 200, JSON.stringify(r));
      ok(`no-JS: no empty pills, countdown tiles or sections @${width}`, !r.navPills && !r.langBtns && !r.tiles && !r.sections && !r.cta && !r.footer, JSON.stringify(r));
      ok(`no-JS: no horizontal overflow @${width}`, r.sw <= r.iw, JSON.stringify(r));
      await context.close();
    }

    // ---------- countdown ----------
    {
      const { context, page } = await newPage(browser, { width: 375 });
      await page.goto(baseUrl, { waitUntil: 'load' });
      await settle(page);
      const t0 = await page.evaluate(() => (document.querySelector('[role="timer"]') || {}).textContent || '');
      ok('countdown timer element exists with digits', /\d/.test(t0), t0.slice(0, 80));
      await page.waitForTimeout(2500);
      const t1 = await page.evaluate(() => (document.querySelector('[role="timer"]') || {}).textContent || '');
      ok('countdown ticks', t0 !== t1, `${t0.slice(0, 60)} -> ${t1.slice(0, 60)}`);
      const live = await page.evaluate(() => (document.querySelector('[role="timer"]') || {}).getAttribute && document.querySelector('[role="timer"]').getAttribute('aria-live'));
      ok('timer aria-live is off', live === 'off', String(live));
      await page.goto(baseUrl + '#birthday-preview', { waitUntil: 'load' });
      await settle(page);
      const greet = await page.evaluate(() => (document.querySelector('#birthday') || {}).textContent || '');
      ok('birthday preview shows greeting', /おめでとう|生日快樂/.test(greet), greet.slice(0, 80));
      await page.locator('#birthday').screenshot({ path: path.join(outDir, 'birthday-preview-375.png') });
      await context.close();
    }

    // ---------- dark mode + reduced motion screenshots ----------
    for (const width of [375, 1280]) {
      const { context, page } = await newPage(browser, { width, height: width < 700 ? 812 : 900, colorScheme: 'dark', permissions: ['clipboard-write'] });
      await page.goto(baseUrl, { waitUntil: 'load' });
      await settle(page);
      await loadAllImages(page);
      await page.screenshot({ path: path.join(outDir, `dark-ja-${width}.png`), fullPage: true });
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      report.info[`darkBodyBg${width}`] = bg;
      ok(`dark mode changes body background @${width}`, !/rgb\(255, 255, 255\)/.test(bg), bg);
      // 精修後主視覺沒有光暈層了（原本這裡檢查深色模式的光暈用哪一組顏色）：改成確認深色模式下照片照常顯示、
      // 沒有殘留的光暈元素，頁首也不再用半透明＋模糊
      const heroDark = await page.evaluate(() => {
        const img = document.querySelector('.hero__img'); const b = img.getBoundingClientRect();
        const hs = getComputedStyle(document.querySelector('.site-header'));
        return { glow: !!document.querySelector('.hero__glow'), w: Math.round(b.width), loaded: img.complete && img.naturalWidth > 0, headerBlur: hs.backdropFilter || hs.webkitBackdropFilter || 'none', headerBg: hs.backgroundColor };
      });
      ok(`dark mode hero shows the photo with no glow layer; header is solid @${width}`, !heroDark.glow && heroDark.loaded && heroDark.w >= 200 && heroDark.headerBlur === 'none' && !/rgba\(/.test(heroDark.headerBg), JSON.stringify(heroDark));
      // 深色模式的分享按鈕與狀態文字
      await page.locator('#share-btn').scrollIntoViewIfNeeded();
      await page.locator('#share-btn').focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(600);
      const share = await shareButtonInfo(page);
      ok(`share status appears in dark mode @${width}`, !!share && share.statusText.length > 0 && share.statusOpacity === 1, JSON.stringify(share));
      await page.locator('.share').screenshot({ path: path.join(outDir, `share-dark-${width}.png`) });
      ok(`no console errors dark @${width}`, page.__errors.length === 0, JSON.stringify(page.__errors));
      await context.close();
    }
    {
      const { context, page } = await newPage(browser, { width: 375, reducedMotion: 'reduce' });
      await page.goto(baseUrl, { waitUntil: 'load' });
      await settle(page);
      await page.screenshot({ path: path.join(outDir, `reduced-motion-375.png`), fullPage: false });
      const anim = await page.evaluate(() => Array.from(document.querySelectorAll('*')).filter(el => { const s = getComputedStyle(el); return (s.animationName && s.animationName !== 'none' && parseFloat(s.animationDuration) > 0.011) || (s.transitionProperty !== 'none' && s.transitionProperty !== 'all 0s' && parseFloat(s.transitionDuration) > 0.011); }).map(el => el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : '')).slice(0, 10));
      ok('reduced motion disables animations/transitions', anim.length === 0, JSON.stringify(anim));
      // 「減少動態效果」開啟時，倒數不顯示每秒跳動的秒數；日、時、分照常顯示（A-07，網站主人 2026-11-11 決定採用）
      const rmUnits = await page.evaluate(() => Array.from(document.querySelectorAll('.countdown__tile')).filter(t => { const b = t.getBoundingClientRect(); return b.width > 0 && b.height > 0; }).map(t => t.querySelector('.countdown__num').getAttribute('data-unit')));
      ok('reduced motion: countdown shows days, hours and minutes but not the ticking seconds', rmUnits.join(',') === 'days,hours,minutes', rmUnits.join(','));
      await context.close();
    }
    {
      // 一般情況（沒有要求減少動態）：四個單位都在
      const { context, page } = await newPage(browser, { width: 375 });
      await page.goto(baseUrl, { waitUntil: 'load' });
      await settle(page);
      const units = await page.evaluate(() => Array.from(document.querySelectorAll('.countdown__tile')).filter(t => { const b = t.getBoundingClientRect(); return b.width > 0 && b.height > 0; }).map(t => t.querySelector('.countdown__num').getAttribute('data-unit')));
      ok('countdown shows days, hours, minutes and seconds by default', units.join(',') === 'days,hours,minutes,seconds', units.join(','));
      await context.close();
    }

    // ---------- focus-visible screenshots + skip link ----------
    {
      const { context, page } = await newPage(browser, { width: 375 });
      await page.goto(baseUrl, { waitUntil: 'load' });
      await settle(page);
      await page.keyboard.press('Tab');
      const first = await page.evaluate(() => ({ tag: document.activeElement.tagName, text: document.activeElement.textContent.trim(), href: document.activeElement.getAttribute('href') }));
      ok('first Tab lands on the skip link', first.tag === 'A' && /#main/.test(first.href || ''), JSON.stringify(first));
      await page.screenshot({ path: path.join(outDir, 'focus-skiplink-375.png'), fullPage: false });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(200);
      await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
      const shot = await page.evaluate(() => { const r = document.activeElement.getBoundingClientRect(); return { tag: document.activeElement.tagName, y: r.y, text: document.activeElement.textContent.trim().slice(0, 30) }; });
      report.info.focusAfterSkip = shot;
      await page.screenshot({ path: path.join(outDir, 'focus-visible-375.png'), fullPage: false });
      await context.close();
    }

    // ---------- header & nav: sticky part, keyboard focus, text spacing (V-01/A-01, A-02, A-03, A-05, V-02) ----------
    {
      // 手機：捲動後只有導覽列固定在上方（品牌列捲走），膠囊的焦點框不被切掉
      for (const [w, h] of [[375, 667], [320, 256], [280, 653]]) {
        const { context, page } = await newPage(browser, { width: w, height: h, hasTouch: true, isMobile: true });
        await page.goto(baseUrl, { waitUntil: 'load' });
        await settle(page);
        if (w === 280) {
          // 折疊機外螢幕（D2-01）：語言鈕和品牌同一列，頁首不多出一列、沒有橫向捲動
          const hd = await page.evaluate(() => ({ h: Math.round(document.querySelector('.site-header').getBoundingClientRect().height), langTop: Math.round(document.querySelector('.lang-switch').getBoundingClientRect().top), brandTop: Math.round(document.querySelector('.brand').getBoundingClientRect().top), sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
          ok(`header keeps brand and language switch on one row @${w}x${h}`, hd.h <= 112 && Math.abs(hd.langTop - hd.brandTop) < 12 && hd.sw <= hd.iw, JSON.stringify(hd));
        }
        await page.evaluate(() => window.scrollTo({ top: 900, behavior: 'instant' }));
        await page.waitForTimeout(400);
        const st = await page.evaluate(() => { const r = document.querySelector('.site-header').getBoundingClientRect(); const a = document.querySelector('.site-nav__list a').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), pillTop: Math.round(a.top) }; });
        ok(`only the nav row stays fixed after scrolling @${w}x${h}`, st.top < 0 && st.bottom <= 60 && st.pillTop >= 6, JSON.stringify(st));
        await page.screenshot({ path: path.join(outDir, `sticky-${w}x${h}.png`), clip: { x: 0, y: 0, width: w, height: Math.min(h, 200) } });
        // 往回 Shift+Tab 到語言鈕時頁面捲回最上面，語言鈕完整可見（A2-01）
        await page.evaluate(() => { window.scrollTo({ top: 2000, behavior: 'instant' }); document.querySelector('.site-nav__list a').focus(); });
        await page.keyboard.press('Shift+Tab');
        await page.waitForTimeout(300);
        const lf = await page.evaluate(() => { const r = document.activeElement.getBoundingClientRect(); return { lang: document.activeElement.getAttribute('data-lang'), top: Math.round(r.top), scrollY: Math.round(window.scrollY) }; });
        ok(`Shift+Tab back to the language button brings it into view @${w}x${h}`, lf.lang === 'zh' && lf.top >= 0 && lf.scrollY === 0, JSON.stringify(lf));
        await context.close();
      }
      // 從分享按鈕往回 Shift+Tab 經過兩組相簿：每一步的焦點元素都在固定頁首下方，焦點框四邊完整（A2-02）
      for (const width of [375, 1280]) {
        const { context, page } = await newPage(browser, { width, height: width < 700 ? 812 : 900, reducedMotion: 'reduce' });
        await page.goto(baseUrl, { waitUntil: 'load' });
        await settle(page);
        await page.evaluate(() => document.getElementById('share-btn').focus());
        const under = [];
        for (let i = 0; i < 18; i++) {
          await page.keyboard.press('Shift+Tab');
          await page.waitForTimeout(80);
          const p = await page.evaluate(() => { const r = document.activeElement.getBoundingClientRect(); return { top: Math.round(r.top), headerBottom: Math.round(document.querySelector('.site-header').getBoundingClientRect().bottom), tag: document.activeElement.tagName }; });
          if (!(p.top >= p.headerBottom)) under.push(p);
        }
        ok(`Shift+Tab back through the gallery never leaves a tile under the sticky header @${width}`, under.length === 0, JSON.stringify(under.slice(0, 3)));
        // 捲到底再回到頂端：導覽高亮清掉、導覽列捲回最左（V2-02）
        await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
        await page.waitForTimeout(500);
        const atBottom = await page.evaluate(() => (document.querySelector('.site-nav__list a[aria-current="true"]') || {}).textContent || null);
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await page.waitForTimeout(500);
        const atTop = await page.evaluate(() => ({ current: (document.querySelector('.site-nav__list a[aria-current="true"]') || {}).textContent || null, scrollLeft: document.querySelector('.site-nav__list').scrollLeft }));
        ok(`nav highlight clears and the nav list scrolls back when returning to the top @${width}`, !!atBottom && atTop.current === null && atTop.scrollLeft === 0, JSON.stringify({ atBottom, atTop }));
        await context.close();
      }
      // app.js 還沒填入文字時（擋掉 app.js），桌機頁首就已經是單列 68px：不會先變高再縮回（P2-01）
      for (const width of [900, 1280]) {
        const { context, page } = await newPage(browser, { width, height: 900 });
        await page.route('**/app.js', r => r.abort());
        await page.goto(baseUrl, { waitUntil: 'load' });
        await page.waitForTimeout(400);
        const hh = await page.evaluate(() => Math.round(document.querySelector('.site-header').getBoundingClientRect().height));
        ok(`header is one row (68px) before app.js fills the nav @${width}`, hh === 68, String(hh));
        await context.close();
      }
      // 手機與平板也一樣：擋掉 app.js 的骨架和正常載入後相比，品牌列、導覽列、主視覺文字的位置與高度一致（差 2px 以內），
      // 第一次繪製時下一區的底色不會先出現在畫面裡再被推走（精修時補上的預留高度；CLS）
      for (const [width, height] of [[375, 812], [768, 1024]]) {
        const probe = () => {
          const b = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)]; };
          return { header: b('.site-header'), nav: b('.site-nav'), heroText: b('.hero__text'), birthdayTop: b('#birthday')[0], vh: window.innerHeight };
        };
        const states = {};
        for (const mode of ['skeleton', 'filled']) {
          const { context, page } = await newPage(browser, { width, height, reducedMotion: 'reduce' });
          if (mode === 'skeleton') await page.route('**/app.js', r => r.abort());
          await page.goto(baseUrl, { waitUntil: 'load' });
          await page.waitForTimeout(400);
          states[mode] = await page.evaluate(probe);
          await context.close();
        }
        const near = (a, b) => Math.abs(a[0] - b[0]) <= 2 && Math.abs(a[1] - b[1]) <= 2;
        ok(`header, nav row and hero text keep their place when the text is filled in @${width}`, near(states.skeleton.header, states.filled.header) && near(states.skeleton.nav, states.filled.nav) && near(states.skeleton.heroText, states.filled.heroText), JSON.stringify(states));
        ok(`the next section's band is not in the first viewport before the profile is filled in @${width}`, states.skeleton.birthdayTop >= states.skeleton.vh, JSON.stringify({ top: states.skeleton.birthdayTop, vh: states.skeleton.vh }));
      }
      // 手機：Tab 走過導覽七項時，每顆膠囊都完整露出、不在右側淡出區底下；按 Enter 後下一個 Tab 進入目標區塊
      for (const width of [375, 1280]) {
        const { context, page } = await newPage(browser, { width, height: width < 700 ? 812 : 900 });
        await page.goto(baseUrl, { waitUntil: 'load' });
        await settle(page);
        for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');   // skip link → brand → ja → zh
        const pos = [];
        for (let i = 0; i < 7; i++) {
          await page.keyboard.press('Tab');
          await page.waitForTimeout(150);
          pos.push(await page.evaluate(() => { const r = document.activeElement.getBoundingClientRect(); return { t: document.activeElement.textContent, l: Math.round(r.left), r: Math.round(r.right), vw: window.innerWidth }; }));
        }
        ok(`every nav pill is fully visible when focused @${width}`, pos.every(p => p.l >= 0 && p.r <= p.vw - (width < 900 ? 40 : 0)), JSON.stringify(pos));
        if (width < 900) await page.screenshot({ path: path.join(outDir, `navfocus-${width}.png`), clip: { x: 0, y: 0, width, height: 120 } });
        await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Shift+Tab');   // 回到「フォト」
        const href = await page.evaluate(() => document.activeElement.getAttribute('href'));
        await page.keyboard.press('Enter');
        await page.waitForTimeout(700);
        const focusedSection = await page.evaluate(() => ({ id: document.activeElement.id, outline: getComputedStyle(document.activeElement).outlineStyle }));
        await page.keyboard.press('Tab');
        await page.waitForTimeout(200);
        const after = await page.evaluate(() => ({ tag: document.activeElement.tagName, inGallery: !!document.activeElement.closest('#gallery') }));
        ok(`Enter on a nav link moves focus to the section without an outline @${width}`, href === '#gallery' && focusedSection.id === 'gallery' && focusedSection.outline === 'none', JSON.stringify({ href, focusedSection }));
        ok(`after a nav link, the next Tab lands inside the target section @${width}`, after.inGallery && after.tag === 'BUTTON', JSON.stringify(after));
        // 語言鈕：選中態的底色要和群組底色不同（看得出哪個是選中的）
        const lang = await page.evaluate(() => { const on = document.querySelector('.lang-switch__btn[aria-pressed="true"]'); return { btn: getComputedStyle(on).backgroundColor, group: getComputedStyle(document.querySelector('.lang-switch')).backgroundColor }; });
        ok(`selected language button has a distinct background @${width}`, lang.btn !== lang.group && lang.btn !== 'rgba(0, 0, 0, 0)', JSON.stringify(lang));
        await context.close();
      }
      // 桌機：放大文字間距（WCAG 1.4.12）時導覽換行，不在看不見的捲動容器裡被裁掉；未放大時仍是單列
      for (const width of [900, 1280, 1440]) {
        const { context, page } = await newPage(browser, { width, height: 900, bypassCSP: true });
        await page.goto(baseUrl, { waitUntil: 'load' });
        await settle(page);
        await page.addStyleTag({ content: '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }' });
        await page.waitForTimeout(300);
        const sp = await page.evaluate(() => { const l = document.querySelector('.site-nav__list'); const links = Array.from(l.querySelectorAll('a')); const last = links[links.length - 1].getBoundingClientRect(); return { sw: l.scrollWidth, cw: l.clientWidth, lastRight: Math.round(last.right), vw: window.innerWidth, over: document.documentElement.scrollWidth > window.innerWidth }; });
        ok(`nav is not clipped with enlarged text spacing @${width}`, sp.sw <= sp.cw && sp.lastRight <= sp.vw && !sp.over, JSON.stringify(sp));
        await page.locator('.site-header').screenshot({ path: path.join(outDir, `header-spacing-${width}.png`) });
        await context.close();
      }
    }

    // ---------- axe-core (light + dark) ----------
    if (axeSource) {
      for (const scheme of ['light', 'dark']) {
        const { context, page } = await newPage(browser, { width: 1280, height: 900, colorScheme: scheme, bypassCSP: true });
        await page.goto(baseUrl, { waitUntil: 'load' });
        await settle(page);
        await page.waitForTimeout(1700); // 等開場動畫結束，對比檢查才準
        await page.evaluate(axeSource);
        const res = await page.evaluate(async () => { const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } }); return r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 5).map(n => n.target.join(' ')) })); });
        report.info[`axe_${scheme}`] = res;
        ok(`axe: no serious/critical violations (${scheme})`, res.filter(v => ['serious', 'critical'].includes(v.impact)).length === 0, JSON.stringify(res.filter(v => ['serious', 'critical'].includes(v.impact))));
        if (res.length) warn(`axe ${scheme} (all impacts)`, JSON.stringify(res));
        // run axe with the lightbox open too（兩組各開一次）
        for (const [label, selector] of [['lightbox', '#gallery-grid button'], ['call lightbox', '#gallery-grid-call button']]) {
          await page.locator(selector).nth(0).click();
          await page.waitForTimeout(400);
          const res2 = await page.evaluate(async () => { const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }); return r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 5).map(n => n.target.join(' ')) })); });
          ok(`axe with ${label} open: no serious/critical (${scheme})`, res2.filter(v => ['serious', 'critical'].includes(v.impact)).length === 0, JSON.stringify(res2));
          await page.keyboard.press('Escape');
          await page.waitForTimeout(300);
        }
        await context.close();
      }
    } else warn('axe-core not installed; skipped');

    // ---------- letter.html（彩花への手紙）＋首頁的入口 ----------
    const indexCsp = report.info.security ? report.info.security.csp : null;   // 信頁的 CSP 必須和首頁一字不差
    const letterUrl = baseUrl.replace(/\/?$/, '/') + 'letter.html';
    async function settleLetter(page) {
      await page.waitForFunction(() => document.querySelectorAll('.letter__p').length >= 10 && document.querySelector('.letter__signature').textContent.length > 0, null, { timeout: 15000 });
      await page.waitForTimeout(300);
    }
    for (const width of [375, 768, 1280]) {
      const { context, page } = await newPage(browser, { width, height: width < 700 ? 812 : 900 });
      await page.goto(letterUrl, { waitUntil: 'load' });
      await settleLetter(page);
      ok(`letter: default lang is ja @${width}`, (await page.evaluate(() => document.documentElement.lang)) === 'ja');
      const over = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      ok(`letter: no horizontal overflow @${width} (ja)`, over.sw <= over.iw, JSON.stringify(over));
      await page.screenshot({ path: path.join(outDir, `letter-ja-${width}.png`), fullPage: true });
      const jaText = await collectText(page);
      const jaTitle = await page.title();
      // 閱讀寬度：600px 以上每行約 30～36 個日文字
      const measure = await page.evaluate(() => { const p = document.querySelector('.letter__p'); const cs = getComputedStyle(p); return { chars: p.getBoundingClientRect().width / parseFloat(cs.fontSize), lh: parseFloat(cs.lineHeight) / parseFloat(cs.fontSize) }; });
      if (width >= 600) ok(`letter: 30–36 characters per line @${width}`, measure.chars >= 30 && measure.chars <= 36, JSON.stringify(measure));
      ok(`letter: line-height at least 2 @${width}`, measure.lh >= 2, JSON.stringify(measure));
      // 準備過的三句話：換行只發生在「小塊」之間（例如不會把「だいすき」拆成兩行），畫面上的字和原文一樣
      const words = await page.evaluate(() => ({
        split: Array.from(document.querySelectorAll('.letter__chunk')).filter(c => c.getBoundingClientRect().height > parseFloat(getComputedStyle(c).lineHeight) * 1.5).map(c => c.textContent),
        text: Array.from(document.querySelectorAll('.letter__word')).map(li => li.textContent),
        paragraphBreaks: Array.from(document.querySelectorAll('.letter__p')).filter(p => p.textContent.indexOf('\n') !== -1 && getComputedStyle(p).whiteSpace.indexOf('pre-line') === -1 && getComputedStyle(p).whiteSpaceCollapse !== 'preserve-breaks').length
      }));
      ok(`letter: prepared lines wrap only between phrases @${width}`, words.split.length === 0, JSON.stringify(words.split));
      ok(`letter: prepared lines read exactly as written @${width}`, words.text.length === 3 && words.text[1] === 'いま、じんせいでいちばんだいすきなのはアヤカ！', JSON.stringify(words.text));
      ok(`letter: line breaks inside paragraphs are rendered @${width}`, words.paragraphBreaks === 0, String(words.paragraphBreaks));
      const structure = await page.evaluate(() => ({
        h1: document.querySelectorAll('h1').length,
        h2: document.querySelectorAll('.letter__body h2').length,
        sections: Array.from(document.querySelectorAll('.letter__section')).map(s => s.id + ':' + s.getAttribute('aria-labelledby')),
        wordsLang: (document.querySelector('.letter__words') || {}).getAttribute && document.querySelector('.letter__words').getAttribute('lang'),
        wordsRole: (document.querySelector('.letter__words') || {}).getAttribute && document.querySelector('.letter__words').getAttribute('role'),
        signature: document.querySelector('.letter__signature').textContent,
        navCount: document.querySelectorAll('.site-nav, .site-nav__list a').length,
        brandHref: (document.querySelector('.site-header .brand') || {}).getAttribute && document.querySelector('.site-header .brand').getAttribute('href'),
        headerPosition: getComputedStyle(document.querySelector('.site-header')).position,
        robots: (document.querySelector('meta[name="robots"]') || {}).content || null,
        footerPhoto: !!document.querySelector('#footer-photo'),
        paperFont: getComputedStyle(document.querySelector('.letter__paper')).fontFamily,
        links: Array.from(document.querySelectorAll('.letter__body a')).map(a => a.getAttribute('href')),
        back: (document.querySelector('#letter-back') || {}).getAttribute && document.querySelector('#letter-back').getAttribute('href'),
        empties: Array.from(document.querySelectorAll('#letter-title, #letter-lead, #letter-salutation, #letter-date, #letter-signature, #letter-back, .letter__h, .letter__p')).filter(n => !n.textContent.trim()).length,
      }));
      if (width === 375) {
        ok('letter: one h1 and one h2 per section', structure.h1 === 1 && structure.h2 === structure.sections.length && structure.sections.length >= 3, JSON.stringify(structure.sections));
        ok('letter: prepared Japanese lines are marked lang="ja" in a list', structure.wordsLang === 'ja' && structure.wordsRole === 'list');
        ok('letter: signature keeps YU HONG', /YU HONG/.test(structure.signature), structure.signature);
        ok('letter: no navigation bar, header not sticky, brand links back to index.html', structure.navCount === 0 && structure.brandHref === 'index.html' && structure.headerPosition === 'static', JSON.stringify({ nav: structure.navCount, brand: structure.brandHref, pos: structure.headerPosition }));
        ok('letter: meta robots noindex', /noindex/.test(structure.robots || ''), String(structure.robots));
        ok('letter: no photo notice in the footer', structure.footerPhoto === false);
        ok('letter: paper uses the serif (mincho) stack', /Mincho|Serif|serif|PMingLiU|Songti/.test(structure.paperFont), structure.paperFont);
        ok('letter: in-letter links are relative and point at the home page', structure.links.length >= 1 && structure.links.every(h => /^index\.html#[a-z]+$/.test(h)) && structure.back === 'index.html', JSON.stringify(structure.links));
        ok('letter: no empty text slots after rendering', structure.empties === 0, String(structure.empties));
        report.info.letterStructure = structure;
      }

      await switchLang(page, 'zh');
      ok(`letter: lang attr becomes zh-Hant @${width}`, (await page.evaluate(() => document.documentElement.lang)) === 'zh-Hant');
      const over2 = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      ok(`letter: no horizontal overflow @${width} (zh)`, over2.sw <= over2.iw, JSON.stringify(over2));
      await page.screenshot({ path: path.join(outDir, `letter-zh-${width}.png`), fullPage: true });
      const zhText = await collectText(page);
      const zhTitle = await page.title();
      ok(`letter: title changes with language @${width}`, jaTitle !== zhTitle && /手紙|信/.test(zhTitle), `${jaTitle} / ${zhTitle}`);
      if (width === 375) {
        const zhSet = new Set(zhText);
        const leftover = jaText.filter(t => zhSet.has(t) && /[぀-ヿ]/.test(t) && !t.startsWith('@'));
        ok('letter: no Japanese-kana text left after switching to zh (except lines marked lang="ja")', leftover.length === 0, JSON.stringify(leftover));
        const zhWords = await page.evaluate(() => Array.from(document.querySelectorAll('.letter__words[lang="ja"] li')).length);
        ok('letter: prepared Japanese lines stay in Japanese in the zh version', zhWords >= 1, String(zhWords));
        // 語言設定與首頁共用：在手紙頁切成中文後，回到首頁也是中文
        await page.goto(baseUrl, { waitUntil: 'load' });
        await settle(page);
        ok('letter: language choice is shared with the home page', (await page.evaluate(() => document.documentElement.lang)) === 'zh-Hant');
        await page.goto(letterUrl, { waitUntil: 'load' });
        await settleLetter(page);
        ok('letter: language persists after reload', (await page.evaluate(() => document.documentElement.lang)) === 'zh-Hant');
        await switchLang(page, 'ja');
      }

      const sec = await page.evaluate(() => ({
        inlineScripts: Array.from(document.scripts).filter(s => !s.src).length,
        styleEls: document.querySelectorAll('style').length,
        styleAttrs: document.querySelectorAll('[style]').length,
        onAttrs: Array.from(document.querySelectorAll('*')).filter(el => Array.from(el.attributes).some(a => /^on/i.test(a.name))).length,
        csp: (document.querySelector('meta[http-equiv="Content-Security-Policy"]') || {}).content || null,
        referrer: (document.querySelector('meta[name="referrer"]') || {}).content || null,
        external: Array.from(document.querySelectorAll('script[src],link[href]:not([rel~="canonical"]):not([rel~="alternate"]),img[src],source[srcset]')).map(e => e.src || e.href || e.srcset).filter(u => u && !u.startsWith(location.origin)),
      }));
      if (width === 375) {
        report.info.letterSecurity = sec;
        ok('letter: no inline scripts/styles/on* attributes', sec.inlineScripts === 0 && sec.styleEls === 0 && sec.styleAttrs === 0 && sec.onAttrs === 0, JSON.stringify(sec));
        ok('letter: CSP meta is the same strict policy as index.html', !!sec.csp && sec.csp === indexCsp && /trusted-types 'none'/.test(sec.csp), sec.csp + ' vs ' + indexCsp);
        ok('letter: referrer meta no-referrer', sec.referrer === 'no-referrer', sec.referrer);
        ok('letter: no external resources', sec.external.length === 0, JSON.stringify(sec.external));
      }
      const csp = await page.evaluate(() => window.__cspViolations);
      ok(`letter: no CSP violations @${width}`, csp.length === 0, JSON.stringify(csp));
      ok(`letter: no console errors @${width}`, page.__errors.length === 0, JSON.stringify(page.__errors));
      await context.close();
    }

    // 首頁的入口：留言區下方的小卡，點了會到 letter.html；語言設定帶過去
    for (const width of [375, 1280]) {
      const { context, page } = await newPage(browser, { width, height: width < 700 ? 812 : 900 });
      await page.goto(baseUrl, { waitUntil: 'load' });
      await settle(page);
      const entry = await page.evaluate(() => {
        const a = document.querySelector('#messages a.letter-entry');
        const txt = (sel) => (a && a.querySelector(sel) ? a.querySelector(sel).textContent.trim() : '');
        return a ? { label: !!document.querySelector('.letter-entry__eyebrow, .letter__kicker'), title: txt('.letter-entry__title'), text: txt('.letter-entry__text'), cta: txt('.letter-entry__cta'), href: a.getAttribute('href'), count: document.querySelectorAll('.letter-entry').length, nav: document.querySelectorAll('.site-nav__list a').length, width: a.getBoundingClientRect().width } : null;
      });
      // 入口小卡原本還有「LETTER」英文小標；它和標題意思重複，已拿掉（網站主人 2026-11-11 交由設計決定）
      ok(`home: letter entry card sits in the messages section with title, text, CTA and href, and no English label @${width}`, !!entry && !entry.label && entry.title && entry.text && entry.cta && entry.href === 'letter.html' && entry.count === 1, JSON.stringify(entry));
      if (width === 1280) ok('home: letter entry card is at most 560px wide', entry && entry.width <= 560, String(entry && entry.width));
      // 合言葉のページ（私密區，另一個網站）的入口：data.js 的 site.roomUrl 還沒填時不顯示；填了才出現一行小字連結
      const room = await page.evaluate(() => {
        const p = document.getElementById('room-entry');
        const a = p && p.querySelector('a');
        const url = window.SITE_DATA.site.roomUrl;
        return p ? { configured: !!url, hidden: p.hidden, visible: p.getClientRects().length > 0, href: a ? a.getAttribute('href') : null, text: a ? a.textContent.trim() : '', rel: a ? a.getAttribute('rel') : null } : null;
      });
      ok(`home: the room entrance stays hidden until site.roomUrl is set; when set it is an https link carrying the language @${width}`,
        !!room && (room.configured
          ? (!room.hidden && room.visible && /^https:\/\/[^/]+\/\?lang=ja$/.test(room.href || '') && !!room.text && room.rel === 'nofollow')
          : (room.hidden && !room.visible && !room.href)), JSON.stringify(room));
      if (width === 375) ok('home: the letter has no navigation item of its own (seven section links)', entry && entry.nav === 7, String(entry && entry.nav));
      await page.locator('#messages').scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.locator('#messages').screenshot({ path: path.join(outDir, `letter-entry-${width}.png`) });
      await switchLang(page, 'zh');
      await page.locator('#messages a.letter-entry').click();
      await page.waitForURL(/letter\.html$/, { timeout: 10000 });
      await settleLetter(page);
      ok(`home: entry link opens letter.html in the chosen language @${width}`, (await page.evaluate(() => document.documentElement.lang)) === 'zh-Hant');
      ok(`home→letter: no console errors @${width}`, page.__errors.length === 0, JSON.stringify(page.__errors));
      await context.close();
    }

    // 手紙頁：深色模式、減少動態、停用 JavaScript、鍵盤焦點
    for (const width of [375, 1280]) {
      const { context, page } = await newPage(browser, { width, height: width < 700 ? 812 : 900, colorScheme: 'dark' });
      await page.goto(letterUrl, { waitUntil: 'load' });
      await settleLetter(page);
      await page.screenshot({ path: path.join(outDir, `letter-dark-ja-${width}.png`), fullPage: true });
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      ok(`letter: dark mode changes body background @${width}`, !/rgb\(255, 255, 255\)/.test(bg), bg);
      ok(`letter: no console errors dark @${width}`, page.__errors.length === 0, JSON.stringify(page.__errors));
      await context.close();
    }
    {
      const { context, page } = await newPage(browser, { width: 375, reducedMotion: 'reduce' });
      await page.goto(letterUrl, { waitUntil: 'load' });
      await settleLetter(page);
      const anim = await page.evaluate(() => Array.from(document.querySelectorAll('*')).filter(el => { const s = getComputedStyle(el); return (s.animationName && s.animationName !== 'none' && parseFloat(s.animationDuration) > 0.011) || (s.transitionProperty !== 'none' && s.transitionProperty !== 'all 0s' && parseFloat(s.transitionDuration) > 0.011); }).map(el => el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : '')).slice(0, 10));
      ok('letter: reduced motion disables animations/transitions', anim.length === 0, JSON.stringify(anim));
      await page.keyboard.press('Tab');
      const first = await page.evaluate(() => ({ tag: document.activeElement.tagName, href: document.activeElement.getAttribute('href') }));
      ok('letter: first Tab lands on the skip link', first.tag === 'A' && /#main/.test(first.href || ''), JSON.stringify(first));
      await page.keyboard.press('Enter');
      await page.waitForTimeout(200);
      await page.keyboard.press('Tab');
      const after = await page.evaluate(() => { const a = document.activeElement; const r = a.getBoundingClientRect(); return { text: a.textContent.trim().slice(0, 30), inMain: !!a.closest('main'), outline: getComputedStyle(a).outlineStyle }; });
      ok('letter: after the skip link, Tab reaches the first link in the letter', after.inMain, JSON.stringify(after));
      await page.screenshot({ path: path.join(outDir, 'letter-focus-375.png'), fullPage: false });
      await context.close();
    }
    for (const width of [375, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: width < 700 ? 812 : 900 }, deviceScaleFactor: scale, javaScriptEnabled: false, locale: 'ja-JP' });
      const page = await context.newPage();
      await page.goto(letterUrl, { waitUntil: 'load' });
      await page.waitForTimeout(600);
      const r = await page.evaluate(() => {
        const vis = (el) => { if (!el) return false; const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
        return { notice: Array.from(document.querySelectorAll('.noscript')).filter(vis).length, mark: vis(document.querySelector('.brand__mark')), letter: vis(document.querySelector('.letter')), footer: vis(document.querySelector('.site-footer p')), sw: document.documentElement.scrollWidth, iw: window.innerWidth };
      });
      ok(`letter no-JS: only the notice and the brand mark remain @${width}`, r.notice >= 2 && r.mark && !r.letter && !r.footer && r.sw <= r.iw, JSON.stringify(r));
      await context.close();
    }
    {
      // letter-data.js 壞掉時：和首頁一樣退回 nojs.css（不剩下空白便箋），而且沒有 CSP 違規
      const { context, page } = await newPage(browser, { width: 375 });
      await page.route('**/letter-data.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.LETTER_DATA = { broken: ,' }));
      await page.goto(letterUrl, { waitUntil: 'load' });
      await page.waitForTimeout(800);
      const r = await page.evaluate(() => { const vis = (sel) => Array.from(document.querySelectorAll(sel)).some(el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; }); return { nojs: !!document.querySelector('link[href="nojs.css"]'), letter: vis('.letter'), paper: vis('.letter__paper'), mark: vis('.brand__mark') }; });
      ok('letter: broken letter-data.js falls back to the no-JS layout (no empty paper)', r.nojs && !r.letter && !r.paper && r.mark, JSON.stringify(r));
      const csp = await page.evaluate(() => window.__cspViolations);
      ok('letter: broken letter-data.js fallback causes no CSP violations', csp.length === 0, JSON.stringify(csp));
      await context.close();
    }
    if (axeSource) {
      for (const scheme of ['light', 'dark']) {
        for (const width of [375, 1280]) {
          const { context, page } = await newPage(browser, { width, height: width < 700 ? 812 : 900, colorScheme: scheme, bypassCSP: true });
          await page.goto(letterUrl, { waitUntil: 'load' });
          await settleLetter(page);
          await page.evaluate(axeSource);
          const res = await page.evaluate(async () => { const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } }); return r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 5).map(n => n.target.join(' ')) })); });
          report.info[`axe_letter_${scheme}_${width}`] = res;
          ok(`letter axe: no serious/critical violations (${scheme} @${width})`, res.filter(v => ['serious', 'critical'].includes(v.impact)).length === 0, JSON.stringify(res.filter(v => ['serious', 'critical'].includes(v.impact))));
          if (res.length) warn(`letter axe ${scheme} @${width} (all impacts)`, JSON.stringify(res));
          await context.close();
        }
      }
    }
    /* ---------- 內容補充（2026-11-14）：個人資料、興趣、作品與訪談、年表連結、出處、官方連結 ---------- */
    for (const width of [375, 768, 1280]) {
      for (const lang of ['ja', 'zh']) {
        const { context, page } = await newPage(browser, { width, height: width < 700 ? 812 : 900 });
        await page.goto(baseUrl, { waitUntil: 'load' });
        if (lang === 'zh') {
          await page.evaluate(() => localStorage.setItem(window.SITE_DATA.site.storageKey, 'zh'));
          await page.goto(baseUrl, { waitUntil: 'load' });
        }
        await settle(page);
        const tag = `@${width} ${lang}`;
        const c = await page.evaluate(() => {
          const D = window.SITE_DATA;
          const txt = (el) => (el ? el.textContent.trim() : '');
          const all = (sel, root) => Array.from((root || document).querySelectorAll(sel));
          const dates = all('#timeline-list time[datetime]').map((t) => t.getAttribute('datetime'));
          const ext = all('a[href]').filter((a) => a.origin !== location.origin);
          return {
            closedByDefault: all('details.sources').every((d) => !d.open),
            profileRows: all('#profile-list .profile__row').length,
            profileExpected: D.profile.filter((r) => r.value != null).length,
            placeholders: all('#profile .profile__row--placeholder, #profile .profile__value--placeholder').length,
            profileText: txt(document.querySelector('#profile-list')),
            hobbyRows: all('#hobbies-list .profile__row').length,
            hobbyExpected: D.hobbies.items.length,
            hobbyLead: txt(document.querySelector('#profile-hobbies .block__lead')),
            works: all('#works-list .entry').map((e) => ({ id: e.id, title: txt(e.querySelector('h4')), metas: all('.entry__meta', e).length, text: txt(e.querySelector('.entry__text')).length, links: all('.entry__links a', e).length })),
            worksExpected: D.works.map((w) => ({ id: 'work-' + w.id, links: 1 + w.sources.length })),
            interviews: all('#interviews-list .entry').map((e) => ({ title: txt(e.querySelector('h4')), texts: all('.entry__text', e).length, links: all('.entry__links a', e).length })),
            interviewsExpected: D.interviews.length,
            dates,
            timelineExpected: D.timeline.filter((t) => !t.placeholder).length,
            tlLinks: all('.timeline__link').map((a) => ({ href: a.getAttribute('href'), target: !!document.querySelector(a.getAttribute('href')), label: a.getAttribute('aria-label') })),
            tlLinksExpected: D.timeline.filter((t) => t.link).length,
            sourceLists: ['#profile-sources-list', '#timeline-sources-list'].map((s) => all(s + ' li').length),
            summaries: all('.sources__summary').map(txt),
            links: all('#links-list a').map((a) => a.getAttribute('href')),
            linksExpected: D.links.map((l) => l.url),
            handle: txt(document.querySelector('.links__handle')),
            linksNote: txt(document.querySelector('#links-note')),
            noteLink: !!document.querySelector('#links-note a[target="_blank"]'),
            ext: ext.map((a) => ({ href: a.href, target: a.target, rel: a.rel, hint: txt(a.querySelector('.visually-hidden')) })),
            blank: all('a[target="_blank"]').length,
            emptyUi: all('main [data-ui]').filter((n) => !txt(n)).map((n) => n.getAttribute('data-ui')),
            emptyNew: all('.block__title, .block__lead, .entry__title, .entry__meta, .entry__text, .links__title, .sources__summary').filter((n) => !txt(n)).length,
            navLinks: all('.site-nav__list a').length,
            navTops: Array.from(new Set(all('.site-nav__list a').map((a) => Math.round(a.getBoundingClientRect().top)))).length,
            headings: all('#works h2, #works h3, #works h4, #profile h2, #profile h3').map((h) => h.tagName).join(' '),
          };
        });
        ok(`profile: only filled rows are shown, no placeholders ${tag}`, c.profileRows === c.profileExpected && c.profileRows >= 9 && c.placeholders === 0 && !/確認中|待補/.test(c.profileText), JSON.stringify({ rows: c.profileRows, expected: c.profileExpected, placeholders: c.placeholders }));
        ok(`profile: blood type, hometown, phrase, NIZOO and the full debut date are shown ${tag}`, /A\s?型/.test(c.profileText) && /東京都/.test(c.profileText) && /NiziUのふわふわビューティー/.test(c.profileText) && /ANO（アノ）/.test(c.profileText) && /2020\s?年\s?12\s?月\s?2\s?日/.test(c.profileText) && !/身長|身高|ニックネーム|暱稱/.test(c.profileText), c.profileText.slice(0, 120));
        ok(`hobbies: dated block with its rows ${tag}`, c.hobbyRows === c.hobbyExpected && /2025\s?年\s?9\s?月/.test(c.hobbyLead), JSON.stringify({ rows: c.hobbyRows, lead: c.hobbyLead }));
        ok(`works: every work has an anchor id, title, two meta lines, text and its links ${tag}`, c.works.length === c.worksExpected.length && c.works.every((w, i) => w.id === c.worksExpected[i].id && w.title && w.metas === 2 && w.text > 20 && w.links === c.worksExpected[i].links), JSON.stringify(c.works));
        ok(`interviews: every summary has a title, text and a source link ${tag}`, c.interviews.length === c.interviewsExpected && c.interviews.every((i) => i.title && i.texts >= 1 && i.links >= 1), JSON.stringify(c.interviews));
        ok(`timeline: ${c.timelineExpected} dated entries in ascending order with no duplicate dates ${tag}`, c.dates.length === c.timelineExpected && c.dates.length >= 18 && c.dates.join() === c.dates.slice().sort().join() && new Set(c.dates).size === c.dates.length, c.dates.join(' '));
        ok(`timeline: links to the works section point at existing entries and name the song ${tag}`, c.tlLinks.length === c.tlLinksExpected && c.tlLinks.every((l) => /^#work-/.test(l.href) && l.target && l.label && l.label.length > 4), JSON.stringify(c.tlLinks));
        ok(`sources: both lists are collapsed by default, labelled and filled ${tag}`, c.closedByDefault && c.sourceLists.every((n) => n >= 5) && c.summaries.length === 2 && c.summaries.every((s) => s === (lang === 'zh' ? '資料來源' : '出典')), JSON.stringify({ closed: c.closedByDefault, lists: c.sourceLists, summaries: c.summaries }));
        ok(`official links: site and Instagram, handle outside the underlined link, account source noted ${tag}`, c.links.join() === c.linksExpected.join() && c.links.length >= 2 && /^@/.test(c.handle) && /SPUR/.test(c.linksNote) && c.noteLink, JSON.stringify({ links: c.links, handle: c.handle, note: c.linksNote }));
        ok(`external links: https, new tab, rel="noopener noreferrer", screen-reader hint ${tag}`, c.ext.length >= 20 && c.ext.length === c.blank && c.ext.every((a) => /^https:\/\//.test(a.href) && a.target === '_blank' && /\bnoopener\b/.test(a.rel) && /\bnoreferrer\b/.test(a.rel) && a.hint.length > 3), JSON.stringify(c.ext.filter((a) => !(a.target === '_blank' && /\bnoopener\b/.test(a.rel) && /\bnoreferrer\b/.test(a.rel))).slice(0, 3)) + ` (${c.ext.length} external, ${c.blank} target=_blank)`);
        ok(`no missing strings in the new blocks ${tag}`, c.emptyUi.length === 0 && c.emptyNew === 0, JSON.stringify({ ui: c.emptyUi, empty: c.emptyNew }));
        ok(`heading levels: h2 > h3 > h4 in profile and works ${tag}`, c.headings === 'H2 H3 H2 H3 H4 H4 H3 H4 H4', c.headings);
        ok(`nav: seven items${width >= 900 ? ' on one row' : ''} ${tag}`, c.navLinks === 7 && (width < 900 || c.navTops === 1), JSON.stringify({ links: c.navLinks, rows: c.navTops }));

        // 展開兩個出處清單之後：沒有橫向捲動，連結與文字都在畫面內
        await page.evaluate(() => document.querySelectorAll('details.sources').forEach((d) => { d.open = true; }));
        const o = await page.evaluate(() => {
          const vw = document.documentElement.clientWidth;
          const out = Array.from(document.querySelectorAll('.entry__title, .entry__meta, .entry__text, .entry__links a, .sources__list li, .sources__list a, .links__list a, .links__handle, .links__note, #hobbies-list .profile__value')).filter((n) => { const b = n.getBoundingClientRect(); return b.width > 0 && (b.right > vw + 0.5 || b.left < -0.5); }).map((n) => n.className + ':' + n.textContent.slice(0, 20));
          return { sw: document.documentElement.scrollWidth, vw, out };
        });
        ok(`new content fits the viewport with the source lists open ${tag}`, o.sw <= o.vw && o.out.length === 0, JSON.stringify(o));
        if (lang === 'ja' || width !== 768) {
          for (const [sel, name] of [['#profile', 'profile'], ['#works', 'works'], ['#about', 'about'], ['#timeline-sources', 'timeline-sources']]) {
            await page.locator(sel).scrollIntoViewIfNeeded();
            await page.locator(sel).screenshot({ path: path.join(outDir, `content-${name}-${lang}-${width}.png`) });
          }
        }
        ok(`new content: no console errors or CSP violations ${tag}`, page.__errors.length === 0 && (await page.evaluate(() => window.__cspViolations)).length === 0, JSON.stringify(page.__errors.slice(0, 3)));
        await context.close();
      }
    }
    for (const width of [375, 1280]) {
      // 鍵盤操作：出處清單用 Enter 展開／收合、有焦點框；切換語言後維持展開；年表的連結會把焦點帶到那首歌，而且不被頁首蓋住
      const { context, page } = await newPage(browser, { width, height: width < 700 ? 812 : 900 });
      await page.goto(baseUrl, { waitUntil: 'load' });
      await settle(page);
      await page.keyboard.press('Tab');   // 先用鍵盤操作一次，瀏覽器才會把之後的焦點當成鍵盤焦點（:focus-visible）
      await page.evaluate(() => document.querySelector('#profile-sources summary').focus());
      const ring = await page.evaluate(() => { const s = document.querySelector('#profile-sources summary'); const cs = getComputedStyle(s); return { focused: document.activeElement === s, visible: s.matches(':focus-visible'), style: cs.outlineStyle, width: cs.outlineWidth }; });
      ok(`sources: the summary takes keyboard focus with a visible ring @${width}`, ring.focused && ring.visible && ring.style !== 'none' && parseFloat(ring.width) >= 2, JSON.stringify(ring));
      await page.keyboard.press('Enter');
      const opened = await page.evaluate(() => { const d = document.querySelector('#profile-sources'); const a = d.querySelector('li a'); return { open: d.open, linkVisible: !!a && a.getBoundingClientRect().height > 0 }; });
      ok(`sources: Enter opens the list @${width}`, opened.open && opened.linkVisible, JSON.stringify(opened));
      await page.evaluate(() => document.querySelector('.lang-switch__btn[data-lang="zh"]').click());
      const kept = await page.evaluate(() => { const d = document.querySelector('#profile-sources'); return { open: d.open, summary: d.querySelector('summary').textContent.trim(), first: (d.querySelector('li') || {}).textContent }; });
      ok(`sources: the list stays open and is re-rendered when the language changes @${width}`, kept.open && kept.summary === '資料來源' && /藝名/.test(kept.first || ''), JSON.stringify(kept));
      await page.evaluate(() => document.querySelector('.lang-switch__btn[data-lang="ja"]').click());
      await page.evaluate(() => document.querySelector('#profile-sources summary').focus());
      await page.keyboard.press('Enter');
      ok(`sources: Enter closes the list again @${width}`, await page.evaluate(() => !document.querySelector('#profile-sources').open));

      const link = page.locator('.timeline__link').first();
      await link.scrollIntoViewIfNeeded();
      await link.focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1200);   // 平滑捲動
      const jump = await page.evaluate(() => {
        const target = document.querySelector(location.hash || '#none');
        if (!target) { return { hash: location.hash }; }
        const b = target.getBoundingClientRect();
        const fixed = Array.from(document.querySelectorAll('.site-header, .site-nav')).filter((n) => { const p = getComputedStyle(n).position; return p === 'fixed' || p === 'sticky'; });
        const covered = Math.max(0, ...fixed.map((n) => n.getBoundingClientRect().bottom));
        return { hash: location.hash, top: Math.round(b.top), covered: Math.round(covered), vh: window.innerHeight, active: document.activeElement === target, outline: getComputedStyle(target).outlineStyle };
      });
      ok(`timeline link: jumps to the song, below the fixed header, focus moves there without a ring @${width}`, /^#work-/.test(jump.hash) && jump.top >= jump.covered - 1 && jump.top < jump.vh * 0.6 && jump.active && jump.outline === 'none', JSON.stringify(jump));
      await context.close();
    }
    {
      // 減少動態效果：出處清單的小箭頭不做轉場
      const { context, page } = await newPage(browser, { width: 375, reducedMotion: 'reduce' });
      await page.goto(baseUrl, { waitUntil: 'load' });
      await settle(page);
      const d = await page.evaluate(() => getComputedStyle(document.querySelector('.sources__summary'), '::before').transitionDuration);
      ok('reduced motion: the sources chevron does not animate', /^0s(, 0s)*$/.test(d), d);
      await context.close();
    }
    if (axeSource) {
      for (const scheme of ['light', 'dark']) {
        for (const width of [375, 1280]) {
          const { context, page } = await newPage(browser, { width, height: width < 700 ? 812 : 900, colorScheme: scheme, bypassCSP: true });
          await page.goto(baseUrl, { waitUntil: 'load' });
          await settle(page);
          await page.evaluate(() => document.querySelectorAll('details.sources').forEach((d) => { d.open = true; }));
          await page.evaluate(axeSource);
          const res = await page.evaluate(async () => { const r = await window.axe.run(document.querySelector('main'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } }); return r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, target: v.nodes[0] && v.nodes[0].target })); });
          report.info[`axe_content_${scheme}_${width}`] = res;
          ok(`axe with the source lists open: no serious/critical violations (${scheme} @${width})`, res.filter(v => ['serious', 'critical'].includes(v.impact)).length === 0, JSON.stringify(res.filter(v => ['serious', 'critical'].includes(v.impact))));
          await context.close();
        }
      }
    }
  } catch (e) {
    report.fail.push('runner crashed: ' + (e.stack || e.message));
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`PASS ${report.pass.length}  FAIL ${report.fail.length}  WARN ${report.warn.length}`);
  for (const f of report.fail) console.log('FAIL ' + f);
  for (const w of report.warn) console.log('WARN ' + w);
  process.exit(report.fail.length ? 1 : 0);
})();
