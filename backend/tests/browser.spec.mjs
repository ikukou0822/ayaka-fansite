// 瀏覽器測試（驗收 8，以及只有真的瀏覽器才測得出來的部分）：用 Playwright 開 Chrome，
// 以手機大小的畫面實際操作：貼上密碼登入、看照片、送出回覆、失敗後重試、登出；另外檢查管理頁與照片上傳。
//
//   node --test tests/browser.spec.mjs
//
// 需要 Playwright（在 repo 根目錄執行 npm install；沒有安裝時這個檔案的測試會全部略過）。
// 要用已安裝的 Chrome 而不是 Playwright 自帶的瀏覽器：QA_CHROME_PATH=/path/to/chrome

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

import { seededStack, fixturePath, SAMPLE } from './helpers/seed.mjs';
import { Client, visitorLogin, visitorForm, adminCsrf } from './helpers/client.mjs';
import { inspectJpeg, stripJpeg, JFIF_HEADER, adobeSegment } from '../shared/jpeg.js';
import { tr } from '../shared/i18n.js';

const require = createRequire(import.meta.url);
let chromium = null, axeSource = null;
try { ({ chromium } = require('playwright')); } catch (err) { /* 沒有安裝 */ }
try { axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch (err) { /* 選用 */ }
const skip = chromium ? false : '需要 Playwright（在 repo 根目錄 npm install）';

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' };
const DESKTOP = { viewport: { width: 1280, height: 900 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let env, browser;
const problems = [];          // 所有頁面上的 CSP 違規與沒預期到的程式錯誤

function watch(page, label) {
  page.on('console', (m) => {
    if (m.type() !== 'error' || !/Content Security Policy|CSP/i.test(m.text())) { return; }
    // 直接在分頁裡打開一張照片時，畫面是瀏覽器內建的「看圖頁」，它想替自己加上行內樣式而被我們的 CSP 擋下（照片照常顯示）。
    // 那不是我們的頁面，不算違規；我們自己的頁面一條都不可以有
    if (/\/photo\/[a-f0-9]{32}\/(thumb|full)$/.test(page.url()) && /inline style/i.test(m.text())) { return; }
    problems.push(`${label}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`${label}: pageerror ${e.message}`));
  return page;
}
async function open(options, label) {
  const context = await browser.newContext(options);
  const page = watch(await context.newPage(), label);
  return { context, page };
}
async function login(page, password = env.password) {
  await page.goto(env.stack.visitorUrl + '/');
  await page.fill('#room-pass', password);
  await page.click('.room__form button[type=submit]');
  await page.waitForSelector('[data-reply-form]');
}
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const box = async (page, selector) => page.locator(selector).first().boundingBox();
async function inbox() {
  const res = await env.admin.get('/export.json');
  return JSON.parse(res.text).replies;
}
async function awayFromWindowEdge(windowSeconds = 600, marginSeconds = 20) {
  const left = windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds);
  if (left <= marginSeconds) { await sleep((left + 1) * 1000); }
}

before(async () => {
  if (skip) { return; }
  env = await seededStack();
  browser = await chromium.launch(process.env.QA_CHROME_PATH ? { executablePath: process.env.QA_CHROME_PATH } : {});
});

after(async () => {
  if (browser) { await browser.close(); }
  if (env) { await env.stop(); }
});

/* ================================================================================================
   驗收 8：手機版登入、照片瀏覽、回覆及失敗重試可用
   ================================================================================================ */

test('驗收 8-1：手機上貼上密碼登入；打錯有清楚的提示；可以顯示輸入的內容', { skip }, async (t) => {
  const { context, page } = await open(PHONE, 'phone-login');
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: env.stack.visitorUrl });
  await page.goto(env.stack.visitorUrl + '/');
  assert.equal(await page.locator('h1').textContent(), '合言葉のページ');
  assert.ok(await noSideScroll(page), '不可以橫向捲動');
  const input = await box(page, '#room-pass'), button = await box(page, '.room__btn');
  assert.ok(input.height >= 44 && button.height >= 44, '輸入欄與按鈕夠大，手指好按');
  assert.ok(await page.locator('#room-pass').evaluate((el) => parseFloat(getComputedStyle(el).fontSize)) >= 16, '輸入欄字級 16px 以上（iPhone 才不會自動放大畫面）');
  assert.ok(await page.locator('[data-show-toggle]').isVisible(), '「顯示」的勾選框出現了');
  assert.equal(await page.locator('#room-pass').getAttribute('type'), 'password');

  // 打錯
  await page.fill('#room-pass', 'chigau-aikotoba-desu');
  await page.tap('.room__btn');
  await page.waitForSelector('.room__status--error');
  assert.match(await page.locator('#room-status').textContent(), /合言葉が違うようです/);
  assert.equal(await page.locator('#room-pass').getAttribute('aria-invalid'), 'true');
  assert.equal(await page.locator('[data-reply-form]').count(), 0);
  assert.ok(await noSideScroll(page));

  // 貼上：前後多了空白與換行、全部大寫、連字號變成空格，也要能登入
  const pasted = `  ${env.password.toUpperCase().replace(/-/g, ' ')} \n`;
  let viaClipboard = false;
  try {
    await page.evaluate((text) => navigator.clipboard.writeText(text), pasted);
    await page.focus('#room-pass');
    await page.keyboard.press('Control+V');
    viaClipboard = !!(await page.inputValue('#room-pass'));
  } catch (err) { /* 這個瀏覽器不讓測試程式碰剪貼簿 */ }
  if (!viaClipboard) { await page.focus('#room-pass'); await page.keyboard.insertText(pasted.replace(/\n/g, '')); }   // 改用「一次插入整段文字」（和貼上一樣不是逐字輸入）
  t.diagnostic(viaClipboard ? '用剪貼簿貼上' : '用插入文字模擬貼上');
  await page.tap('[data-show-toggle]');
  assert.equal(await page.locator('#room-pass').getAttribute('type'), 'text', '勾選後看得到貼上的內容');
  assert.equal((await page.inputValue('#room-pass')).trim(), pasted.trim());
  await page.tap('.room__btn');
  await page.waitForSelector('[data-reply-form]');
  assert.equal(await page.locator('h1').textContent(), SAMPLE.title_ja);

  // 瀏覽器看到的 cookie：Secure、HttpOnly、SameSite=Lax、七天後過期；頁面上的程式讀不到它，也沒有任何登入旗標
  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === '__Host-room-session');
  assert.ok(session && session.secure && session.httpOnly && session.sameSite === 'Lax' && session.path === '/');
  const days = (session.expires - Date.now() / 1000) / 86400;
  assert.ok(days > 6.9 && days <= 7.01, `cookie 的期限：${days.toFixed(2)} 天`);
  const seen = await page.evaluate(() => ({ cookie: document.cookie, local: localStorage.length, session: sessionStorage.length }));
  assert.ok(!seen.cookie.includes('room-session') && !seen.cookie.includes('room-csrf'));
  assert.deepEqual([seen.local, seen.session], [0, 0]);
  await context.close();
});

test('驗收 8-2：手機上看照片：縮圖都載入、點一下放大、可以前後切換與關閉', { skip }, async () => {
  const { context, page } = await open(PHONE, 'phone-photos');
  await login(page);
  assert.ok(await noSideScroll(page));
  const count = await page.locator('.room__img').count();
  assert.equal(count, 3);
  for (let i = 0; i < count; i++) {
    const img = page.locator('.room__img').nth(i);
    await img.scrollIntoViewIfNeeded();
    await page.waitForFunction((n) => { const el = document.querySelectorAll('.room__img')[n]; return el.complete && el.naturalWidth > 0; }, i);
    const shown = await img.boundingBox();
    assert.ok(shown.width <= 390 && shown.width > 250, `第 ${i + 1} 張的寬度 ${shown.width}`);
  }
  assert.match(await page.locator('.room__caption').first().textContent(), /サンプルの写真 1\s*2026年11月14日/);

  await page.locator('[data-photo]').first().scrollIntoViewIfNeeded();
  await page.tap('[data-photo]');
  await page.waitForSelector('dialog.lightbox[open][data-state="ready"]');
  assert.equal(await page.locator('.lightbox__img').evaluate((el) => el.naturalWidth), 1200, '放大時載入的是原圖');
  assert.equal(await page.locator('.lightbox__state').isVisible(), false, '照片出現後沒有多餘的提示');
  assert.equal(await page.locator('.lightbox__count').textContent(), '1 / 3');
  for (const name of ['close', 'prev', 'next']) {
    const b = await box(page, `.lightbox__btn--${name}`);
    assert.ok(b.width >= 44 && b.height >= 44, `${name} 按鈕夠大`);
    assert.ok(b.x >= 0 && b.x + b.width <= 390 && b.y >= 0 && b.y + b.height <= 844, `${name} 按鈕在畫面內`);
  }
  const shown = await box(page, '.lightbox__img');
  assert.ok(shown.x >= 0 && shown.x + shown.width <= 391 && shown.y >= 0 && shown.y + shown.height <= 845, '整張照片都在畫面內');
  await page.tap('.lightbox__btn--next');
  assert.equal(await page.locator('.lightbox__count').textContent(), '2 / 3');
  await page.waitForSelector('dialog.lightbox[data-state="ready"]');
  assert.match(await page.locator('.lightbox__img').getAttribute('alt'), /サンプル画像2/);
  assert.equal(await page.locator('.lightbox__img').count(), 1, '畫面上只有目前這一張');
  await page.tap('.lightbox__btn--prev');
  await page.tap('.lightbox__btn--prev');
  assert.equal(await page.locator('.lightbox__count').textContent(), '3 / 3', '第一張再往前是最後一張');
  await page.waitForSelector('dialog.lightbox[data-state="ready"]');
  assert.match(await page.locator('.lightbox__img').getAttribute('alt'), /サンプル画像3/, '連續快速切換後，顯示的是最後選的那一張');
  await page.tap('.lightbox__btn--close');
  assert.equal(await page.locator('dialog.lightbox[open]').count(), 0);
  assert.equal(new URL(page.url()).pathname, '/', '沒有離開頁面');
  assert.ok(await page.evaluate(() => document.activeElement && document.activeElement.matches('[data-photo]')), '關閉後回到剛剛點的照片');

  // 鍵盤（外接鍵盤或桌機）：Enter 打開、方向鍵切換、Esc 關閉
  await page.keyboard.press('Enter');
  await page.waitForSelector('dialog.lightbox[open]');
  assert.equal(await page.locator('.lightbox__count').textContent(), '1 / 3');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('.lightbox__count').textContent(), '2 / 3');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('.lightbox__count').textContent(), '1 / 3');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog.lightbox[open]'));
  await context.close();
});

test('手機上看照片的失敗流程：載入中、沒載入成功可以重試、照片已經不在、登入過期可以不離開頁面重新登入', { skip }, async () => {
  const { context, page } = await open(PHONE, 'phone-photo-states');
  await login(page);
  const state = (name) => page.waitForSelector(`dialog.lightbox[open][data-state="${name}"]`);
  const message = () => page.locator('.lightbox__message').textContent();
  const inView = async (selector, label) => {
    const b = await box(page, selector);
    assert.ok(b && b.width >= 44 && b.height >= 44, `${label} 夠大`);
    assert.ok(b.x >= 0 && b.x + b.width <= 390 && b.y >= 0 && b.y + b.height <= 844, `${label} 在畫面內`);
  };
  const draft = '写真を見ている途中の下書き';
  await page.fill('#reply-body', draft);

  // 1. 載入中：原圖還沒回來的時候有一句說明；回來之後說明消失、照片出現
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route('**/photo/*/full*', async (route) => { await held; await route.continue(); });
  await page.locator('[data-photo]').first().scrollIntoViewIfNeeded();
  await page.tap('[data-photo]');
  await state('loading');
  await page.waitForFunction(() => document.querySelector('.lightbox__message').textContent.length > 0);
  assert.equal(await message(), '読み込んでいます…');
  assert.equal(await page.locator('.lightbox__img').count(), 0, '還沒載入好的照片不會露出半張');
  assert.equal(await page.locator('.lightbox__btn--action').isVisible(), false);
  assert.equal(await page.locator('.lightbox__message').getAttribute('aria-live'), 'polite');
  assert.ok(await noSideScroll(page));
  release();
  await state('ready');
  assert.equal(await page.locator('.lightbox__img').evaluate((el) => el.naturalWidth), 1200);
  await page.unroute('**/photo/*/full*');

  // 2. 沒載入成功（連不上）：一句說明加上「重新載入」；按了之後真的再向伺服器要一次
  await page.route('**/photo/*/full*', (route) => route.abort('internetdisconnected'));
  await page.tap('.lightbox__btn--next');
  await state('failed');
  assert.match(await message(), /写真を読み込めませんでした/);
  assert.equal(await page.locator('.lightbox__btn--action').textContent(), 'もう一度読み込む');
  await inView('.lightbox__btn--action', '重新載入的按鈕');
  await inView('.lightbox__btn--close', '關閉的按鈕');
  assert.ok(await noSideScroll(page));
  await page.tap('.lightbox__btn--action');
  await state('failed');                                           // 還是連不上：停在同一個提示，可以再試
  await page.unroute('**/photo/*/full*');
  await page.tap('.lightbox__btn--action');
  await state('ready');
  assert.match(await page.locator('.lightbox__img').getAttribute('src'), /\/photo\/[a-f0-9]{32}\/full\?retry=2$/);
  assert.match(await page.locator('.lightbox__img').getAttribute('alt'), /サンプル画像2/);
  // 伺服器出錯（500）也是同一個提示
  await page.route('**/photo/*/full*', (route) => route.fulfill({ status: 500, contentType: 'text/plain', body: 'Error' }));
  await page.tap('.lightbox__btn--next');
  await state('failed');
  await page.unroute('**/photo/*/full*');

  // 3. 照片已經不在（站主刪掉了）：說明清楚，沒有按了也沒用的重試按鈕
  await page.route('**/photo/*/full*', (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' }));
  await page.tap('.lightbox__btn--next');
  await state('gone');
  assert.match(await message(), /表示できなくなりました/);
  assert.equal(await page.locator('.lightbox__btn--action').isVisible(), false);
  await page.unroute('**/photo/*/full*');
  await page.tap('.lightbox__btn--close');

  // 4. 登入過期（這裡用「站主撤銷所有登入」）：說明原因，按「重新登入」後留在原本的頁面
  assert.equal((await env.admin.post('/access/revoke', { csrf: await adminCsrf(env.admin) })).status, 303);
  await page.evaluate(() => { const img = document.querySelectorAll('.room__img')[2]; img.src = img.getAttribute('src') + '?again=1'; });   // 過期之後才載入的縮圖會是破圖
  await page.waitForFunction(() => { const img = document.querySelectorAll('.room__img')[2]; return img.complete && img.naturalWidth === 0; });
  await page.locator('[data-photo]').nth(1).scrollIntoViewIfNeeded();
  await page.locator('[data-photo]').nth(1).tap();
  await state('session');
  assert.match(await message(), /ログインの有効期限が切れたため、写真を表示できません/);
  assert.equal(await page.locator('.lightbox__btn--action').textContent(), 'ログインし直す');
  await inView('.lightbox__btn--action', '重新登入的按鈕');
  await page.tap('.lightbox__btn--action');
  await page.waitForSelector('#relogin:not([hidden])');
  assert.equal(await page.locator('dialog.lightbox[open]').count(), 0);
  assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, '/', '沒有離開頁面');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'relogin-pass', '游標在合言葉的輸入欄');
  assert.match(await page.locator('#relogin-lead').textContent(), /このページのまま続けられます/);
  // 頁面會（平順地）捲到重新登入的區塊
  await page.waitForFunction(() => { const r = document.getElementById('relogin').getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; });
  assert.equal(await page.inputValue('#reply-body'), draft, '寫到一半的回覆還在');
  assert.ok(await noSideScroll(page));
  await page.fill('#relogin-pass', env.password);
  await page.tap('.relogin__form button[type=submit]');
  // 登入成功：回到剛剛那張照片，破掉的縮圖也重新載入了
  await state('ready');
  assert.equal(await page.locator('.lightbox__count').textContent(), '2 / 3');
  assert.match(await page.locator('.lightbox__img').getAttribute('alt'), /サンプル画像2/);
  await page.tap('.lightbox__btn--close');
  assert.equal(await page.locator('#relogin').isVisible(), false);
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.room__img')).every((img) => img.complete && img.naturalWidth > 0));
  assert.equal(await page.inputValue('#reply-body'), draft);
  assert.equal(await page.inputValue('#relogin-pass'), '', '合言葉不留在頁面上');
  await context.close();
});

test('驗收 8-3：手機上送出回覆；失敗時有提示、內容留著、可以重試，而且不會重複', { skip }, async () => {
  await awayFromWindowEdge();
  const { context, page } = await open(PHONE, 'phone-reply');
  await login(page);
  const send = '.reply__form .room__btn', status = '#reply-status', area = '#reply-body';
  const waitStatus = (pattern) => page.waitForFunction(([sel, source]) => new RegExp(source).test(document.querySelector(sel).textContent), [status, pattern.source]);
  const waitSent = () => page.waitForFunction(([statusSel, areaSel]) => /送信しました/.test(document.querySelector(statusSel).textContent) && document.querySelector(areaSel).value === '', [status, area]);
  const copies = async (text) => (await inbox()).filter((r) => r.body === text).length;
  await page.locator(area).scrollIntoViewIfNeeded();
  const areaBox = await box(page, area), sendBox = await box(page, send);
  assert.ok(areaBox.width >= 300 && sendBox.height >= 44);
  assert.ok(await page.locator(area).evaluate((el) => parseFloat(getComputedStyle(el).fontSize)) >= 16);

  // 1. 正常送出：存進去之後才顯示成功，輸入欄清空
  const first = 'ブラウザからの返信テスト 1\n改行もそのまま届きます。';
  await page.fill(area, first);
  assert.match(await page.locator('[data-count]').textContent(), /^\d+ \/ 2000$/);
  await page.tap(send);
  await waitSent();
  assert.equal(await page.inputValue(area), '');
  assert.equal(await copies(first), 1);
  assert.equal(new URL(page.url()).search, '', '沒有換頁');

  // 2. 網路斷線：顯示失敗、內容留著、按鈕可以再按；網路恢復後重試成功，只存一筆
  const second = 'ブラウザからの返信テスト 2（途中で通信が切れる）';
  await page.fill(area, second);
  await page.route('**/reply', (route) => route.abort('internetdisconnected'));
  await page.tap(send);
  await waitStatus(/送信できたかどうか確認できませんでした/);
  assert.ok(await page.locator(status).evaluate((el) => el.classList.contains('room__status--error')));
  assert.equal(await page.inputValue(area), second, '寫好的內容還在');
  assert.equal(await page.locator(send).isEnabled(), true);
  assert.equal(await copies(second), 0, '沒有存進去就不可以顯示成功');
  await page.unroute('**/reply');
  await page.tap(send);
  await waitSent();
  assert.equal(await copies(second), 1);

  // 3. 其實已經存進去了，只是回應在路上斷了：畫面顯示失敗；再按一次會成功，而且不會存成兩筆
  const third = 'ブラウザからの返信テスト 3（返事だけが届かない）';
  await page.fill(area, third);
  await page.route('**/reply', async (route) => { await route.fetch(); await route.abort('connectionreset'); });
  await page.tap(send);
  await waitStatus(/送信できたかどうか確認できませんでした/);
  assert.equal(await page.inputValue(area), third);
  assert.equal(await copies(third), 1, '伺服器其實已經收到');
  await page.unroute('**/reply');
  await page.tap(send);
  await waitSent();
  assert.equal(await copies(third), 1, '重送不會變成兩筆');

  // 4. 連按兩下只送一次
  const fourth = 'ブラウザからの返信テスト 4（二度押し）';
  await page.fill(area, fourth);
  await page.locator(send).dblclick();
  await waitSent();
  await sleep(500);                       // 如果第二下也送了出去，這段時間內會多一筆
  assert.equal(await copies(fourth), 1);

  // 5. 伺服器回錯誤（不是 JSON）：一樣顯示失敗、內容留著
  const fifth = 'ブラウザからの返信テスト 5';
  await page.fill(area, fifth);
  await page.route('**/reply', (route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<h1>Bad gateway</h1>' }));
  await page.tap(send);
  await waitStatus(/送信できたかどうか確認できませんでした/);
  assert.equal(await page.inputValue(area), fifth);
  await page.unroute('**/reply');
  await page.tap(send);
  await waitSent();
  assert.equal(await copies(fifth), 1);

  // 6. 送太多次：提示要等一下，內容留著，沒有存
  const sixth = 'ブラウザからの返信テスト 6（回数制限）';
  await page.fill(area, sixth);
  await page.tap(send);
  await waitStatus(/送信の回数が多すぎます/);
  assert.equal(await page.inputValue(area), sixth);
  assert.equal(await copies(sixth), 0);

  // 7. 寫到一半登入被撤銷：內容留著，可以複製，也可以不離開頁面重新登入；登入後再送出，只存一筆
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: env.stack.visitorUrl });
  const revoked = await env.admin.post('/access/revoke', { csrf: await adminCsrf(env.admin) });
  assert.equal(revoked.status, 303);
  await page.tap(send);
  await waitStatus(/ログインの有効期限が切れたため、送信できたかどうか確認できていません/);
  await page.waitForSelector('#relogin:not([hidden])');
  assert.equal(await page.inputValue(area), sixth, '寫好的內容還在');
  assert.equal(await page.locator(area).evaluate((el) => el.readOnly), false, '輸入欄可以繼續編輯');
  assert.equal(await copies(sixth), 0);
  assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, '/', '沒有離開頁面');
  assert.match(await page.locator('#relogin-lead').textContent(), /念のため内容をコピーしてから/);
  for (const selector of ['[data-copy-button]', '#relogin-pass', '.relogin__form button[type=submit]']) {
    const b = await box(page, selector);
    assert.ok(b.height >= 44 && b.x >= 0 && b.x + b.width <= 390, `${selector} 夠大而且在畫面內`);
  }
  assert.ok(await page.locator('#relogin-pass').evaluate((el) => parseFloat(getComputedStyle(el).fontSize)) >= 16);
  assert.ok(await noSideScroll(page));
  // 複製
  await page.tap('[data-copy-button]');
  await page.waitForFunction(() => document.querySelector('[data-copy-status]').textContent.length > 0);
  assert.equal(await page.locator('[data-copy-status]').textContent(), 'コピーしました。');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), sixth, '剪貼簿裡是寫到一半的內容');
  // 合言葉打錯：說明清楚，內容與區塊都還在
  await page.fill('#relogin-pass', 'chigau-aikotoba-desu');
  await page.tap('.relogin__form button[type=submit]');
  await page.waitForFunction(() => /合言葉が違うようです/.test(document.querySelector('#relogin-status').textContent));
  assert.equal(await page.locator('#relogin-pass').getAttribute('aria-invalid'), 'true');
  assert.equal(await page.inputValue(area), sixth);
  // 打對：區塊收起來，提示再按一次送出；內容原封不動
  await page.fill('#relogin-pass', env.password);
  await page.tap('.relogin__form button[type=submit]');
  await page.waitForSelector('#relogin', { state: 'hidden' });
  await waitStatus(/ログインし直しました。メッセージを送信できたかどうかは、まだ確認できていません。内容はそのまま残っています。「送信する」を押すと、送信を続けられます。/);
  assert.equal(await page.inputValue(area), sixth);
  assert.equal(await page.inputValue('#relogin-pass'), '');
  assert.equal(await copies(sixth), 0, '重新登入不等於送出');
  await page.tap(send);
  await waitSent();
  assert.equal(await copies(sixth), 1);
  // 這一路上，寫到一半的內容與合言葉都沒有被寫進瀏覽器的儲存空間
  const stored = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookie: document.cookie }));
  assert.deepEqual([stored.local, stored.session], [0, 0]);
  assert.ok(!stored.cookie.includes('room-session') && !stored.cookie.includes(encodeURIComponent('回数制限')));
  for (const cookie of await context.cookies()) { assert.ok(!decodeURIComponent(cookie.value).includes('回数制限') && !cookie.value.includes(env.password), `cookie ${cookie.name}`); }
  assert.ok(await noSideScroll(page));
  await context.close();
});

test('回應晚到：等待期間輸入欄鎖住；就算內容在等待期間被換掉，先前那一則的成功回應也不會把它清掉', { skip }, async () => {
  await awayFromWindowEdge();
  const { context, page } = await open(PHONE, 'phone-slow-reply');
  await login(page);
  const send = '.reply__form .room__btn', status = '#reply-status', area = '#reply-body';
  const copies = async (text) => (await inbox()).filter((r) => r.body === text).length;
  /** 攔住送出回覆的請求：伺服器照常處理，但回應先扣著，等測試放行才交給頁面 */
  const holdReply = async () => {
    let release, arrived;
    const gate = new Promise((resolve) => { release = resolve; });
    const reached = new Promise((resolve) => { arrived = resolve; });
    await page.route('**/reply', async (route) => { const response = await route.fetch(); arrived(); await gate; await route.fulfill({ response }); }, { times: 1 });
    return { release, reached };
  };

  // 1. 一般情況：等待期間內容還在、不能改；伺服器確認之後才清空
  const first = 'A：ゆっくり届く返信';
  await page.fill(area, first);
  let held = await holdReply();
  await page.tap(send);
  await held.reached;
  assert.equal(await copies(first), 1, '伺服器已經存好，只是回應還沒回到頁面');
  assert.equal(await page.inputValue(area), first, '回應回來之前不清空');
  assert.equal(await page.locator(area).evaluate((el) => el.readOnly), true, '等待期間輸入欄是唯讀');
  assert.equal(await page.locator(send).isEnabled(), false);
  assert.match(await page.locator(status).textContent(), /送信しています/);
  await page.locator(area).focus();
  await page.keyboard.type('（待っている間に打った文字）');
  assert.equal(await page.inputValue(area), first, '鎖住的時候打字不會進去');
  held.release();
  await page.waitForFunction(([statusSel, areaSel]) => /送信しました/.test(document.querySelector(statusSel).textContent) && document.querySelector(areaSel).value === '', [status, area]);
  assert.equal(await page.locator(area).evaluate((el) => el.readOnly), false);

  // 2. 送出 A 之後、回應回來之前，輸入欄的內容變成了 B（繞過唯讀直接改欄位的值）：A 成功的回應不可以把 B 清掉
  const second = 'A2：先に送った返信', later = 'B：返事を待っている間に入った内容';
  await page.fill(area, second);
  held = await holdReply();
  await page.tap(send);
  await held.reached;
  await page.locator(area).evaluate((el, value) => { el.value = value; }, later);
  held.release();
  await page.waitForFunction((sel) => /まだ送信されていません/.test(document.querySelector(sel).textContent), status);
  assert.equal(await page.inputValue(area), later, 'B 還在輸入欄裡');
  assert.match(await page.locator(status).textContent(), /送信しました。入力欄に残っている内容は、まだ送信されていません。/);
  assert.equal(await copies(second), 1);
  assert.equal(await copies(later), 0);
  // 接著送出 B：照常送出，各存一筆
  await page.tap(send);
  await page.waitForFunction(([statusSel, areaSel]) => /送信しました。ありがとうございます/.test(document.querySelector(statusSel).textContent) && document.querySelector(areaSel).value === '', [status, area]);
  assert.equal(await copies(later), 1);
  assert.equal(await copies(second), 1);

  // 3. 伺服器一直沒有回應：30 秒後當作失敗，內容留著、解除鎖定；之後重送不會存成兩筆
  await page.clock.install();
  const third = 'C：返事が来ないままの返信';
  await page.fill(area, third);
  let hang;
  const hanging = new Promise((resolve) => { hang = resolve; });
  await page.route('**/reply', async (route) => { await route.fetch(); await hanging; try { await route.abort(); } catch (err) { /* 頁面已經放棄這個請求 */ } }, { times: 1 });
  await page.tap(send);
  await page.waitForFunction((sel) => document.querySelector(sel).readOnly, area);
  await page.clock.fastForward(31000);
  await page.waitForFunction((sel) => /送信できたかどうか確認できませんでした/.test(document.querySelector(sel).textContent), status);
  assert.equal(await page.inputValue(area), third);
  assert.equal(await page.locator(area).evaluate((el) => el.readOnly), false);
  assert.equal(await page.locator(send).isEnabled(), true);
  hang();
  await page.tap(send);
  await page.waitForFunction(([statusSel, areaSel]) => /送信しました/.test(document.querySelector(statusSel).textContent) && document.querySelector(areaSel).value === '', [status, area]);
  assert.equal(await copies(third), 1, '第一次其實已經存好；重送沒有多存一筆');
  await context.close();
});

test('在另一個分頁重新登入之後，原本那一頁寫好的回覆照樣送得出去（頁面自己換上新的防偽造編號）', { skip }, async () => {
  await awayFromWindowEdge();
  const { context, page } = await open(PHONE, 'phone-stale-form');
  await login(page);
  const text = '別のタブでログインし直したあとに送る返信';
  await page.fill('#reply-body', text);
  // 同一個瀏覽器的另一個分頁：登出再登入（原本那一頁上的防偽造編號就不是目前這次登入的了）
  const other = watch(await context.newPage(), 'phone-stale-form-tab2');
  await other.goto(env.stack.visitorUrl + '/');
  await other.click('.room__lock-btn');
  await other.waitForURL('**/?out=1');
  await login(other);
  await other.close();
  const requests = [];
  page.on('request', (request) => { if (request.method() === 'POST' || new URL(request.url()).pathname === '/session') { requests.push(`${request.method()} ${new URL(request.url()).pathname}`); } });
  await page.tap('.reply__form .room__btn');
  await page.waitForFunction(() => /送信しました/.test(document.querySelector('#reply-status').textContent) && document.querySelector('#reply-body').value === '');
  assert.deepEqual(requests, ['POST /reply', 'GET /session', 'POST /reply'], '被拒絕一次 → 要新的防偽造編號 → 自動重送');
  assert.equal((await inbox()).filter((r) => r.body === text).length, 1);
  assert.equal(await page.locator('#relogin').isVisible(), false);
  // 登出按鈕也換上了新的編號
  await page.click('.room__lock-btn');
  await page.waitForURL('**/?out=1');
  await context.close();
});

test('回覆已經存好、成功的回應卻沒有送到：之後登入失效再重新登入、或在另一個分頁重新登入過，再送同一則都只有一筆；下一則同樣的文字是新的一則', { skip }, async () => {
  await awayFromWindowEdge();
  const { context, page } = await open(PHONE, 'phone-dedupe');
  await login(page);
  const send = '.reply__form .room__btn', status = '#reply-status', area = '#reply-body';
  const copies = async (text) => (await inbox()).filter((r) => r.body === text).length;
  const nonce = () => page.inputValue('.reply__form input[name="nonce"]');
  const csrf = () => page.inputValue('.reply__form input[name="csrf"]');
  const waitSent = () => page.waitForFunction(([statusSel, areaSel]) => /送信しました/.test(document.querySelector(statusSel).textContent) && document.querySelector(areaSel).value === '', [status, area]);
  /** 下一次送出：伺服器照常處理並存好，但成功的回應不交給頁面（連線中斷）。回傳「頁面已經知道失敗」的等待 */
  const loseNextResponse = async () => {
    let done;
    const lost = new Promise((resolve) => { done = resolve; });
    await page.route('**/reply', async (route) => { await route.fetch(); await route.abort('connectionreset'); done(); }, { times: 1 });
    return async () => {
      await lost;
      await page.waitForFunction(([statusSel, areaSel]) => /送信できたかどうか確認できませんでした/.test(document.querySelector(statusSel).textContent) && !document.querySelector(areaSel).readOnly, [status, area]);
    };
  };

  // --- 情境一：成功的回應沒有送到 → 站主撤銷所有登入 → 在頁面上重新登入 → 再按送出 ---
  const first = '保存はされたのに、成功の返事が届かなかった返信（ログインし直してから送り直す）';
  const firstNonce = await nonce(), firstCsrf = await csrf();
  assert.match(firstNonce, /^[a-f0-9]{32}$/);
  await page.fill(area, first);
  let failed = await loseNextResponse();
  await page.tap(send);
  await failed();
  assert.equal(await copies(first), 1, '伺服器其實已經存好');
  assert.equal(await page.inputValue(area), first, '頁面以為失敗：內容還在');
  assert.equal(await nonce(), firstNonce, '送出編號不變');

  assert.equal((await env.admin.post('/access/revoke', { csrf: await adminCsrf(env.admin) })).status, 303);
  await page.tap(send);
  await page.waitForSelector('#relogin:not([hidden])');
  assert.equal(await copies(first), 1);
  await page.fill('#relogin-pass', env.password);
  await page.tap('.relogin__form button[type=submit]');
  await page.waitForSelector('#relogin', { state: 'hidden' });
  const afterRelogin = { csrf: await csrf(), nonce: await nonce() };
  assert.equal(await page.inputValue(area), first);
  await page.tap(send);
  await waitSent();
  assert.equal(await copies(first), 1, '重新登入後再送：收件匣仍然只有一則，不可以變成兩則');
  assert.notEqual(afterRelogin.csrf, firstCsrf, '重新登入之後，防偽造編號是新的');
  assert.equal(afterRelogin.nonce, firstNonce, '送出編號還是原本那一則的');
  const secondNonce = await nonce();
  assert.notEqual(secondNonce, firstNonce, '伺服器確認存好之後，才換下一個送出編號');

  // --- 下一則：一模一樣的文字，是新的一則 ---
  await page.fill(area, first);
  await page.tap(send);
  await waitSent();
  assert.equal(await copies(first), 2, '明確開始下一則時，同樣的文字可以再送一則');

  // --- 情境二：成功的回應沒有送到 → 在另一個分頁登出再登入（這一頁的防偽造編號過期）→ 再按送出 ---
  const second = '保存はされたのに、成功の返事が届かなかった返信（別のタブでログインし直したあと）';
  const thirdNonce = await nonce(), staleCsrf = await csrf();
  await page.fill(area, second);
  failed = await loseNextResponse();
  await page.tap(send);
  await failed();
  assert.equal(await copies(second), 1);
  const other = watch(await context.newPage(), 'phone-dedupe-tab2');
  await other.goto(env.stack.visitorUrl + '/');
  await other.click('.room__lock-btn');
  await other.waitForURL('**/?out=1');
  await login(other);
  await other.close();
  const posts = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/reply') { posts.push(new URLSearchParams(request.postData() || '')); }
  });
  await page.tap(send);
  await waitSent();
  assert.equal(await copies(second), 1, '跨分頁更新防偽造編號後重送：收件匣仍然只有一則，不可以變成兩則');
  assert.equal(posts.length, 2, '被拒絕一次 → 換上新的防偽造編號 → 自動重送');
  assert.deepEqual(posts.map((body) => body.get('nonce')), [thirdNonce, thirdNonce], '兩次用的是同一個送出編號');
  assert.equal(posts[0].get('csrf'), staleCsrf);
  assert.notEqual(posts[1].get('csrf'), staleCsrf, '第二次用的是新的防偽造編號');
  assert.notEqual(await nonce(), thirdNonce);
  assert.equal(await page.locator('#relogin').isVisible(), false);
  // 這一路上沒有把任何東西寫進瀏覽器的儲存空間
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
  await context.close();
});

test('驗收 8-4：沒有 JavaScript 的瀏覽器也能登入、看照片、送出回覆、登出', { skip }, async () => {
  const { context, page } = await open({ ...PHONE, javaScriptEnabled: false }, 'no-js');
  const FORCE = { force: true };   // 關掉 JavaScript 的頁面上，測試工具「等元素不再移動」的檢查有時不會結束；直接點即可
  await page.goto(env.stack.visitorUrl + '/');
  assert.equal(await page.locator('[data-show-toggle]').isVisible(), false, '沒有 JavaScript 時不顯示用不到的勾選框');
  await page.fill('#room-pass', env.password);
  await page.click('.room__btn', FORCE);
  await page.waitForSelector('[data-reply-form]');
  assert.equal(await page.locator('.room__img').count(), 3);
  const href = await page.locator('[data-photo]').first().getAttribute('href');
  const image = await page.goto(env.stack.visitorUrl + href);
  assert.equal(image.status(), 200);
  assert.equal(image.headers()['content-type'], 'image/jpeg');
  await page.goto(env.stack.visitorUrl + '/');

  const text = 'JavaScript なしで送る返信 <b>太字ではない</b>';
  await page.fill('#reply-body', text);
  await page.click('.reply__form .room__btn', FORCE);
  await page.waitForURL('**/?sent=1#reply');
  assert.match(await page.locator('#reply-status').textContent(), /送信しました/);
  assert.equal((await inbox()).filter((r) => r.body === text).length, 1);

  // 寫到一半登入失效（站主撤銷所有登入）：送出後回到登入頁，草稿留在登入表單裡；輸入合言葉後帶著草稿回到專區
  await page.goto(env.stack.visitorUrl + '/');
  const draft = 'JavaScript なしの下書き <i>斜体ではない</i>\n二行目';
  await page.fill('#reply-body', draft);
  const draftNonce = await page.locator('.reply__form input[name="nonce"]').getAttribute('value');
  assert.match(draftNonce, /^[a-f0-9]{32}$/);
  assert.equal((await env.admin.post('/access/revoke', { csrf: await adminCsrf(env.admin) })).status, 303);
  await page.click('.reply__form .room__btn', FORCE);
  await page.waitForSelector('#room-draft');
  assert.equal(await page.locator('.room__form input[name="nonce"]').getAttribute('value'), draftNonce, '草稿的送出編號跟著草稿一起放在登入表單裡');
  assert.equal(await page.locator('[data-reply-form]').count(), 0, '登入失效後看不到專區');
  assert.match(await page.locator('#room-status').textContent(), /送信できたかどうか確認できていません/);
  assert.equal(await page.locator('label[for="room-draft"]').textContent(), '送信を確認できていないメッセージ');
  assert.equal(await page.inputValue('#room-draft'), draft, '草稿留在畫面上');
  assert.equal(await page.locator('#room-draft').evaluate((el) => el.readOnly && el.form && el.form.getAttribute('action')), '/login', '草稿在登入表單裡（唯讀）');
  assert.equal(await page.locator('#room-draft i').count(), 0, '草稿只是文字');
  assert.ok(await noSideScroll(page));
  await page.fill('#room-pass', env.password);
  await page.click('.room__form .room__btn', FORCE);
  await page.waitForSelector('[data-reply-form]');
  assert.equal(await page.inputValue('#reply-body'), draft, '回到專區後草稿在回覆的輸入欄裡');
  assert.equal(await page.locator('.reply__form input[name="nonce"]').getAttribute('value'), draftNonce, '送出編號還是原本那一則的（重新登入不會換掉它）');
  assert.match(await page.locator('#reply-status').textContent(), /メッセージを送信できたかどうかは、まだ確認できていません/);
  assert.equal((await inbox()).filter((r) => r.body === draft).length, 0);
  await page.click('.reply__form .room__btn', FORCE);
  await page.waitForURL('**/?sent=1#reply');
  assert.equal((await inbox()).filter((r) => r.body === draft).length, 1);
  assert.notEqual(await page.locator('.reply__form input[name="nonce"]').getAttribute('value'), draftNonce, '送出成功後的頁面是下一則的送出編號');

  await page.goto(env.stack.visitorUrl + '/');
  await page.click('.room__lock-btn', FORCE);
  await page.waitForURL('**/?out=1');
  assert.match(await page.locator('#room-status').textContent(), /ログアウトしました/);
  assert.equal(await page.locator('[data-reply-form]').count(), 0);
  await context.close();
});

/* ================================================================================================
   只有真的瀏覽器才測得出來的防護
   ================================================================================================ */

test('登出之後：按「上一頁」、或直接打開看過的照片網址，都看不到私人內容', { skip }, async () => {
  const { context, page } = await open(DESKTOP, 'logout-back');
  await login(page);
  const photoUrl = env.stack.visitorUrl + await page.locator('[data-photo]').first().getAttribute('href');
  const seen = await page.goto(photoUrl);
  assert.equal(seen.status(), 200);
  assert.equal(seen.headers()['cache-control'], 'private, no-store');
  await page.goto(env.stack.visitorUrl + '/');
  await page.waitForSelector('[data-reply-form]');
  await page.click('.room__lock-btn');
  await page.waitForURL('**/?out=1');

  await page.goBack();
  await page.waitForLoadState();
  await sleep(300);
  assert.equal(await page.locator('[data-reply-form]').count(), 0, '上一頁不可以把登入後的畫面從記憶裡拿出來');
  assert.ok(!(await page.content()).includes(SAMPLE.title_ja));
  const again = await page.goto(photoUrl);
  assert.equal(again.status(), 401, '剛剛看過的照片，登出後同一個瀏覽器也拿不到（沒有留在瀏覽器的快取裡）');

  // 另一個全新的無痕視窗
  const fresh = await open(DESKTOP, 'fresh-incognito');
  const other = await fresh.page.goto(photoUrl);
  assert.equal(other.status(), 401);
  assert.ok(!(await fresh.page.content()).includes('JFIF'));
  await fresh.page.goto(env.stack.visitorUrl + '/');
  assert.equal(await fresh.page.locator('[data-reply-form]').count(), 0);
  assert.ok(!(await fresh.page.content()).includes(SAMPLE.title_ja));
  await fresh.context.close();
  await context.close();
});

test('在瀏覽器裡改登入旗標、自己塞 cookie，都沒有用', { skip }, async () => {
  const { context, page } = await open(DESKTOP, 'tamper');
  await page.goto(env.stack.visitorUrl + '/');
  await page.evaluate(() => {
    for (const store of [localStorage, sessionStorage]) {
      for (const key of ['loggedIn', 'isLoggedIn', 'auth', 'authenticated', 'unlocked', 'session', 'role']) { store.setItem(key, key === 'role' ? 'admin' : 'true'); }
    }
    document.cookie = 'loggedIn=true; path=/';
    document.cookie = 'room-session=forged; path=/';
    document.cookie = '__Host-room-session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA; path=/; Secure';
    window.loggedIn = true;
  });
  await context.addCookies([{ name: 'admin', value: '1', url: env.stack.visitorUrl }, { name: 'verified', value: 'ayaka', url: env.stack.visitorUrl }]);
  await page.reload();
  assert.equal(await page.locator('[data-reply-form]').count(), 0);
  assert.equal(await page.locator('#room-pass').count(), 1, '還是只有登入表單');
  assert.ok(!(await page.content()).includes(SAMPLE.title_ja));
  const photo = await context.request.get(`${env.stack.visitorUrl}/photo/${env.photoIds[0]}/full`);
  assert.equal(photo.status(), 401);
  // 把登入表單的 action 改掉、拿掉隱藏欄位再送，也進不去
  await page.evaluate(() => { document.querySelector('input[name=csrf]').value = 'tampered'; });
  await page.fill('#room-pass', env.password);
  await page.click('.room__btn');
  await page.waitForLoadState();
  assert.equal(await page.locator('[data-reply-form]').count(), 0, '防偽造編號被改掉的表單不受理');
  await context.close();
});

test('別的網站偷偷送出表單（跨站偽造請求）不會成功', { skip }, async () => {
  // 受害者已經登入
  const { context, page } = await open(DESKTOP, 'csrf');
  await login(page);
  const before = (await inbox()).length;
  // 在同一個瀏覽器裡打開「別的網站」（管理端的模擬網址是另一個來源），讓它自動送出登出與回覆的表單
  const attacker = await context.newPage();          // 這一頁是「別的網站」，它的錯誤訊息不算我們的
  const target = env.stack.visitorUrl;
  await attacker.route('http://attacker.test/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!DOCTYPE html><form id="f1" method="post" action="${target}/logout"><input name="csrf" value="x"></form>
<form id="f2" method="post" action="${target}/reply" target="frame2"><input name="csrf" value="x"><input name="nonce" value="${'a'.repeat(32)}"><input name="body" value="forged reply from another site"></form>
<iframe name="frame2"></iframe><script>document.getElementById('f2').submit(); setTimeout(() => document.getElementById('f1').submit(), 300);</script>`,
  }));
  await attacker.goto('http://attacker.test/');
  await attacker.waitForURL(target + '/logout');
  assert.match(await attacker.locator('body').textContent(), /Forbidden/);
  await attacker.close();
  await page.reload();
  assert.equal(await page.locator('[data-reply-form]').count(), 1, '沒有被別的網站登出');
  assert.equal((await inbox()).length, before, '別的網站送的回覆沒有被存下來');
  assert.ok(!(await inbox()).some((r) => r.body.includes('forged reply')));
  await context.close();
});

test('語言切換：日文預設，可以切到繁體中文，登入後也記得', { skip }, async () => {
  const { context, page } = await open(PHONE, 'lang');
  await page.goto(env.stack.visitorUrl + '/');
  assert.equal(await page.locator('html').getAttribute('lang'), 'ja');
  assert.equal(await page.locator('.lang-switch__btn[aria-current="true"]').textContent(), '日本語');
  await page.tap('.lang-switch__btn[href="/lang/zh"]');
  await page.waitForFunction(() => document.documentElement.lang === 'zh-Hant');
  assert.equal(await page.locator('h1').textContent(), '通關密語頁面');
  await page.fill('#room-pass', env.password);
  await page.tap('.room__btn');
  await page.waitForSelector('[data-reply-form]');
  assert.equal(await page.locator('h1').textContent(), SAMPLE.title_zh);
  assert.match(await page.locator('.room__caption').first().textContent(), /範例照片 1\s*2026 年 11 月 14 日/);
  assert.equal(await page.locator('.reply__title').textContent(), '回覆');
  assert.ok(await noSideScroll(page));
  await page.tap('.lang-switch__btn[href="/lang/ja"]');
  await page.waitForFunction(() => document.documentElement.lang === 'ja');
  assert.equal(await page.locator('h1').textContent(), SAMPLE.title_ja);
  await context.close();
});

test('各種寬度都不會橫向捲動（320–1440）', { skip }, async () => {
  for (const width of [320, 360, 390, 768, 1024, 1440]) {
    const { context, page } = await open({ ...DESKTOP, viewport: { width, height: 800 } }, `w${width}`);
    await page.goto(env.stack.visitorUrl + '/');
    assert.ok(await noSideScroll(page), `登入頁 ${width}`);
    await login(page);
    assert.ok(await noSideScroll(page), `專區 ${width}`);
    const img = await box(page, '.room__img');
    assert.ok(img.x >= 0 && img.x + img.width <= width, `照片不超出畫面 ${width}`);
    // 登入過期時出現的「重新登入」區塊、以及放大照片時的失敗提示
    await page.fill('#reply-body', 'あ'.repeat(120));
    await page.route('**/reply', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'session', message: tr('replySession', 'ja') }) }));
    await page.click('.reply__form .room__btn');
    await page.waitForSelector('#relogin:not([hidden])');
    assert.ok(await noSideScroll(page), `重新登入的區塊 ${width}`);
    const panel = await box(page, '#relogin');
    assert.ok(panel.x >= 0 && panel.x + panel.width <= width, `重新登入的區塊不超出畫面 ${width}`);
    await page.route('**/photo/*/full*', (route) => route.abort());
    await page.click('[data-photo]');
    await page.waitForSelector('dialog.lightbox[data-state="failed"]');
    const retry = await box(page, '.lightbox__btn--action'), note = await box(page, '.lightbox__message');
    assert.ok(retry.x >= 0 && retry.x + retry.width <= width && note.x >= 0 && note.x + note.width <= width, `放大照片的失敗提示不超出畫面 ${width}`);
    await context.close();
  }
});

