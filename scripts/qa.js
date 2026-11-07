// 品質檢查（headless Chromium + Playwright）：截圖、跑版、橫向捲動、CSP、語言切換、燈箱、倒數、深色模式、減少動態、無障礙（axe-core）。
// 先安裝：npm install（會裝 playwright 與 axe-core），再 npx playwright install chromium
// 然後在另一個終端機執行 python3 -m http.server 8000，接著：
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
  await page.waitForFunction(() => document.querySelectorAll('#gallery img').length >= 9, null, { timeout: 15000 });
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
      const tiles = page.locator('#gallery button');
      const count = await tiles.count();
      ok(`gallery has 9 tile buttons @${width}`, count === 9, String(count));
      if (width === 375) {
        // 每顆按鈕的名稱只來自說明（aria-labelledby），說明本身不再被唸第二次
        const names = await page.evaluate(() => Array.from(document.querySelectorAll('#gallery button')).map(b => {
          const lab = (b.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => (document.getElementById(id) || {}).textContent || '').join(' ').trim();
          const cap = b.parentElement.querySelector('.gallery__caption');
          return { lab, hidden: cap && cap.getAttribute('aria-hidden') === 'true', alt: b.querySelector('img').getAttribute('alt') };
        }));
        ok('gallery buttons are named once by their caption', names.every(n => n.lab && n.hidden && n.lab === n.alt), JSON.stringify(names.slice(0, 2)));
        const lists = await page.evaluate(() => ['.site-nav__list', '#timeline-list', '#gallery-grid', '#messages-list'].map(s => (document.querySelector(s) || {}).getAttribute && document.querySelector(s).getAttribute('role')));
        ok('nav, timeline, gallery and messages lists keep role="list"', lists.every(r => r === 'list'), JSON.stringify(lists));
      }
      const third = tiles.nth(2);
      await third.scrollIntoViewIfNeeded();
      await third.focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      const open = await page.evaluate(() => { const d = document.querySelector('dialog'); return d ? d.open : null; });
      ok(`lightbox opens with Enter @${width}`, open === true, String(open));
      const focusInside = await page.evaluate(() => { const d = document.querySelector('dialog'); return !!(d && d.contains(document.activeElement)); });
      ok(`focus moves into dialog @${width}`, focusInside);
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
      const focusBack = await page.evaluate(() => { const tiles = document.querySelectorAll('#gallery button'); return document.activeElement === tiles[2]; });
      ok(`focus returns to the tile @${width}`, focusBack);
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
      for (const [w, h] of [[375, 667], [320, 256]]) {
        const { context, page } = await newPage(browser, { width: w, height: h, hasTouch: true, isMobile: true });
        await page.goto(baseUrl, { waitUntil: 'load' });
        await settle(page);
        await page.evaluate(() => window.scrollTo({ top: 900, behavior: 'instant' }));
        await page.waitForTimeout(400);
        const st = await page.evaluate(() => { const r = document.querySelector('.site-header').getBoundingClientRect(); const a = document.querySelector('.site-nav__list a').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), pillTop: Math.round(a.top) }; });
        ok(`only the nav row stays fixed after scrolling @${w}x${h}`, st.top < 0 && st.bottom <= 60 && st.pillTop >= 6, JSON.stringify(st));
        await page.screenshot({ path: path.join(outDir, `sticky-${w}x${h}.png`), clip: { x: 0, y: 0, width: w, height: Math.min(h, 200) } });
        await context.close();
      }
      // 手機：Tab 走過導覽六項時，每顆膠囊都完整露出、不在右側淡出區底下；按 Enter 後下一個 Tab 進入目標區塊
      for (const width of [375, 1280]) {
        const { context, page } = await newPage(browser, { width, height: width < 700 ? 812 : 900 });
        await page.goto(baseUrl, { waitUntil: 'load' });
        await settle(page);
        for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');   // skip link → brand → ja → zh
        const pos = [];
        for (let i = 0; i < 6; i++) {
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
        // run axe with the lightbox open too
        await page.locator('#gallery button').nth(0).click();
        await page.waitForTimeout(400);
        const res2 = await page.evaluate(async () => { const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }); return r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 5).map(n => n.target.join(' ')) })); });
        ok(`axe with lightbox open: no serious/critical (${scheme})`, res2.filter(v => ['serious', 'critical'].includes(v.impact)).length === 0, JSON.stringify(res2));
        await context.close();
      }
    } else warn('axe-core not installed; skipped');
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
