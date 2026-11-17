// 訪客頁面腳本（visitor/public/room.js）的測試：不開瀏覽器，用一組假的頁面元素與可以控制回應時間的假 fetch，
// 直接執行同一份 room.js，檢查「回應晚到」「登入過期」「頁面上的編號過期」這些情況下，寫到一半的回覆會不會丟，
// 以及同一則回覆重送時用的是不是同一個送出編號（重新登入、換防偽造編號都不可以把它換掉）。
// （同樣的情境在真的瀏覽器裡也測一次，見 browser.spec.mjs。）
//
//   node --test tests/roomjs.spec.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(path.join(ROOT, 'visitor', 'public', 'room.js'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** 假的頁面元素：只有 room.js 用得到的那幾樣 */
class El {
  constructor(attrs = {}) {
    this.attrs = { ...attrs };
    this.listeners = {};
    this.found = {};            // querySelector 的結果：選擇器 → 元素（或陣列）
    this.value = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.readOnly = false;
    this.type = attrs.type || '';
    this.name = attrs.name || '';
    const classes = new Set();
    this.classList = { toggle: (name, on) => { if (on) { classes.add(name); } else { classes.delete(name); } }, contains: (name) => classes.has(name) };
  }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  removeAttribute(name) { delete this.attrs[name]; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  fire(type) { let prevented = false; for (const fn of this.listeners[type] || []) { fn({ preventDefault() { prevented = true; } }); } return prevented; }
  querySelector(selector) { const hit = this.found[selector]; return Array.isArray(hit) ? (hit[0] || null) : (hit || null); }
  querySelectorAll(selector) { const hit = this.found[selector]; return Array.isArray(hit) ? hit : (hit ? [hit] : []); }
  focus() { this.focused = (this.focused || 0) + 1; }
  select() {}
  scrollIntoView() {}
}

/** 組出登入後頁面上「回覆」那一區的元素，執行 room.js，回傳可以操作的把手 */
function setup() {
  const storageTouched = [];
  const forbidden = (name) => new Proxy({}, { get: (_, key) => { storageTouched.push(`${name}.${String(key)}`); return undefined; }, set: (_, key) => { storageTouched.push(`${name}.${String(key)}=`); return true; } });

  const area = new El({ name: 'body' });
  const csrf = new El({ name: 'csrf', type: 'hidden' }); csrf.value = 'csrf-old';
  const nonce = new El({ name: 'nonce', type: 'hidden' }); nonce.value = 'nonce-1';
  const logoutCsrf = new El({ name: 'csrf', type: 'hidden' }); logoutCsrf.value = 'csrf-old';
  const status = new El(), counter = new El({ 'data-template': '{count} / {max}', 'data-max': '2000' }), button = new El({ type: 'submit' });
  const form = new El({ 'data-sending': 'SENDING', 'data-failed': 'FAILED', 'data-sent-kept': 'SENT-BUT-BOX-NOT-EMPTY', 'data-session': 'SESSION-EXPIRED' });
  form.action = '/reply';
  form.elements = Object.assign([csrf, nonce, area, button], { nonce });
  form.found = { textarea: area, '[data-count]': counter, 'button[type="submit"]': button };

  const lead = new El(), password = new El({ name: 'password', type: 'password' }), loginButton = new El({ type: 'submit' }), loginStatus = new El();
  const copyBox = new El(), copyButton = new El(), copyStatus = new El();
  const loginForm = new El();
  loginForm.action = '/login';
  loginForm.found = { 'input[name="password"]': password, 'button[type="submit"]': loginButton, '.room__status': loginStatus, '[data-show-toggle] input': [] };
  const panel = new El({ 'data-lead-reply': 'LEAD-REPLY', 'data-lead-photo': 'LEAD-PHOTO', 'data-busy': 'BUSY', 'data-done': 'DONE', 'data-done-reply': 'DONE-SEND-AGAIN',
    'data-failed': 'LOGIN-FAILED', 'data-empty': 'EMPTY', 'data-copied': 'COPIED', 'data-copy-failed': 'COPY-FAILED' });
  panel.hidden = true;
  panel.found = { '[data-relogin-form]': loginForm, '.relogin__lead': lead, '[data-copy]': copyBox, '[data-copy-button]': copyButton, '[data-copy-status]': copyStatus };

  const byId = { relogin: panel, 'reply-status': status };
  const document = {
    getElementById: (id) => byId[id] || null,
    querySelector: (selector) => (selector === '[data-reply-form]' ? form : null),
    querySelectorAll: (selector) => {
      if (selector === '.reply__form input[name="csrf"], .room__logout input[name="csrf"]') { return [csrf, logoutCsrf]; }
      return [];
    },
    execCommand: () => false,
    get cookie() { storageTouched.push('document.cookie'); return ''; },
    set cookie(value) { storageTouched.push('document.cookie='); },
  };

  const calls = [];              // 每一次 fetch：{ url, method, body（URLSearchParams）, respond(status, data), fail() }
  const clipboard = [];
  const fetch = (url, init) => new Promise((resolve, reject) => {
    calls.push({
      url, method: init.method, init, body: new URLSearchParams(init.body || ''),
      respond: (statusCode, data) => resolve({ status: statusCode, ok: statusCode >= 200 && statusCode < 300, json: async () => data }),
      fail: () => reject(new TypeError('network')),
    });
  });
  const window = {
    fetch, URLSearchParams, AbortController, setTimeout, clearTimeout,
    navigator: { clipboard: { writeText: async (value) => { clipboard.push(value); } } },
    localStorage: forbidden('localStorage'), sessionStorage: forbidden('sessionStorage'), indexedDB: forbidden('indexedDB'),
  };
  // 瀏覽器裡 window 的東西也可以不寫 window. 直接用，所以兩種寫法都準備好
  vm.runInNewContext(SOURCE, { window, document, URLSearchParams, AbortController, setTimeout, clearTimeout, fetch,
    localStorage: window.localStorage, sessionStorage: window.sessionStorage, indexedDB: window.indexedDB });

  const type = (value) => { area.value = value; area.fire('input'); };
  const submit = () => form.fire('submit');
  return { area, csrf, nonce, logoutCsrf, status, button, form, panel, lead, password, loginForm, loginStatus, copyBox, copyButton, copyStatus, calls, clipboard, storageTouched, type, submit };
}

test('回應晚到：等待期間輸入欄是唯讀、按鈕停用；伺服器確認存好之後才清空', async () => {
  const page = setup();
  page.type('A：最初に書いた内容');
  assert.equal(page.submit(), true, '不換頁（由腳本送出）');
  await tick();
  assert.equal(page.calls.length, 1);
  assert.deepEqual([page.calls[0].url, page.calls[0].method, page.calls[0].body.get('body'), page.calls[0].body.get('csrf'), page.calls[0].body.get('nonce')], ['/reply', 'POST', 'A：最初に書いた内容', 'csrf-old', 'nonce-1']);
  // 回應還沒回來
  assert.equal(page.area.readOnly, true, '等待期間輸入欄鎖住，內容不會被改掉');
  assert.equal(page.button.disabled, true);
  assert.equal(page.status.textContent, 'SENDING');
  assert.equal(page.area.value, 'A：最初に書いた内容', '還沒確認存好之前不清空');
  // 等待期間再按一次送出：不會重送
  page.submit();
  await tick();
  assert.equal(page.calls.length, 1);
  // 伺服器回應：已經存好
  page.calls[0].respond(200, { ok: true, message: 'SENT', nonce: 'nonce-2' });
  await tick();
  assert.equal(page.area.value, '');
  assert.equal(page.area.readOnly, false);
  assert.equal(page.button.disabled, false);
  assert.equal(page.status.textContent, 'SENT');
  assert.equal(page.nonce.value, 'nonce-2', '伺服器確認存好之後才換下一個送出編號，下一則不會被當成重複');
});

test('送出 A 之後、回應回來之前內容變成了 B：A 的成功回應不會把 B 清掉', async () => {
  const page = setup();
  page.type('A：送ったもの');
  page.submit();
  await tick();
  // 就算有辦法繞過唯讀把內容改掉（例如瀏覽器的自動填入、輸入法、其他程式直接改欄位的值）
  page.area.value = 'B：待っている間に書き足したもの';
  page.calls[0].respond(200, { ok: true, message: 'SENT', nonce: 'nonce-2' });
  await tick();
  assert.equal(page.area.value, 'B：待っている間に書き足したもの', 'B 還在');
  assert.equal(page.status.textContent, 'SENT-BUT-BOX-NOT-EMPTY', '清楚說明：A 送出了，輸入欄裡現在的內容還沒有送出');
  assert.equal(page.nonce.value, 'nonce-2');
  assert.equal(page.area.readOnly, false);
  // 接著送出 B：送的是 B、用的是新的送出編號
  page.submit();
  await tick();
  assert.deepEqual([page.calls[1].body.get('body'), page.calls[1].body.get('nonce')], ['B：待っている間に書き足したもの', 'nonce-2']);
  page.calls[1].respond(200, { ok: true, message: 'SENT', nonce: 'nonce-3' });
  await tick();
  assert.equal(page.area.value, '');
});

test('送出失敗（伺服器回報失敗、限速、連不上）：內容留著、解除鎖定、送出編號不變', async () => {
  for (const [name, answer, expected] of [
    ['伺服器存不進去', (call) => call.respond(500, { ok: false, code: 'replyFailed', message: 'STORE-FAILED' }), 'STORE-FAILED'],
    ['太多次', (call) => call.respond(429, { ok: false, code: 'replyLimited', message: 'LIMITED' }), 'LIMITED'],
    ['連不上', (call) => call.fail(), 'FAILED'],
    ['回應不是 JSON', (call) => call.respond(502, null), 'FAILED'],
  ]) {
    const page = setup();
    page.type('KEEP：消えてはいけない内容');
    page.submit();
    await tick();
    answer(page.calls[0]);
    await tick();
    await tick();
    assert.equal(page.area.value, 'KEEP：消えてはいけない内容', name);
    assert.equal(page.area.readOnly, false, name);
    assert.equal(page.button.disabled, false, name);
    assert.equal(page.status.textContent, expected, name);
    assert.ok(page.status.classList.contains('room__status--error'), name);
    assert.equal(page.nonce.value, 'nonce-1', `${name}：送出編號不變，再送一次也不會存成兩筆`);
    assert.equal(page.panel.hidden, true, `${name}：不是登入過期，不出現重新登入`);
  }
});

test('登入過期：內容留著，可以複製；不離開頁面重新登入之後，用新的防偽造編號、原本的送出編號送出同一份內容', async () => {
  const page = setup();
  page.type('DRAFT：ログインが切れても残る内容');
  page.submit();
  await tick();
  page.calls[0].respond(401, { ok: false, code: 'session', message: 'SESSION-EXPIRED' });
  await tick();
  assert.equal(page.area.value, 'DRAFT：ログインが切れても残る内容');
  assert.equal(page.area.readOnly, false);
  assert.equal(page.status.textContent, 'SESSION-EXPIRED');
  assert.equal(page.panel.hidden, false, '出現重新登入的區塊');
  assert.equal(page.lead.textContent, 'LEAD-REPLY');
  assert.equal(page.copyBox.hidden, false, '有內容可以複製');

  // 複製
  page.copyButton.fire('click');
  await tick();
  assert.deepEqual(page.clipboard, ['DRAFT：ログインが切れても残る内容']);
  assert.equal(page.copyStatus.textContent, 'COPIED');

  // 沒填合言葉就按：不送任何請求
  page.loginForm.fire('submit');
  await tick();
  assert.equal(page.calls.length, 1);
  assert.equal(page.loginStatus.textContent, 'EMPTY');

  // 填了合言葉：先要登入用的編號，再送出；打錯時顯示伺服器給的說明，內容照樣留著
  page.password.value = 'wrong-password';
  page.loginForm.fire('submit');
  await tick();
  assert.deepEqual([page.calls[1].url, page.calls[1].method], ['/session', 'GET']);
  page.calls[1].respond(200, { signedIn: false, csrf: 'login-csrf', reply: null });
  await tick();
  assert.deepEqual([page.calls[2].url, page.calls[2].method, page.calls[2].body.get('csrf'), page.calls[2].body.get('password')], ['/login', 'POST', 'login-csrf', 'wrong-password']);
  page.calls[2].respond(401, { ok: false, code: 'errWrong', message: 'WRONG-PASSWORD' });
  await tick();
  assert.equal(page.loginStatus.textContent, 'WRONG-PASSWORD');
  assert.equal(page.panel.hidden, false);
  assert.equal(page.area.value, 'DRAFT：ログインが切れても残る内容');

  // 打對
  page.password.value = 'right-password';
  page.loginForm.fire('submit');
  await tick();
  page.calls[3].respond(200, { signedIn: false, csrf: 'login-csrf', reply: null });
  await tick();
  // 伺服器的登入回應只有新的防偽造編號。這裡故意多塞一個 nonce（模擬舊版伺服器、或日後有人不小心加回去）：頁面不可以採用
  page.calls[4].respond(200, { ok: true, csrf: 'csrf-new', nonce: 'nonce-from-login', message: 'DONE' });
  await tick();
  assert.equal(page.panel.hidden, true);
  assert.equal(page.password.value, '', '合言葉不留在頁面上');
  assert.deepEqual([page.csrf.value, page.logoutCsrf.value], ['csrf-new', 'csrf-new'], '回覆與登出的表單都換上新的防偽造編號');
  assert.equal(page.nonce.value, 'nonce-1', '送出編號不跟著登入換：還是原本那一則');
  assert.equal(page.status.textContent, 'DONE-SEND-AGAIN');
  assert.equal(page.area.value, 'DRAFT：ログインが切れても残る内容', '內容原封不動');

  // 再按送出
  page.submit();
  await tick();
  assert.deepEqual([page.calls[5].url, page.calls[5].body.get('csrf'), page.calls[5].body.get('nonce'), page.calls[5].body.get('body')], ['/reply', 'csrf-new', 'nonce-1', 'DRAFT：ログインが切れても残る内容']);
  page.calls[5].respond(200, { ok: true, message: 'SENT', nonce: 'nonce-after' });
  await tick();
  assert.equal(page.area.value, '');
  assert.equal(page.status.textContent, 'SENT');
  assert.equal(page.nonce.value, 'nonce-after', '確認存好之後才換');
});

test('頁面上的防偽造編號過期（例如在另一個分頁重新登入過）：自動換新的防偽造編號重送一次，內容與送出編號不變', async () => {
  const page = setup();
  page.type('STALE：別のタブでログインし直したあと');
  page.submit();
  await tick();
  page.calls[0].respond(403, { ok: false, code: 'errExpired', message: 'PAGE-TOO-OLD' });
  await tick();
  assert.deepEqual([page.calls[1].url, page.calls[1].method], ['/session', 'GET']);
  assert.equal(page.area.readOnly, true, '換編號的這段期間輸入欄維持鎖住');
  // /session 只給防偽造編號。這裡故意多塞一個 nonce：頁面不可以採用
  page.calls[1].respond(200, { signedIn: true, csrf: 'login-csrf', reply: { csrf: 'csrf-current', nonce: 'nonce-from-session' } });
  await tick();
  await tick();
  assert.deepEqual([page.calls[2].url, page.calls[2].body.get('csrf'), page.calls[2].body.get('nonce'), page.calls[2].body.get('body')], ['/reply', 'csrf-current', 'nonce-1', 'STALE：別のタブでログインし直したあと']);
  page.calls[2].respond(200, { ok: true, message: 'SENT', nonce: 'nonce-next' });
  await tick();
  assert.equal(page.area.value, '');
  assert.equal(page.status.textContent, 'SENT');
  assert.equal(page.logoutCsrf.value, 'csrf-current');

  // 換過編號還是被拒絕：不會一直重送，內容留著
  const again = setup();
  again.type('STALE-2');
  again.submit();
  await tick();
  again.calls[0].respond(403, { ok: false, code: 'errExpired', message: 'PAGE-TOO-OLD' });
  await tick();
  again.calls[1].respond(200, { signedIn: true, csrf: 'x', reply: { csrf: 'csrf-current' } });
  await tick();
  await tick();
  again.calls[2].respond(403, { ok: false, code: 'errExpired', message: 'PAGE-TOO-OLD' });
  await tick();
  await tick();
  assert.equal(again.calls.length, 3, '只自動重送一次');
  assert.deepEqual([again.area.value, again.area.readOnly, again.status.textContent], ['STALE-2', false, 'PAGE-TOO-OLD']);
  assert.equal(again.nonce.value, 'nonce-1');
  // /session 說是登入中，卻沒有給防偽造編號（不該發生）：不重送，內容留著
  const odd = setup();
  odd.type('STALE-4');
  odd.submit();
  await tick();
  odd.calls[0].respond(403, { ok: false, code: 'errExpired', message: 'PAGE-TOO-OLD' });
  await tick();
  odd.calls[1].respond(200, { signedIn: true, csrf: 'x', reply: {} });
  await tick();
  await tick();
  assert.equal(odd.calls.length, 2);
  assert.deepEqual([odd.area.value, odd.area.readOnly, odd.csrf.value, odd.status.textContent], ['STALE-4', false, 'csrf-old', 'PAGE-TOO-OLD']);

  // 要編號的時候才發現其實已經沒有登入：改成出現重新登入
  const gone = setup();
  gone.type('STALE-3');
  gone.submit();
  await tick();
  gone.calls[0].respond(403, { ok: false, code: 'errExpired', message: 'PAGE-TOO-OLD' });
  await tick();
  gone.calls[1].respond(200, { signedIn: false, csrf: 'x', reply: null });
  await tick();
  await tick();
  assert.deepEqual([gone.area.value, gone.area.readOnly, gone.panel.hidden, gone.status.textContent], ['STALE-3', false, false, 'SESSION-EXPIRED']);
});

test('同一則回覆從頭到尾用同一個送出編號：成功的回應沒有送到 → 重試 → 登入過期 → 重新登入 → 防偽造編號過期 → 再送，編號都不變；確認存好才換', async () => {
  const page = setup();
  const text = 'ONCE：保存されたのに、成功の返事が届かなかった内容';
  const sentWith = (index) => [page.calls[index].url, page.calls[index].body.get('csrf'), page.calls[index].body.get('nonce'), page.calls[index].body.get('body')];
  page.type(text);

  // 1. 第一次送出：伺服器其實存好了，但回應在路上斷了 → 頁面只知道「失敗」
  page.submit();
  await tick();
  assert.deepEqual(sentWith(0), ['/reply', 'csrf-old', 'nonce-1', text]);
  page.calls[0].fail();
  await tick();
  await tick();
  assert.deepEqual([page.area.value, page.nonce.value, page.status.textContent], [text, 'nonce-1', 'FAILED']);

  // 2. 再按一次，這時登入已經過期 → 出現重新登入
  page.submit();
  await tick();
  assert.deepEqual(sentWith(1), ['/reply', 'csrf-old', 'nonce-1', text]);
  page.calls[1].respond(401, { ok: false, code: 'session', message: 'SESSION-EXPIRED' });
  await tick();
  assert.equal(page.panel.hidden, false);
  assert.equal(page.nonce.value, 'nonce-1');

  // 3. 在頁面上重新登入：防偽造編號換新的，送出編號不動。
  //    （伺服器的登入回應與 /session 現在都不帶 nonce；這裡照以前的樣子多塞一個，確認頁面自己也不會採用——
  //    不管伺服器回什麼，換送出編號都只能發生在「確認存好」之後）
  page.password.value = 'right-password';
  page.loginForm.fire('submit');
  await tick();
  page.calls[2].respond(200, { signedIn: false, csrf: 'login-csrf', reply: null });
  await tick();
  page.calls[3].respond(200, { ok: true, csrf: 'csrf-2', nonce: 'nonce-from-login', message: 'DONE' });
  await tick();
  assert.deepEqual([page.csrf.value, page.nonce.value, page.area.value], ['csrf-2', 'nonce-1', text]);

  // 4. 再送：這一次碰上「防偽造編號又過期了」（在另一個分頁又登入過一次）→ 自動換防偽造編號重送，送出編號還是同一個
  page.submit();
  await tick();
  assert.deepEqual(sentWith(4), ['/reply', 'csrf-2', 'nonce-1', text]);
  page.calls[4].respond(403, { ok: false, code: 'errExpired', message: 'PAGE-TOO-OLD' });
  await tick();
  page.calls[5].respond(200, { signedIn: true, csrf: 'login-csrf', reply: { csrf: 'csrf-3', nonce: 'nonce-from-session' } });
  await tick();
  await tick();
  assert.deepEqual(sentWith(6), ['/reply', 'csrf-3', 'nonce-1', text]);

  // 5. 伺服器確認存好（它認得出這是同一次送出，不會多存一筆）→ 這時才換下一個送出編號、清空輸入欄
  page.calls[6].respond(200, { ok: true, message: 'SENT', nonce: 'nonce-2' });
  await tick();
  assert.deepEqual([page.area.value, page.nonce.value, page.csrf.value, page.status.textContent], ['', 'nonce-2', 'csrf-3', 'SENT']);
  // 每一次送往 /reply 的請求，用的都是同一個送出編號
  assert.deepEqual(page.calls.filter((call) => call.url === '/reply').map((call) => call.body.get('nonce')), ['nonce-1', 'nonce-1', 'nonce-1', 'nonce-1']);

  // 6. 下一則：就算文字一模一樣，用的是新的送出編號（伺服器會當成新的一則）
  page.type(text);
  page.submit();
  await tick();
  assert.deepEqual(sentWith(7), ['/reply', 'csrf-3', 'nonce-2', text]);
  page.calls[7].respond(200, { ok: true, message: 'SENT', nonce: 'nonce-3' });      // 把最後一個請求回掉（不然頁面上 30 秒的計時器會讓測試多等 30 秒）
  await tick();
  assert.deepEqual([page.area.value, page.nonce.value], ['', 'nonce-3']);
});

test('隨機安排的操作與伺服器回應：送出編號只在「確認存好」之後才換；內容只在確認存好之後才清空', async () => {
  // 固定種子的亂數：每次執行走的是同一條路
  const random = (seed) => () => { seed = (seed + 0x6D2B79F5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const totals = { replies: 0, stored: 0, relogins: 0, refreshed: 0 };
  for (const seed of [1, 22, 333, 20261115]) {
    const next = random(seed);
    const pick = (list) => list[Math.floor(next() * list.length)];
    const page = setup();
    let expectedNonce = 'nonce-1';     // 頁面現在應該用的送出編號
    let issued = 1, answered = 0, typed = 0, signedIn = true;
    const where = () => `種子 ${seed}，第 ${answered} 個回應之後`;
    const settle = async () => { await tick(); await tick(); await tick(); };
    for (let step = 0; step < 300; step++) {
      const pending = page.calls[answered];
      if (pending) {
        // 伺服器（或網路）回應最早那個還沒回的請求
        const before = { nonce: page.nonce.value, text: page.area.value };
        answered += 1;
        if (pending.url === '/reply') {
          totals.replies += 1;
          assert.equal(pending.body.get('nonce'), expectedNonce, `${where()}：送出的請求要帶著目前這一則的送出編號`);
          assert.equal(pending.body.get('body'), before.text, where());
          const outcome = signedIn ? pick(['ok', 'ok', 'stale', 'limited', 'failed', 'network', 'garbage', 'expired']) : pick(['expired', 'expired', 'network']);
          if (outcome === 'ok') {
            issued += 1;
            pending.respond(200, { ok: true, message: 'SENT', nonce: `nonce-${issued}` });
            await settle();
            expectedNonce = `nonce-${issued}`;
            totals.stored += 1;
            assert.equal(page.area.value, '', `${where()}：確認存好之後清空`);
          } else {
            if (outcome === 'stale') { pending.respond(403, { ok: false, code: 'errExpired', message: 'PAGE-TOO-OLD' }); }
            if (outcome === 'limited') { pending.respond(429, { ok: false, code: 'replyLimited', message: 'LIMITED' }); }
            if (outcome === 'failed') { pending.respond(500, { ok: false, code: 'replyFailed', message: 'STORE-FAILED' }); }
            if (outcome === 'garbage') { pending.respond(502, null); }
            if (outcome === 'network') { pending.fail(); }
            if (outcome === 'expired') { signedIn = false; pending.respond(401, { ok: false, code: 'session', message: 'SESSION-EXPIRED' }); }
            await settle();
            assert.equal(page.area.value, before.text, `${where()}：沒有確認存好，內容要留著（${outcome}）`);
          }
        } else if (pending.url === '/session') {
          // 回應裡故意多帶一個 nonce：頁面不可以採用
          pending.respond(200, { signedIn, csrf: 'login-csrf', reply: signedIn ? { csrf: `csrf-s${answered}`, nonce: `stray-session-${answered}` } : null });
          if (signedIn) { totals.refreshed += 1; }
          await settle();
          assert.equal(page.area.value, before.text, where());
        } else {
          assert.equal(pending.url, '/login');
          const outcome = pick(['ok', 'ok', 'wrong', 'network']);
          if (outcome === 'ok') { signedIn = true; totals.relogins += 1; pending.respond(200, { ok: true, csrf: `csrf-l${answered}`, nonce: `stray-login-${answered}`, message: 'DONE' }); }
          if (outcome === 'wrong') { pending.respond(401, { ok: false, code: 'errWrong', message: 'WRONG-PASSWORD' }); }
          if (outcome === 'network') { pending.fail(); }
          await settle();
          assert.equal(page.area.value, before.text, `${where()}：重新登入不會動到內容`);
        }
        assert.equal(page.nonce.value, expectedNonce, `${where()}：送出編號只在確認存好之後才換（${pending.url}）`);
        continue;
      }
      // 沒有等待中的請求：使用者做一件事
      const action = pick(page.panel.hidden ? ['type', 'send', 'send', 'send'] : ['type', 'send', 'relogin', 'relogin']);
      if (action === 'type' || !page.area.value) { typed += 1; page.type(`TEXT-${seed}-${typed}`); }
      if (action === 'send') { page.submit(); }
      if (action === 'relogin') { page.password.value = 'the-password'; page.loginForm.fire('submit'); }
      await settle();
      assert.equal(page.nonce.value, expectedNonce, `${where()}：使用者的操作不會換掉送出編號`);
    }
    // 收尾：把還在等的請求都回掉（不然頁面上 30 秒的計時器會讓測試等到逾時）
    while (page.calls[answered]) { page.calls[answered].fail(); answered += 1; await settle(); }
    assert.equal(page.nonce.value, expectedNonce);
    assert.deepEqual(page.storageTouched, []);
    // 送往 /reply 的每一個請求，帶的送出編號只會是「當時那一則」的：同一個編號可以出現很多次（重送），但換了之後不會再回頭用舊的
    const used = page.calls.filter((call) => call.url === '/reply').map((call) => Number(call.body.get('nonce').replace('nonce-', '')));
    assert.ok(used.every((n, i) => Number.isInteger(n) && (i === 0 || n >= used[i - 1])), `種子 ${seed}：${used.join(',')}`);
    assert.ok(!page.calls.some((call) => /stray/.test(call.init.body || '')), '回應裡多帶的編號從來沒有被用來送出');
  }
  assert.ok(totals.replies > 150 && totals.stored > 30 && totals.relogins > 10 && totals.refreshed > 10, JSON.stringify(totals));   // 各種情況都走到了
});

test('寫到一半的回覆與合言葉不會被寫進瀏覽器的儲存空間', async () => {
  const page = setup();
  page.type('PRIVATE-DRAFT');
  page.submit();
  await tick();
  page.calls[0].respond(401, { ok: false, code: 'session', message: 'SESSION-EXPIRED' });
  await tick();
  page.copyButton.fire('click');
  page.password.value = 'the-password';
  page.loginForm.fire('submit');
  await tick();
  page.calls[1].respond(200, { signedIn: false, csrf: 'login-csrf', reply: null });
  await tick();
  page.calls[2].respond(200, { ok: true, csrf: 'c', message: 'DONE' });
  await tick();
  page.submit();
  await tick();
  page.calls[3].respond(200, { ok: true, message: 'SENT', nonce: 'n2' });
  await tick();
  assert.deepEqual(page.storageTouched, [], '沒有碰 localStorage、sessionStorage、indexedDB 或 document.cookie');
  // 送出去的請求只有三種網址，都是本站的相對路徑；密碼只出現在送往 /login 的那一次
  assert.deepEqual([...new Set(page.calls.map((call) => call.url))].sort(), ['/login', '/reply', '/session']);
  for (const call of page.calls) {
    assert.equal(call.init.credentials, 'same-origin');
    assert.equal(call.init.redirect, 'error');
    assert.equal(String(call.init.body || '').includes('the-password'), call.url === '/login');
  }
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  for (const banned of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'doc.cookie', 'caches.']) { assert.ok(!code.includes(banned), banned); }
});