test('無障礙檢查（axe-core）：登入頁、專區、放大照片、管理頁', { skip: skip || (axeSource ? false : '需要 axe-core') }, async () => {
  const check = async (page, label) => {
    await page.addScriptTag({ content: axeSource });
    const result = await page.evaluate(() => window.axe.run(document, { resultTypes: ['violations'] }));
    const bad = result.violations.map((v) => `${v.id}（${v.impact}）：${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join('、')}`);
    assert.deepEqual(bad, [], label);
  };
  for (const [options, name] of [[PHONE, '手機'], [{ ...DESKTOP, colorScheme: 'dark' }, '桌機深色']]) {
    const { context, page } = await open({ ...options, bypassCSP: true }, 'axe');   // axe 需要注入腳本，這個視窗才略過 CSP
    await page.goto(env.stack.visitorUrl + '/');
    await check(page, `${name}：登入頁`);
    await login(page);
    await check(page, `${name}：專區`);
    await page.click('[data-photo]');
    await page.waitForSelector('dialog.lightbox[open][data-state="ready"]');
    await check(page, `${name}：放大照片`);
    await page.route('**/photo/*/full*', (route) => route.abort());
    await page.keyboard.press('ArrowRight');
    await page.waitForSelector('dialog.lightbox[data-state="failed"]');
    await check(page, `${name}：放大照片（沒載入成功）`);
    await page.unroute('**/photo/*/full*');
    await page.keyboard.press('Escape');
    await page.fill('#reply-body', '下書き');
    await page.route('**/reply', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'session', message: tr('replySession', 'ja') }) }));
    await page.click('.reply__form .room__btn');
    await page.waitForSelector('#relogin:not([hidden])');
    await check(page, `${name}：登入過期（重新登入的區塊）`);
    await page.unroute('**/reply');
    for (const url of ['/', '/photos', '/content', '/access']) {
      await page.goto(env.adminBrowserUrl + url);
      await check(page, `${name}：管理頁 ${url}`);
    }
    await context.close();
  }
});

