#!/usr/bin/env node
// 產生審查用的截圖：npm run screenshots [輸出資料夾]
//
// 在本機啟動測試環境（範例文字、合成的範例圖、隨機的測試密碼），用瀏覽器實際操作後截圖：手機與桌機、訪客端與管理頁。
// 截圖裡不會有真實的照片、留言或正式密碼（畫面上出現的密碼是這次本機測試隨機產生的，測試結束就失效）。
// 需要 Playwright（在 repo 根目錄 npm install）；要用已安裝的 Chrome：QA_CHROME_PATH=/path/to/chrome

import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { seededStack } from '../tests/helpers/seed.mjs';
import { freePort } from '../tests/helpers/stack.mjs';
import { Client, visitorLogin, visitorForm, adminCsrf } from '../tests/helpers/client.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(HERE, '..', '..');
const out = path.resolve(process.argv[2] || path.join(HERE, '..', '.local', 'screenshots'));
await mkdir(out, { recursive: true });

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' };
const DESKTOP = { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' };
const shot = async (page, name, options = {}) => { await page.screenshot({ path: path.join(out, name + '.png'), ...options }); console.log('  ' + name + '.png'); };
const loadAll = async (page) => {
  // 延後載入的圖片改成立刻載入，等它們都載完、解碼完、畫到畫面上（最多等 8 秒）再截圖。
  // 只等「載入完成」不夠：圖片是非同步解碼的，載入完成的那一刻畫面上可能還是空的，截到的會是一塊空白
  await page.evaluate(async () => {
    const images = Array.from(document.images);
    images.forEach((img) => { img.loading = 'eager'; });
    const ready = images.map(async (img) => {
      if (!img.complete) { await new Promise((resolve) => { img.addEventListener('load', resolve); img.addEventListener('error', resolve); }); }
      if (typeof img.decode === 'function') { await img.decode().catch(() => {}); }
    });
    await Promise.race([Promise.all(ready), new Promise((resolve) => setTimeout(resolve, 8000))]);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  // 截圖之前確認每一張都真的有內容（沒有的話寧可讓截圖失敗，也不要交出缺一張圖的畫面）
  const broken = await page.evaluate(() => Array.from(document.images).filter((img) => !(img.complete && img.naturalWidth > 0)).map((img) => img.getAttribute('src')));
  if (broken.length) { throw new Error(`截圖前還有 ${broken.length} 張圖片沒有載入`); }
};
/** 等放大的照片真的畫到畫面上。頁面的狀態變成 ready 之後，圖片還要解碼完、過一次畫面更新才看得到；只等狀態的話，偶爾會截到還沒有照片的畫面 */
const lightboxReady = async (page) => {
  await page.waitForSelector('dialog.lightbox[data-state="ready"] .lightbox__img');
  const ok = await page.evaluate(async () => {
    const img = document.querySelector('dialog.lightbox .lightbox__img');
    if (!img) { return false; }
    if (typeof img.decode === 'function') { await img.decode().catch(() => {}); }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return img.complete && img.naturalWidth > 0;
  });
  if (!ok) { throw new Error('放大的照片沒有載入'); }
};
setTimeout(() => { console.error('逾時：截圖沒有在 8 分鐘內完成'); process.exit(1); }, 8 * 60 * 1000).unref();

/** 公開網站的本機伺服器（只給截圖用）。data.js 裡的 site.roomUrl 換成示意用的網址，讓首頁的入口顯示出來 */
async function servePublicSite(roomUrl) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
  const port = await freePort();
  const server = http.createServer(async (req, res) => {
    try {
      const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.resolve(SITE_ROOT, name);
      if (!file.startsWith(SITE_ROOT + path.sep) || name.startsWith('backend/') || name.includes('node_modules')) { throw new Error('outside'); }
      let body = await readFile(file);
      if (name === 'data.js') { body = Buffer.from(body.toString('utf8').replace('roomUrl: null,', `roomUrl: '${roomUrl}',`)); }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch (err) { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

console.log('啟動本機測試環境…');
const env = await seededStack();
const browser = await chromium.launch(process.env.QA_CHROME_PATH ? { executablePath: process.env.QA_CHROME_PATH } : {});
const site = await servePublicSite('https://ayaka-room.example.workers.dev');
try {
  const visitorUrl = env.stack.visitorUrl;
  const login = async (page) => {
    await page.goto(visitorUrl + '/');
    await page.fill('#room-pass', env.password);
    await page.click('.room__form button[type=submit]');
    await page.waitForSelector('[data-reply-form]');
  };

  console.log('訪客端（手機 390×844）');
  const phone = await browser.newContext(PHONE);
  let page = await phone.newPage();
  await page.goto(visitorUrl + '/');
  await shot(page, '01-phone-gate-ja', { fullPage: true });
  await page.fill('#room-pass', 'chigau-aikotoba-desu');
  await page.tap('.room__btn');
  await page.waitForSelector('.room__status--error');
  await shot(page, '02-phone-gate-wrong');
  await page.goto(visitorUrl + '/lang/zh');
  await shot(page, '03-phone-gate-zh');
  await page.goto(visitorUrl + '/lang/ja');
  await page.fill('#room-pass', env.password);
  await page.tap('[data-show-toggle]');
  await page.waitForTimeout(500);                     // 等觸控的反白消失再截圖
  await shot(page, '04-phone-gate-pasted');
  await page.tap('.room__btn');
  await page.waitForSelector('[data-reply-form]');
  await loadAll(page);
  await shot(page, '05-phone-room-ja', { fullPage: true });
  await page.tap('[data-photo]');
  await lightboxReady(page);
  await shot(page, '06-phone-lightbox');
  await page.tap('.lightbox__btn--next');
  await page.tap('.lightbox__btn--next');
  await lightboxReady(page);
  await shot(page, '07-phone-lightbox-landscape');
  await page.tap('.lightbox__btn--close');

  await page.fill('#reply-body', '写真、見ました。\nありがとうございます。（これは確認用のサンプルです）');
  await page.locator('.reply__form .room__btn').scrollIntoViewIfNeeded();   // 輸入欄、字數與按鈕都在畫面裡
  await shot(page, '08-phone-reply-typing');
  await page.route('**/reply', (route) => route.abort('internetdisconnected'));
  await page.tap('.reply__form .room__btn');
  await page.waitForSelector('#reply-status.room__status--error');
  await page.locator('#reply-body').scrollIntoViewIfNeeded();
  await shot(page, '09-phone-reply-failed-text-kept');
  await page.unroute('**/reply');
  await page.tap('.reply__form .room__btn');
  await page.waitForFunction(() => /送信しました/.test(document.getElementById('reply-status').textContent));
  await page.locator('.reply__form .room__btn').scrollIntoViewIfNeeded();
  await shot(page, '10-phone-reply-sent');

  await page.goto(visitorUrl + '/lang/zh');
  await page.waitForSelector('[data-reply-form]');
  await loadAll(page);
  await shot(page, '11-phone-room-zh', { fullPage: true });
  await page.goto(visitorUrl + '/lang/ja');
  await page.tap('.room__lock-btn');
  await page.waitForURL('**/?out=1');
  await shot(page, '12-phone-logged-out');
  await phone.close();

  console.log('訪客端（手機）：出狀況時的畫面');
  const revoke = async () => { await env.admin.post('/access/revoke', { csrf: await adminCsrf(env.admin) }); };
  const trouble = await browser.newContext(PHONE);
  await trouble.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: visitorUrl });
  page = await trouble.newPage();
  await login(page);
  await loadAll(page);
  // 照片放大：載入中（原圖還沒回來）、沒載入成功（連不上）
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route('**/photo/*/full*', async (route) => { await held; await route.continue(); });
  await page.tap('[data-photo]');
  await page.waitForFunction(() => document.querySelector('.lightbox__message').textContent.length > 0);
  await shot(page, '28-phone-lightbox-loading');
  release();
  await lightboxReady(page);
  await page.unroute('**/photo/*/full*');
  await page.route('**/photo/*/full*', (route) => route.abort('internetdisconnected'));
  await page.tap('.lightbox__btn--next');
  await page.waitForSelector('dialog.lightbox[data-state="failed"]');
  await shot(page, '29-phone-lightbox-failed-retry');
  await page.unroute('**/photo/*/full*');
  await page.tap('.lightbox__btn--close');
  // 寫到一半、登入過期：放大照片時
  await page.fill('#reply-body', '写真、見ました。\nありがとうございます。（これは確認用のサンプルです）');
  await revoke();
  await page.tap('[data-photo]');
  await page.waitForSelector('dialog.lightbox[data-state="session"]');
  await shot(page, '30-phone-lightbox-session-expired');
  await page.tap('.lightbox__btn--action');
  await page.waitForSelector('#relogin:not([hidden])');
  await page.waitForTimeout(700);                     // 等頁面捲到定位
  await shot(page, '31-phone-relogin-from-photo');
  await page.fill('#relogin-pass', env.password);
  await page.tap('.relogin__form button[type=submit]');
  await lightboxReady(page);
  await shot(page, '32-phone-photo-after-relogin');
  await page.tap('.lightbox__btn--close');
  // 寫到一半、登入過期：送出回覆時
  await revoke();
  await page.tap('.reply__form .room__btn');
  await page.waitForSelector('#relogin:not([hidden])');
  await page.waitForTimeout(700);
  await page.locator('#reply-body').scrollIntoViewIfNeeded();
  await shot(page, '33-phone-reply-session-expired', { fullPage: false });
  await page.tap('[data-copy-button]');
  await page.waitForFunction(() => document.querySelector('[data-copy-status]').textContent.length > 0);
  await page.fill('#relogin-pass', 'chigau-aikotoba-desu');
  await page.tap('.relogin__form button[type=submit]');
  await page.waitForFunction(() => /合言葉が違うようです/.test(document.querySelector('#relogin-status').textContent));
  await page.locator('#relogin').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await shot(page, '34-phone-relogin-copied-and-wrong');
  await page.fill('#relogin-pass', env.password);
  await page.tap('.relogin__form button[type=submit]');
  await page.waitForSelector('#relogin', { state: 'hidden' });
  await page.locator('.reply__form .room__btn').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await shot(page, '35-phone-relogin-done-text-kept');
  // 回應晚到：等待期間輸入欄鎖住；等待期間內容被換掉時，不會被先前那一則的成功回應清掉
  let releaseReply, reached;
  const gate = new Promise((resolve) => { releaseReply = resolve; });
  const arrived = new Promise((resolve) => { reached = resolve; });
  await page.route('**/reply', async (route) => { const response = await route.fetch(); reached(); await gate; await route.fulfill({ response }); }, { times: 1 });
  await page.tap('.reply__form .room__btn');
  await arrived;
  await page.locator('.reply__form .room__btn').scrollIntoViewIfNeeded();
  await shot(page, '36-phone-reply-sending-locked');
  await page.locator('#reply-body').evaluate((el) => { el.value = '（返事を待っているあいだに入った、別の内容）'; });
  releaseReply();
  await page.waitForFunction(() => /まだ送信されていません/.test(document.getElementById('reply-status').textContent));
  await page.locator('.reply__form .room__btn').scrollIntoViewIfNeeded();
  await shot(page, '37-phone-reply-sent-other-text-kept');
  // 繁體中文
  await page.goto(visitorUrl + '/lang/zh');
  await page.waitForSelector('[data-reply-form]');
  await page.fill('#reply-body', '照片看到了，謝謝。（這是確認用的範例文字）');
  await revoke();
  await page.tap('.reply__form .room__btn');
  await page.waitForSelector('#relogin:not([hidden])');
  await page.waitForTimeout(700);
  await page.locator('#reply-body').scrollIntoViewIfNeeded();
  await shot(page, '38-phone-reply-session-expired-zh');
  await page.goto(visitorUrl + '/lang/ja');
  await trouble.close();

  // 沒有 JavaScript：登入過期時草稿跟著登入表單走
  const plain = await browser.newContext({ ...PHONE, javaScriptEnabled: false });
  page = await plain.newPage();
  await page.goto(visitorUrl + '/');
  await page.fill('#room-pass', env.password);
  await page.click('.room__form .room__btn', { force: true });
  await page.waitForSelector('[data-reply-form]');
  await page.fill('#reply-body', '写真、見ました。\nありがとうございます。（これは確認用のサンプルです）');
  await revoke();
  await page.click('.reply__form .room__btn', { force: true });
  await page.waitForSelector('#room-draft');
  await shot(page, '39-phone-nojs-session-expired-draft-on-gate', { fullPage: true });
  await page.fill('#room-pass', env.password);
  await page.click('.room__form .room__btn', { force: true });
  await page.waitForSelector('[data-reply-form]');
  await page.locator('#reply-body').scrollIntoViewIfNeeded();
  await shot(page, '40-phone-nojs-draft-restored');
  await plain.close();

  const dark = await browser.newContext({ ...PHONE, colorScheme: 'dark' });
  page = await dark.newPage();
  await page.goto(visitorUrl + '/');
  await shot(page, '13-phone-gate-dark');
  await login(page);
  await loadAll(page);
  await shot(page, '14-phone-room-dark', { fullPage: true });
  await dark.close();

  console.log('訪客端（桌機 1280×900）');
  const desktop = await browser.newContext(DESKTOP);
  page = await desktop.newPage();
  await page.goto(visitorUrl + '/');
  await shot(page, '15-desktop-gate');
  await login(page);
  await loadAll(page);
  await shot(page, '16-desktop-room', { fullPage: true });
  await page.click('[data-photo]');
  await lightboxReady(page);
  await shot(page, '17-desktop-lightbox');
  await page.keyboard.press('Escape');

  // 收件匣裡放幾則範例回覆（其中一則故意夾著 HTML，確認只會顯示成文字）
  const sender = new Client(visitorUrl);
  await visitorLogin(sender, env.password);
  for (const body of [
    '範例：中文的回覆也可以。\n這是確認用的範例文字。',
    'サンプル：<b>太字</b> や <script>alert(1)</script> と書いても、文字としてそのまま表示されます。',
  ]) {
    const form = await visitorForm(sender);
    await sender.post('/reply', { csrf: form.csrf, nonce: form.nonce, body });
  }

  console.log('管理頁（桌機；本機以模擬的 Cloudflare Access 登入）');
  const adminUrl = env.adminBrowserUrl;
  page = await desktop.newPage();
  page.on('dialog', (d) => d.accept());
  await page.goto(adminUrl + '/');
  await shot(page, '18-admin-inbox', { fullPage: true });
  await page.goto(adminUrl + '/photos');
  await loadAll(page);
  await shot(page, '19-admin-photos', { fullPage: true });
  await page.goto(adminUrl + '/content');
  await shot(page, '20-admin-content', { fullPage: true });
  await page.goto(adminUrl + '/access');
  await shot(page, '21-admin-access', { fullPage: true });
  await page.locator('form[action="/access/generate"] button').click();
  await page.waitForSelector('[data-new-password]');
  await shot(page, '22-admin-new-password-shown-once');
  await desktop.close();

  console.log('管理頁（手機）');
  const adminPhone = await browser.newContext(PHONE);
  page = await adminPhone.newPage();
  await page.goto(adminUrl + '/');
  await shot(page, '23-admin-inbox-phone', { fullPage: true });
  await page.goto(adminUrl + '/photos');
  await loadAll(page);
  await shot(page, '24-admin-photos-phone', { fullPage: true });
  await page.goto(adminUrl + '/access');
  await shot(page, '25-admin-access-phone', { fullPage: true });
  await adminPhone.close();

  console.log('公開網站首頁的入口（示意：site.roomUrl 填了網址時才會出現）');
  for (const [name, options] of [['26-public-entry-phone', PHONE], ['27-public-entry-desktop', DESKTOP]]) {
    const context = await browser.newContext(options);
    page = await context.newPage();
    await page.goto(site.url);
    await page.waitForSelector('#room-entry:not([hidden]) a[href^="https://"]');
    await page.locator('#messages').scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    await shot(page, name, {});
    await context.close();
  }
  console.log(`\n完成：${out}`);
} finally {
  await browser.close();
  await site.close();
  await env.stop();
}