/* ================================================================================================
   管理頁（瀏覽器經由「模擬 Cloudflare Access」的轉送服務打開）
   ================================================================================================ */

test('管理頁：惡意 HTML 的回覆只會顯示成文字，不會執行；可以刪除', { skip }, async () => {
  const visitor = new Client(env.stack.visitorUrl);
  assert.equal((await visitorLogin(visitor, env.password)).status, 303);
  const form = await visitorForm(visitor);
  const evil = `<script>window.__xss = 1</script><img src=x onerror="window.__xss = 2"><svg onload="window.__xss = 3"></svg> ブラウザで確認`;
  assert.equal((await visitor.post('/reply', { csrf: form.csrf, nonce: form.nonce, body: evil })).status, 303);

  const { context, page } = await open(DESKTOP, 'admin-inbox');
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await page.goto(env.adminBrowserUrl + '/');
  const item = page.locator('.admin__reply', { hasText: 'ブラウザで確認' });
  assert.equal(await item.count(), 1);
  assert.equal(await item.locator('.admin__body').textContent(), evil, '畫面上看到的就是對方打的字');
  assert.equal(await item.locator('.admin__body *').count(), 0, '回覆裡沒有任何 HTML 元素');
  assert.equal(await page.evaluate(() => window.__xss), undefined, '裡面的程式沒有執行');
  assert.equal(dialogs.length, 0);
  assert.match(await page.locator('.admin__lead').first().textContent(), /持有訪客密碼的人.*無法確認寫的人是誰/);

  await item.locator('button', { hasText: '刪除' }).click();
  await page.waitForURL('**/?ok=deleted');
  assert.equal(dialogs.length, 1, '刪除前會先確認');
  assert.equal(await page.locator('.admin__reply', { hasText: 'ブラウザで確認' }).count(), 0);
  assert.ok(!(await inbox()).some((r) => r.body === evil));
  await context.close();
});

test('管理頁：上傳手機照片——瀏覽器先轉正、縮小，存下來的檔案沒有 GPS 等資料，訪客端看得到', { skip }, async () => {
  const original = readFileSync(fixturePath('phone-like.jpg'));
  assert.ok(original.includes('TestPhone 99') && original.includes('Exif'), '測試照片本身帶著裝置與 GPS 資料');
  const { context, page } = await open(DESKTOP, 'admin-upload');
  await page.goto(env.adminBrowserUrl + '/photos');
  assert.equal(await page.locator('.admin__photo').count(), 3);
  const form = page.locator('[data-upload-form]');
  await form.locator('input[type=file]').setInputFiles(fixturePath('phone-like.jpg'));
  await form.locator('input[name=alt_ja]').fill('縦長のサンプル画像');
  await form.locator('input[name=alt_zh]').fill('直式的範例圖片');
  await form.locator('input[name=caption_ja]').fill('スマホの写真を想定したテスト');
  await form.locator('input[name=caption_zh]').fill('模擬手機照片的測試');
  await form.locator('button[type=submit]').click();
  await page.waitForURL('**/photos?ok=uploaded');
  assert.equal(await page.locator('.admin__photo').count(), 4);
  const meta = await page.locator('.admin__photo').last().locator('.admin__meta').textContent();
  assert.match(meta, /1500×2000（縮圖 600×800）/, '橫向儲存、註明要轉 90 度的照片，上傳後是直的');

  const html = await page.content();
  const id = /\/photos\/([a-f0-9]{32})\/delete/g.exec(html.slice(html.lastIndexOf('class="admin__photo"')))[1];
  for (const [who, client] of [['管理端', env.admin]]) {
    for (const [size, w, h] of [['full', 1500, 2000], ['thumb', 600, 800]]) {
      const res = await client.get(`/photo/${id}/${size}`);
      assert.equal(res.status, 200);
      assert.deepEqual(inspectJpeg(res.buffer), { ok: true, width: w, height: h, meta: [] }, `${who} ${size}`);
      for (const leak of ['Exif', 'TestPhone', '2026:11:14']) { assert.ok(!res.buffer.includes(leak), `${size} 裡不應該有 ${leak}`); }
    }
  }
  // 訪客端：登入後看得到新照片
  const visitor = await open(PHONE, 'visitor-after-upload');
  await login(visitor.page);
  assert.equal(await visitor.page.locator('.room__img').count(), 4);
  assert.match(await visitor.page.locator('.room__caption').last().textContent(), /スマホの写真を想定したテスト/);
  await visitor.context.close();

  // PNG 也可以上傳（瀏覽器會轉成 JPEG）；刪除照片前會先確認
  await form.locator('input[type=file]').setInputFiles(fixturePath('not-a-jpeg.png'));
  await form.locator('input[name=alt_ja]').fill('PNG のテスト');
  await form.locator('input[name=alt_zh]').fill('PNG 測試');
  await form.locator('button[type=submit]').click();
  await page.waitForFunction(() => document.querySelectorAll('.admin__photo').length === 5);
  page.on('dialog', (d) => d.accept());
  for (let i = 0; i < 2; i++) {
    const done = page.waitForResponse((r) => r.url().endsWith('/photos?ok=deleted') && r.status() === 200);
    await page.locator('.admin__photo').last().locator('button', { hasText: '刪除這張照片' }).click();
    await done;
    await page.waitForLoadState();
  }
  assert.equal(await page.locator('.admin__photo').count(), 3);
  assert.equal((await env.admin.get(`/photo/${id}/full`)).status, 404);
  await context.close();
});

test('照片清理不會改變畫面：清理前後在瀏覽器裡解碼出來的每一個像素都相同；瀏覽器重新編碼的檔案照常通過', { skip }, async () => {
  const { context, page } = await open(DESKTOP, 'jpeg-pixels');
  await page.goto('about:blank');
  /** 在瀏覽器裡解碼兩個 JPEG，比較尺寸與每一個像素。
      （這裡不放「Exif 註明要轉 90 度」的照片：方向寫在 Exif 裡，去掉之後畫面會回到儲存時的方向——
      所以管理頁上傳時由瀏覽器先把照片轉正，再交給伺服器；那條路徑在上面的上傳測試裡。） */
  const samePixels = (a, b) => page.evaluate(async ([first, second]) => {
    const decode = async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), { imageOrientation: 'none' });
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      return { width: bitmap.width, height: bitmap.height, data: ctx.getImageData(0, 0, bitmap.width, bitmap.height).data };
    };
    const x = await decode(first), y = await decode(second);
    if (x.width !== y.width || x.height !== y.height) { return `size ${x.width}x${x.height} vs ${y.width}x${y.height}`; }
    for (let i = 0; i < x.data.length; i++) { if (x.data[i] !== y.data[i]) { return `pixel differs at byte ${i}`; } }
    return 'same';
  }, [Buffer.from(a).toString('base64'), Buffer.from(b).toString('base64')]);

  const read = (name) => readFileSync(fixturePath(name));
  const base = read('sample-3-thumb.jpg'), progressive = read('sample-3-full.jpg'), gray = read('gray.jpg');
  const segment = (marker, body) => Buffer.concat([Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
  const withHeader = (file, ...segments) => Buffer.concat([file.subarray(0, 2), ...segments, file.subarray(2 + JFIF_HEADER.length)]);
  const jfifWithThumbnail = segment(0xe0, Buffer.concat([Buffer.from('JFIF\0', 'latin1'), Buffer.from([1, 2, 1, 1, 44, 1, 44, 4, 3]), Buffer.alloc(36, 0x33), Buffer.from('extra-payload')]));
  const adobeWithExtras = segment(0xee, Buffer.concat([Buffer.from('Adobe'), Buffer.from([0, 101, 0x80, 0, 0, 0, 1]), Buffer.from('zz')]));
  const inputs = {
    '塞滿中繼資料的圖': read('with-metadata.jpg'),
    'JFIF 檔頭帶縮圖與多餘資料': withHeader(base, jfifWithThumbnail), '漸進式＋檔尾多餘資料': Buffer.concat([progressive, Buffer.from('TRAILER')]),
    '只有 Adobe 標記（沒有 JFIF）': withHeader(base, adobeWithExtras), 'JFIF 與 Adobe 都有': Buffer.concat([base.subarray(0, 2 + JFIF_HEADER.length), adobeWithExtras, base.subarray(2 + JFIF_HEADER.length)]),
    '灰階＋用不到的 Adobe 標記': Buffer.concat([gray.subarray(0, 2 + JFIF_HEADER.length), Buffer.from(adobeSegment(0)), gray.subarray(2 + JFIF_HEADER.length)]),
    '沒有任何檔頭': withHeader(base),
  };
  for (const [name, input] of Object.entries(inputs)) {
    const clean = stripJpeg(input);
    assert.equal(clean.ok, true, name);
    if (name !== '沒有任何檔頭') { assert.ok(clean.removed.length > 0, `${name}：有東西被去掉`); }
    assert.equal(await samePixels(input, clean.bytes), 'same', name);
  }

  // 瀏覽器（canvas）重新編碼出來的 JPEG（管理頁上傳時實際送出的那種檔案）
  const encoded = Buffer.from(await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), { imageOrientation: 'from-image' });
    const canvas = document.createElement('canvas');
    canvas.width = 600; canvas.height = 800;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, 600, 800);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
    return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
  }, read('phone-like.jpg').toString('base64')), 'base64');
  const info = inspectJpeg(encoded);
  assert.deepEqual([info.ok, info.width, info.height], [true, 600, 800]);
  // Chrome 會在重新編碼的檔案裡放一份 sRGB 的色彩描述檔（ICC）；除此之外沒有任何要去掉或改寫的東西，
  // JFIF 檔頭本來就是固定的那 18 個位元組——正常的上傳流程不受這一輪更嚴格的規則影響
  assert.ok(info.meta.every((kind) => kind === 'ICC'), `瀏覽器重新編碼的檔案裡，要去掉的頂多是色彩描述檔：${info.meta.join('、')}`);
  assert.ok(encoded.subarray(2, 2 + JFIF_HEADER.length).equals(Buffer.from(JFIF_HEADER)), '檔頭就是固定的那 18 個位元組');
  const cleaned = stripJpeg(encoded);
  assert.equal(await samePixels(encoded, cleaned.bytes), 'same', '去掉 sRGB 的色彩描述檔之後，畫面相同');
  assert.deepEqual(inspectJpeg(cleaned.bytes).meta, []);
  await context.close();
});

test('管理頁：手機上也能用；新密碼只顯示一次', { skip }, async () => {
  const { context, page } = await open(PHONE, 'admin-phone');
  for (const url of ['/', '/photos', '/content', '/access']) {
    await page.goto(env.adminBrowserUrl + url);
    assert.ok(await noSideScroll(page), `管理頁 ${url} 不可以橫向捲動`);
  }
  page.on('dialog', (d) => d.accept());
  await page.locator('form[action="/access/generate"] button').tap();
  await page.waitForSelector('[data-new-password]');
  const fresh = (await page.locator('[data-new-password]').textContent()).trim();
  assert.match(fresh, /^([0-9a-f]{4}-){7}[0-9a-f]{4}$/);
  const shownBox = await box(page, '[data-new-password]');
  assert.ok(shownBox.x >= 0 && shownBox.x + shownBox.width <= 390, '新密碼整組都在畫面內');
  assert.notEqual(fresh, env.password);
  assert.ok(await noSideScroll(page));
  await page.goto(env.adminBrowserUrl + '/access');
  assert.equal(await page.locator('[data-new-password]').count(), 0, '重新整理後就看不到了');
  assert.ok(!(await page.content()).includes(fresh));
  // 舊密碼失效、新密碼可以用
  assert.equal((await visitorLogin(new Client(env.stack.visitorUrl), env.password)).status, 401);
  assert.equal((await visitorLogin(new Client(env.stack.visitorUrl), fresh)).status, 303);
  env.password = fresh;
  await context.close();
});

test('所有頁面：沒有違反內容安全政策（CSP），也沒有程式錯誤', { skip }, async () => {
  assert.deepEqual(problems, []);
});
