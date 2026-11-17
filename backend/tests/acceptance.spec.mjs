// 驗收測試：在本機的受控測試環境（wrangler dev，執行引擎和 Cloudflare 正式環境相同）把訪客端與管理端跑起來，
// 用真的 HTTP 請求逐項確認。對應 Codex 交辦的八項驗收（第 8 項的手機畫面在 browser.spec.mjs）。
//
//   node --test tests/acceptance.spec.mjs
//
// 測試用的金鑰、密碼、管理者憑證都是每次執行時隨機產生的；圖片是合成的範例圖。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { generateKeyPair, SignJWT } from 'jose';
import path from 'node:path';

import { startStack, ROOT, ADMIN_EMAIL, ACCESS_AUD } from './helpers/stack.mjs';
import { Client, field, visitorLogin, visitorForm, adminClient, adminCsrf, accessForm, generateVisitorPassword, streamPost } from './helpers/client.mjs';
import { inspectJpeg, JFIF_HEADER } from '../shared/jpeg.js';
import { normalizePassword, hashPassword } from '../shared/password.js';

const fixture = (name) => readFileSync(path.join(ROOT, 'tests', 'fixtures', name));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 只會存在資料庫裡的「私人內容」。每一項都帶著獨特的記號，方便確認它們沒有出現在不該出現的回應裡
const PRIVATE = {
  title_ja: 'PRIVATE-TITLE-7f3a 確認用のタイトル',
  title_zh: 'PRIVATE-TITLE-7f3a 確認用的標題',
  message_ja: 'PRIVATE-MESSAGE-91c2 これは確認用の文章です。\n\n二つ目の段落です。',
  message_zh: 'PRIVATE-MESSAGE-91c2 這是確認用的文字。\n\n第二段。',
  signature: 'PRIVATE-SIGN-55d0',
};
const PRIVATE_MARKERS = ['PRIVATE-TITLE', 'PRIVATE-MESSAGE', 'PRIVATE-SIGN', 'PRIVATE-ALT', 'PRIVATE-CAPTION'];

let stack, admin, password, photos = [];
const secretsSeen = { passwords: [], sessionTokens: [], replyBodies: [], adminTokens: [] };

const noPrivate = (text, where) => {
  for (const marker of PRIVATE_MARKERS) { assert.ok(!text.includes(marker), `${where} 不應該出現 ${marker}`); }
  for (const photo of photos) { assert.ok(!text.includes(photo.id), `${where} 不應該出現照片編號`); }
  for (const body of secretsSeen.replyBodies) { assert.ok(!text.includes(body.slice(0, 24)), `${where} 不應該出現回覆內容`); }
};
/** 回覆表單下面那一行狀態文字（畫面上實際顯示的訊息） */
const replyStatus = (html) => (/<p class="room__status[^"]*" id="reply-status"[^>]*>([^<]*)<\/p>/.exec(html) || [null, ''])[1];
const gateStatus = (html) => (/<p class="room__status[^"]*" id="room-status"[^>]*>([^<]*)<\/p>/.exec(html) || [null, ''])[1];
// 斷定「沒有送出」的說法。沒有收到「已經存好」的確認時，畫面上不可以出現（那一則有可能其實已經存好）
const SAYS_NOT_SENT = /送信できませんでした|送信されていません|送信されていない/;
const isGate = (res) => res.text.includes('action="/login"') && !res.text.includes('data-reply-form');
const isRoom = (res) => res.text.includes('data-reply-form') && res.text.includes('PRIVATE-TITLE-7f3a');

async function uploadPhoto(client, options) {
  const data = new FormData();
  data.append('csrf', options.csrf || await adminCsrf(client, '/photos'));
  for (const key of ['alt_ja', 'alt_zh', 'caption_ja', 'caption_zh', 'taken_on']) { data.append(key, options[key] || ''); }
  if (options.full) { data.append('full', new Blob([options.full], { type: 'image/jpeg' }), 'full.jpg'); }
  if (options.thumb) { data.append('thumb', new Blob([options.thumb], { type: 'image/jpeg' }), 'thumb.jpg'); }
  const res = await client.request('/photos', { method: 'POST', body: data, headers: { Accept: 'application/json' }, origin: options.origin });
  let body = null;
  try { body = JSON.parse(res.text); } catch (err) { /* 不是 JSON（例如 403） */ }
  return { res, body };
}

async function inbox() {
  const res = await admin.get('/export.json');
  assert.equal(res.status, 200);
  return JSON.parse(res.text).replies;
}

async function newVisitor(base = stack.visitorUrl) {
  const client = new Client(base);
  const res = await visitorLogin(client, password);
  assert.equal(res.status, 303, '登入應該成功');
  secretsSeen.sessionTokens.push(client.jar.get('__Host-room-session'));
  return client;
}

async function sendReply(client, body, options = {}) {
  const form = options.form || await visitorForm(client);
  const fields = { csrf: options.csrf === undefined ? form.csrf : options.csrf, nonce: options.nonce || form.nonce, body };
  const res = await client.post('/reply', fields, { headers: options.json ? { Accept: 'application/json' } : {}, origin: options.origin });
  return { res, form, json: options.json && res.headers.get('content-type')?.includes('json') ? JSON.parse(res.text) : null };
}

async function unlockLogin() {
  const res = await admin.post('/access/unlock', { csrf: await adminCsrf(admin) });
  assert.equal(res.status, 303);
}

/** 限速用的是固定時間窗；測試剛好跨過時間窗的交界會誤判，所以太接近交界時先等一下 */
async function awayFromWindowEdge(windowSeconds = 600, marginSeconds = 6) {
  const left = windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds);
  if (left <= marginSeconds) { await sleep((left + 1) * 1000); }
}

before(async () => {
  stack = await startStack({ shortTtlSeconds: 2 });
  const token = await stack.access.sign({ lifetime: 3600 });
  secretsSeen.adminTokens.push(token);
  admin = adminClient(stack, token);

  // 站主在管理頁放進私人內容：標題、留言、三張照片（其中一張故意帶著 GPS 等中繼資料）
  const saved = await admin.post('/content', { csrf: await adminCsrf(admin, '/content'), ...PRIVATE });
  assert.equal(saved.status, 303);
  const uploads = [
    { full: fixture('sample-1-full.jpg'), thumb: fixture('sample-1-thumb.jpg'), n: 1 },
    { full: fixture('sample-2-full.jpg'), thumb: fixture('sample-2-thumb.jpg'), n: 2 },
    { full: fixture('with-metadata.jpg'), thumb: fixture('with-metadata.jpg'), n: 3 },
  ];
  for (const item of uploads) {
    const { res, body } = await uploadPhoto(admin, {
      full: item.full, thumb: item.thumb, taken_on: '2026-11-14',
      alt_ja: `PRIVATE-ALT-${item.n} サンプル画像`, alt_zh: `PRIVATE-ALT-${item.n} 範例圖片`,
      caption_ja: `PRIVATE-CAPTION-${item.n} サンプルの写真`, caption_zh: `PRIVATE-CAPTION-${item.n} 範例照片`,
    });
    assert.equal(res.status, 200, res.text);
    photos.push({ id: body.id, removed: body.removed });
  }
  password = await generateVisitorPassword(admin);
  secretsSeen.passwords.push(password);
});

after(async () => {
  if (stack) { await stack.stop(); }
});

/* ================================================================================================
   驗收 1：全新的無痕視窗、不帶登入 cookie 的請求，拿不到私人頁面內容、原圖、縮圖或私人 API 資料
   ================================================================================================ */

test('驗收 1-1：沒登入時，首頁只有登入表單，沒有任何私人內容', async () => {
  const anon = new Client(stack.visitorUrl);
  for (const url of ['/', '/?sent=1', '/?out=1', '/?page=2']) {
    const res = await anon.get(url, { cookies: false });
    assert.equal(res.status, 200, url);
    assert.ok(isGate(res), `${url} 應該是登入表單`);
    noPrivate(res.text, url);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
  }
  const zh = await new Client(stack.visitorUrl).get('/', { headers: { Cookie: '__Host-room-lang=zh' } });
  assert.ok(isGate(zh) && zh.text.includes('通關密語'));
  noPrivate(zh.text, '中文的登入頁');
});

test('驗收 1-2：沒登入時，縮圖與原圖一律 401，而且回應裡沒有圖片資料', async () => {
  const anon = new Client(stack.visitorUrl);
  for (const photo of photos) {
    for (const size of ['thumb', 'full']) {
      for (const method of ['GET', 'HEAD']) {
        const res = await anon.request(`/photo/${photo.id}/${size}`, { method });
        assert.equal(res.status, 401, `${method} ${size}`);
        assert.ok(!(res.headers.get('content-type') || '').includes('image'));
        assert.ok(res.buffer.length < 64, '回應裡不應該有圖片');
        assert.equal(res.headers.get('cache-control'), 'private, no-store');
      }
    }
  }
});

test('驗收 1-3：沒登入時不能送出回覆，也碰不到任何私人 API', async () => {
  const before = (await inbox()).length;
  const anon = new Client(stack.visitorUrl);
  const html = await anon.post('/reply', { csrf: 'x'.repeat(64), nonce: 'a'.repeat(32), body: 'anonymous reply attempt' });
  assert.equal(html.status, 401);
  assert.ok(isGate(html));
  noPrivate(html.text, '未登入送出回覆的回應');
  const api = await anon.post('/reply', { csrf: 'x'.repeat(64), nonce: 'b'.repeat(32), body: 'anonymous reply attempt 2' }, { headers: { Accept: 'application/json' } });
  assert.equal(api.status, 401);
  assert.deepEqual([JSON.parse(api.text).ok, JSON.parse(api.text).code], [false, 'session']);
  assert.equal((await inbox()).length, before, '沒登入的回覆不可以被存下來');
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const res = await anon.request(`/photo/${photos[0].id}/full`, { method });
    assert.equal(res.status, 405);
  }
});

test('驗收 1-4：管理端沒有 Cloudflare Access 的憑證時，任何路徑（包含樣式與腳本）都是 403', async () => {
  const anon = new Client(stack.adminUrl);
  const paths = ['/', '/photos', '/content', '/access', '/export.json', `/photo/${photos[0].id}/full`, `/photo/${photos[0].id}/thumb`, '/room.css', '/admin.css', '/admin.js', '/favicon.svg', '/no-such-page',
    '/cdn-cgi/local/explorer/api/d1/database', '/cdn-cgi/local/explorer/api/r2/buckets'];
  for (const url of paths) {
    const res = await anon.get(url);
    assert.equal(res.status, 403, url);
    assert.equal(res.text, 'Forbidden (missing-token)\n');
  }
  for (const url of ['/content', '/access/generate', '/access/revoke', '/access/unlock', '/photos', `/photos/${photos[0].id}`, `/photos/${photos[0].id}/delete`, `/replies/${'a'.repeat(32)}/delete`]) {
    const res = await anon.post(url, { csrf: 'x', password: 'whatever-whatever-whatever' });
    assert.equal(res.status, 403, 'POST ' + url);
  }
});

test('驗收 1-5：任何人都拿得到的檔案（樣式、腳本、圖示、robots.txt、找不到的頁面）裡沒有私人內容', async () => {
  const anon = new Client(stack.visitorUrl);
  for (const url of ['/room.css', '/room.js', '/favicon.svg', '/robots.txt', '/no-such-page', '/photo/', '/photo/abc/full', '/replies', '/admin', '/.env', '/.dev.vars', '/wrangler.jsonc', '/src/index.js', '/_headers',
    '/cdn-cgi/local/explorer/api/d1/database', '/cdn-cgi/local/explorer/api/r2/buckets', '/cdn-cgi/local/explorer/api/local/workers']) {   // 最後三個：wrangler dev 的開發者檢視網址，測試環境已關閉
    const res = await anon.get(url);
    noPrivate(res.text, url);
    assert.ok(!res.text.includes(stack.secrets.PEPPER) && !res.text.includes(stack.secrets.SESSION_SECRET), url);
    if (!['/room.css', '/room.js', '/favicon.svg', '/robots.txt'].includes(url)) { assert.ok([401, 404].includes(res.status), `${url} → ${res.status}`); }
  }
  const robots = await anon.get('/robots.txt');
  assert.equal(robots.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  for (const url of ['/', `/photo/${photos[0].id}/full`, '/no-such-page']) {
    assert.equal((await anon.get(url)).headers.get('x-robots-tag'), 'noindex, nofollow, noarchive', url);
  }
});

/* ================================================================================================
   驗收 2：修改瀏覽器內的登入旗標或偽造 cookie，不能取得存取權限
   ================================================================================================ */

test('驗收 2-1：偽造或竄改登入 cookie、加上各種「已登入」的旗標，都還是只看得到登入表單', async () => {
  const real = await newVisitor();
  const token = real.jar.get('__Host-room-session');
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
  const { createHash, randomBytes } = await import('node:crypto');
  const forged = [
    '__Host-room-session=1', '__Host-room-session=true', '__Host-room-session=admin', '__Host-room-session=',
    `__Host-room-session=${randomBytes(32).toString('base64url')}`,
    `__Host-room-session=${flip(token, 0)}`, `__Host-room-session=${flip(token, 21)}`, `__Host-room-session=${flip(token, 42)}`,
    `__Host-room-session=${token.slice(0, 42)}`, `__Host-room-session=${token}A`,
    `__Host-room-session=${token.toLowerCase() === token ? token.toUpperCase() : token.toLowerCase()}`,
    `__Host-room-session=${createHash('sha256').update(token).digest('hex')}`,          // 資料庫裡存的是這個雜湊；拿雜湊當憑證也沒有用
    `room-session=${token}`, `session=${token}`, `__Secure-room-session=${token}`,          // 名字不對
    'loggedIn=true; isLoggedIn=1; auth=1; role=admin; admin=true; unlocked=1; room=open',
    `__Host-room-csrf=${'a'.repeat(32)}; __Host-room-lang=zh; verified=ayaka`,
    `__Host-room-session=bad; __Host-room-session=${token}`,                               // 同名兩個：只看第一個
  ];
  for (const cookieHeader of forged) {
    const client = new Client(stack.visitorUrl);
    const page = await client.get('/', { headers: { Cookie: cookieHeader }, cookies: false });
    assert.ok(isGate(page), `偽造的 cookie 不應該有用：${cookieHeader.slice(0, 40)}`);
    noPrivate(page.text, '偽造 cookie 的回應');
    const photo = await client.get(`/photo/${photos[0].id}/full`, { headers: { Cookie: cookieHeader }, cookies: false });
    assert.equal(photo.status, 401);
  }
  // 對照組：真的 cookie 看得到
  assert.ok(isRoom(await real.get('/')));
});

test('驗收 2-2：用網址參數或標頭假裝已登入也沒有用', async () => {
  const client = new Client(stack.visitorUrl);
  const tries = [
    ['/?session=1&admin=1&loggedIn=true&token=abc', {}],
    ['/', { Authorization: 'Bearer admin' }],
    ['/', { 'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '127.0.0.1', 'X-Admin': '1' }],
    ['/', { 'Cf-Access-Jwt-Assertion': await stack.access.sign() }],                         // 管理者的憑證在訪客端沒有任何作用
    ['/', { 'Cf-Access-Authenticated-User-Email': ADMIN_EMAIL }],
  ];
  for (const [url, headers] of tries) {
    const res = await client.get(url, { headers, cookies: false });
    assert.ok(isGate(res), JSON.stringify(headers));
    assert.equal((await client.get(`/photo/${photos[0].id}/thumb`, { headers, cookies: false })).status, 401);
  }
});

test('驗收 2-3：偽造的管理者憑證（沒簽章、別人簽的、對象不符、過期、信箱不符…）一律 403', async () => {
  const other = await generateKeyPair('RS256');
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims = { email: ADMIN_EMAIL, iss: stack.access.issuer, aud: ACCESS_AUD, iat: nowSeconds, exp: nowSeconds + 300 };
  const hmacKey = new TextEncoder().encode(JSON.stringify(stack.access.jwk));
  const valid = await stack.access.sign();
  const [h, p, sig] = valid.split('.');
  const forged = {
    '沒有憑證': null,
    '空字串': '',
    '亂碼': 'not-a-jwt',
    '沒有簽章（alg none）': `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`,
    '別的金鑰簽的（kid 相同）': await stack.access.sign({ key: other.privateKey }),
    '別的金鑰簽的（kid 不同）': await stack.access.sign({ key: other.privateKey, kid: 'attacker-key' }),
    '把公鑰當成 HMAC 密鑰簽的（演算法混淆）': await new SignJWT({ email: ADMIN_EMAIL }).setProtectedHeader({ alg: 'HS256', kid: stack.access.kid }).setIssuer(stack.access.issuer).setAudience(ACCESS_AUD).setIssuedAt().setExpirationTime('5m').sign(hmacKey),
    '對象（AUD）不符': await stack.access.sign({ audience: 'some-other-application' }),
    '發行者不符': await stack.access.sign({ issuer: 'https://attacker.cloudflareaccess.com' }),
    '已經過期': await stack.access.sign({ issuedOffset: -7200, lifetime: 3600 }),
    '信箱不是站主': await stack.access.sign({ email: 'someone-else@example.test' }),
    '信箱很像站主': await stack.access.sign({ email: ADMIN_EMAIL + '.evil.test' }),
    '沒有信箱': await stack.access.sign({ email: null }),
    '簽章被改掉一個字': `${h}.${p}.${sig.slice(0, -2)}${sig.slice(-2) === 'AA' ? 'BB' : 'AA'}`,
    '內容被改過（期限延長）': `${h}.${b64({ ...claims, exp: nowSeconds + 999999 })}.${sig}`,
  };
  const reasons = {};
  for (const [name, token] of Object.entries(forged)) {
    const client = adminClient(stack, token);
    for (const url of ['/', '/export.json', '/access', '/admin.js']) {
      const res = await client.get(url);
      assert.equal(res.status, 403, `${name} → ${url}`);
      assert.match(res.text, /^Forbidden \([a-z-]+\)\n/);
      noPrivate(res.text, name);
      reasons[name] = /^Forbidden \(([a-z-]+)\)/.exec(res.text)[1];
    }
    const post = await client.post('/access/generate', { csrf: 'x'.repeat(64) });
    assert.equal(post.status, 403, `${name} → POST`);
  }
  // 每一種被拒絕的原因（給站主排查設定用；寫進日誌的也只有這個代碼）
  assert.deepEqual(reasons, {
    '沒有憑證': 'missing-token', '空字串': 'missing-token', '亂碼': 'invalid-token', '沒有簽章（alg none）': 'invalid-token',
    '別的金鑰簽的（kid 相同）': 'invalid-token', '別的金鑰簽的（kid 不同）': 'invalid-token', '把公鑰當成 HMAC 密鑰簽的（演算法混淆）': 'invalid-token',
    '對象（AUD）不符': 'aud-mismatch', '發行者不符': 'invalid-token', '已經過期': 'invalid-token',
    '信箱不是站主': 'not-allowed', '信箱很像站主': 'not-allowed', '沒有信箱': 'no-email',
    '簽章被改掉一個字': 'invalid-token', '內容被改過（期限延長）': 'invalid-token',
  });
  // 憑證只認標頭：放在 cookie 裡沒有用
  const viaCookie = await new Client(stack.adminUrl).get('/', { headers: { Cookie: `CF_Authorization=${valid}` } });
  assert.equal(viaCookie.status, 403);
  // 對照組：真的憑證可以用，而且訪客密碼沒有因為上面的嘗試被換掉
  assert.equal((await adminClient(stack, valid).get('/')).status, 200);
  assert.equal((await visitorLogin(new Client(stack.visitorUrl), password)).status, 303);
});

/* ================================================================================================
   驗收 3：持訪客密碼的人，不能使用管理功能或讀取其他人的回覆
   ================================================================================================ */

test('驗收 3：訪客登入後只能看專區與送出回覆；讀不到任何回覆（包含自己的），也碰不到管理功能', async () => {
  const a = await newVisitor();
  const b = await newVisitor();
  const text = 'REPLY-FROM-A-3b1f 他の人には見えないはずのメッセージ';
  secretsSeen.replyBodies.push(text);
  const sent = await sendReply(a, text);
  assert.equal(sent.res.status, 303);
  assert.equal(sent.res.location, '/?sent=1#reply');
  assert.ok((await inbox()).some((r) => r.body === text), '回覆應該在站主的收件匣裡');

  // 另一位訪客（B）與送出的人自己（A）的頁面上都沒有這則回覆
  for (const [name, client] of [['B', b], ['A', a]]) {
    for (const url of ['/', '/?sent=1']) {
      const page = await client.get(url);
      assert.ok(isRoom(page));
      assert.ok(!page.text.includes('REPLY-FROM-A-3b1f'), `${name} 的頁面不應該出現回覆內容`);
    }
  }
  // 訪客端沒有任何讀取、修改、刪除回覆或管理用的網址
  const replyId = (await inbox()).find((r) => r.body === text).id;
  for (const url of ['/replies', '/reply', '/inbox', '/export.json', '/api/replies', `/replies/${replyId}`, '/admin', '/access', '/content', '/photos', '/audit']) {
    const res = await b.get(url);
    assert.equal(res.status, 404, url);
    assert.ok(!res.text.includes('REPLY-FROM-A-3b1f'));
  }
  const form = await visitorForm(b);
  for (const url of [`/replies/${replyId}/delete`, '/content', '/access/generate', '/access/revoke', '/photos', `/photos/${photos[0].id}/delete`]) {
    const res = await b.post(url, { csrf: form.csrf, body: 'x', title_ja: 'hacked' });
    assert.equal(res.status, 404, 'POST ' + url);
  }
  // 拿訪客的登入 cookie 去敲管理端：全部 403
  const cookieHeader = b.cookieHeader();
  const onAdmin = new Client(stack.adminUrl);
  for (const url of ['/', '/export.json', '/photos', '/access', `/photo/${photos[0].id}/full`]) {
    assert.equal((await onAdmin.get(url, { headers: { Cookie: cookieHeader } })).status, 403, url);
  }
  assert.equal((await onAdmin.post(`/replies/${replyId}/delete`, { csrf: form.csrf }, { headers: { Cookie: cookieHeader } })).status, 403);
  // 回覆與標題都沒有被動到
  assert.ok((await inbox()).some((r) => r.id === replyId && r.body === text));
  assert.ok(isRoom(await a.get('/')));
});

/* ================================================================================================
   驗收 4：登出、登入過期或撤銷工作階段後，舊登入狀態失效
   ================================================================================================ */

test('驗收 4-1：登出後，就算把舊的 cookie 原封不動送回來也沒有用', async () => {
  const client = await newVisitor();
  const old = client.cookieHeader();
  // 防偽造編號不對的登出請求不會生效
  assert.equal((await client.post('/logout', { csrf: 'f'.repeat(64) })).status, 403);
  assert.ok(isRoom(await client.get('/')));

  const form = await visitorForm(client);
  const out = await client.post('/logout', { csrf: form.csrf });
  assert.equal(out.status, 303);
  assert.equal(out.location, '/?out=1');
  assert.ok(out.setCookie.some((c) => c.startsWith('__Host-room-session=;') && /Max-Age=0/.test(c)), '登出要清掉 cookie');
  const replay = new Client(stack.visitorUrl);
  assert.ok(isGate(await replay.get('/', { headers: { Cookie: old }, cookies: false })));
  assert.equal((await replay.get(`/photo/${photos[0].id}/full`, { headers: { Cookie: old }, cookies: false })).status, 401);
  const reply = await replay.post('/reply', { csrf: form.csrf, nonce: form.nonce, body: 'after logout' }, { headers: { Cookie: old, Accept: 'application/json' }, cookies: false });
  assert.equal(reply.status, 401);
});

test('驗收 4-2：登入過期後失效（伺服器自己判斷，不靠瀏覽器刪 cookie）', async () => {
  const client = await newVisitor(stack.shortUrl);            // 這個測試用的訪客端：登入 2 秒就過期，和其他服務共用同一個資料庫
  const cookieHeader = client.cookieHeader();
  assert.ok(client.jar.has('__Host-room-session'));
  const fresh = new Client(stack.shortUrl);
  assert.ok(isRoom(await fresh.get('/', { headers: { Cookie: cookieHeader }, cookies: false })));
  assert.equal((await fresh.get(`/photo/${photos[0].id}/thumb`, { headers: { Cookie: cookieHeader }, cookies: false })).status, 200);
  await sleep(3200);
  for (const base of [stack.shortUrl, stack.visitorUrl]) {
    const later = new Client(base);
    assert.ok(isGate(await later.get('/', { headers: { Cookie: cookieHeader }, cookies: false })), '過期後應該回到登入表單');
    assert.equal((await later.get(`/photo/${photos[0].id}/thumb`, { headers: { Cookie: cookieHeader }, cookies: false })).status, 401);
  }
});

test('驗收 4-3：站主「撤銷所有登入」後，已登入的訪客立刻失效；密碼不變，可以重新登入', async () => {
  const one = await newVisitor();
  const two = await newVisitor();
  assert.ok(isRoom(await one.get('/')) && isRoom(await two.get('/')));
  const res = await admin.post('/access/revoke', { csrf: await adminCsrf(admin) });
  assert.equal(res.status, 303);
  for (const client of [one, two]) {
    const cookieHeader = client.cookieHeader();
    assert.ok(isGate(await new Client(stack.visitorUrl).get('/', { headers: { Cookie: cookieHeader }, cookies: false })));
    assert.equal((await new Client(stack.visitorUrl).get(`/photo/${photos[1].id}/full`, { headers: { Cookie: cookieHeader }, cookies: false })).status, 401);
  }
  assert.ok(isRoom(await (await newVisitor()).get('/')), '同一組密碼可以重新登入');
});

test('驗收 4-4：更換密碼後，舊密碼與舊的登入狀態都失效', async () => {
  await unlockLogin();
  const oldPassword = password;
  const client = await newVisitor();
  const cookieHeader = client.cookieHeader();

  // 沒有「自己設定密碼」的入口：以前的 /access/set 不存在，送什麼都不會改到密碼
  const staleForm = await accessForm(admin);
  for (const attempt of ['welcomeeverybodyhere', 'Tsukimi Dango 4 Kumo no Ue', 'ayaka0620']) {
    const res = await admin.post('/access/set', { ...staleForm, password: attempt });
    assert.equal(res.status, 404, attempt);
    assert.equal((await visitorLogin(new Client(stack.visitorUrl), attempt)).status, 401, attempt);
  }
  const accessPage = await admin.get('/access');
  assert.ok(!/name="password"|access\/set/.test(accessPage.text), '管理頁上沒有輸入密碼的欄位');
  assert.ok(isRoom(await client.get('/')), '原本的密碼與登入繼續有效');
  await unlockLogin();

  password = await generateVisitorPassword(admin);
  secretsSeen.passwords.push(password);
  assert.notEqual(password, oldPassword);
  assert.ok(isGate(await new Client(stack.visitorUrl).get('/', { headers: { Cookie: cookieHeader }, cookies: false })), '舊的登入狀態應該失效');
  assert.equal((await new Client(stack.visitorUrl).get(`/photo/${photos[0].id}/full`, { headers: { Cookie: cookieHeader }, cookies: false })).status, 401);
  assert.equal((await visitorLogin(new Client(stack.visitorUrl), oldPassword)).status, 401, '舊密碼不能再登入');
  const again = await newVisitor();
  assert.ok(isRoom(await again.get('/')));

  // 產生的密碼是 8 組十六進位字（128 bit）；貼上時大小寫、空白、連字號不同也可以
  assert.match(password, /^([0-9a-f]{4}-){7}[0-9a-f]{4}$/);
  for (const variant of [password.toUpperCase(), ` ${password.replace(/-/g, ' ')} `, password.replace(/-/g, ''), `「${password}」。`]) {
    assert.equal((await visitorLogin(new Client(stack.visitorUrl), variant)).status, 303, JSON.stringify(variant));
  }
  // 少一個字、多一個字、最後一個字不同，都不行
  for (const near of [password.slice(0, -1), password + '0', password.slice(0, -1) + (password.endsWith('0') ? '1' : '0')]) {
    assert.equal((await visitorLogin(new Client(stack.visitorUrl), near)).status, 401);
  }
  await unlockLogin();

  // 同一份換密碼的表單再送一次（重新整理頁面、舊分頁、連按兩下）：不會再換，剛剛那一組繼續有效
  const replayed = await admin.post('/access/generate', staleForm);
  assert.equal(replayed.status, 409);
  assert.ok(!replayed.text.includes('data-new-password') && replayed.text.includes('沒有</strong>再更換'));
  assert.ok(isRoom(await again.get('/')));
  // 同時送出兩次「產生新密碼」（連按兩下、兩個分頁）：只有一次生效，畫面上也只會出現一組密碼
  const sameForm = await accessForm(admin);
  const twice = await Promise.all([admin.post('/access/generate', sameForm), admin.post('/access/generate', sameForm)]);
  assert.deepEqual(twice.map((r) => r.status).sort(), [200, 409]);
  const shown = twice.map((r) => (/data-new-password>([^<]+)</.exec(r.text) || [])[1]).filter(Boolean);
  assert.equal(shown.length, 1);
  assert.equal((await visitorLogin(new Client(stack.visitorUrl), secretsSeen.passwords.at(-1))).status, 401, '前一組已經失效');
  assert.equal((await visitorLogin(new Client(stack.visitorUrl), shown[0])).status, 303, '畫面上顯示的那一組有效');
  password = shown[0];
  secretsSeen.passwords.push(shown[0]);
  await unlockLogin();
});

test('資料庫裡就算被放進「一般長句」的雜湊，也沒有人能用那句話登入（登入只受理邀請密碼的格式）', async () => {
  await unlockLogin();
  const sentence = 'welcomeeverybodyhere';
  // 直接改資料庫，模擬「不知道怎麼來的弱密碼雜湊」（管理頁已經沒有任何入口能做到這件事）
  const planted = await hashPassword(stack.secrets.PEPPER, sentence);
  await stack.sql(`UPDATE settings SET value = '${planted}' WHERE key = 'visitor_password_hash'`);
  assert.equal((await stack.sql("SELECT value FROM settings WHERE key = 'visitor_password_hash'"))[0].value, planted);
  for (const attempt of [sentence, 'Welcome Everybody Here', ' welcome-everybody-here ']) {
    const res = await visitorLogin(new Client(stack.visitorUrl), attempt);
    assert.equal(res.status, 401, attempt);
    assert.ok(isGate(res));
  }
  // 換回正常產生的密碼
  password = await generateVisitorPassword(admin);
  secretsSeen.passwords.push(password);
  await unlockLogin();
  assert.ok(isRoom(await (await newVisitor()).get('/')));
});

test('超過大小上限的內容：沒有 Content-Length 的分塊上傳，伺服器讀到上限就回 413，不會等對方送完', async () => {
  const form = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const token = await stack.access.sign({ lifetime: 600 });
  secretsSeen.adminTokens.push(token);
  const adminHeaders = { 'Cf-Access-Jwt-Assertion': token };
  // [說明, 網址, 標頭, 每一塊的大小, 上限（位元組）]。每個請求最多準備送 200 塊（遠超過上限）
  const cases = [
    ['訪客登入', stack.visitorUrl + '/login', form, 8 * 1024, 32 * 1024],
    ['訪客登出', stack.visitorUrl + '/logout', form, 4 * 1024, 4096],
    ['訪客回覆', stack.visitorUrl + '/reply', form, 8 * 1024, 32 * 1024],
    ['管理端的表單', stack.adminUrl + '/content', { ...form, ...adminHeaders }, 16 * 1024, 64 * 1024],
    ['管理端的照片上傳', stack.adminUrl + '/photos', { 'Content-Type': 'multipart/form-data; boundary=test', ...adminHeaders }, 256 * 1024, 4 * 1024 * 1024 + 600 * 1024 + 64 * 1024],
  ];
  for (const [name, url, headers, chunkBytes, limit] of cases) {
    const result = await streamPost(url, { headers, chunkBytes, maxChunks: 200 });
    assert.equal(result.status, 413, name);
    assert.equal(result.body, 'too-large', name);
    assert.equal(result.completed, false, `${name}：內容還沒送完，伺服器就已經拒絕`);
    const needed = Math.floor(limit / chunkBytes) + 1;                 // 送到第幾塊會超過上限
    assert.ok(result.chunksSent >= needed && result.chunksSent <= needed + 20, `${name}：送了 ${result.chunksSent} 塊（第 ${needed} 塊超過上限，總共準備了 200 塊）`);
  }
  // Content-Length 已經超過上限的，直接拒絕
  for (const [url, headers] of [[stack.visitorUrl + '/login', {}], [stack.adminUrl + '/photos', { ...adminHeaders, 'Content-Type': 'multipart/form-data; boundary=test' }]]) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: new URL(url).origin, ...headers }, body: 'a='.padEnd(6 * 1024 * 1024, 'x') });
    assert.equal(res.status, 413, url);
    await res.arrayBuffer();
  }
  // 上限以內的照常處理（沒有被這些被拒絕的請求影響）
  assert.ok(isRoom(await (await newVisitor()).get('/')));
  noPrivate((await streamPost(stack.visitorUrl + '/reply', { headers: form, chunkBytes: 8 * 1024 })).body, '413 的回應');
});

/* ================================================================================================
   驗收 5：一位已登入訪客看過照片後，未登入者仍不能從快取取得同一張照片
   ================================================================================================ */

test('驗收 5：照片只給登入的人，回應標明不可快取；同一個網址沒登入就是 401', async () => {
  const client = await newVisitor();
  for (const photo of photos) {
    for (const size of ['thumb', 'full']) {
      const url = `/photo/${photo.id}/${size}`;
      const ok = await client.get(url);
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get('content-type'), 'image/jpeg');
      assert.equal(ok.headers.get('cache-control'), 'private, no-store');
      assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(ok.headers.get('cross-origin-resource-policy'), 'same-origin');
      assert.equal(ok.headers.get('etag'), null);
      assert.equal(ok.headers.get('last-modified'), null);
      assert.equal(ok.headers.get('set-cookie'), null);
      assert.equal(inspectJpeg(ok.buffer).ok, true);

      // 剛剛有人看過同一張；沒登入的人用各種方式要同一個網址
      const anon = new Client(stack.visitorUrl);
      for (const headers of [{}, { 'If-None-Match': '*' }, { 'If-Modified-Since': new Date(0).toUTCString() }, { Range: 'bytes=0-1023' }, { 'Cache-Control': 'only-if-cached' }, { Referer: stack.visitorUrl + '/' }]) {
        const res = await anon.get(url, { headers });
        assert.equal(res.status, 401, JSON.stringify(headers));
        assert.ok(res.buffer.length < 64);
      }
      assert.equal((await anon.get(url + '?v=1')).status, 401);
      assert.ok([401, 404].includes((await anon.get(url + '/')).status));
      assert.ok([401, 404].includes((await anon.get(url + '.jpg')).status));
    }
  }
  // 登入後的頁面本身也不可快取
  const page = await client.get('/');
  assert.equal(page.headers.get('cache-control'), 'private, no-store');
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
});

test('照片：上傳時帶著的 GPS、裝置、時間等資料不會進到儲存空間', async () => {
  const dirty = fixture('with-metadata.jpg');
  assert.ok(dirty.includes('TestPhone 99') && dirty.includes('Tokyo Tower'), '測試檔本身帶著這些資料');
  assert.deepEqual(photos[2].removed.sort(), ['Exif', 'ICC', 'XMP', 'comment', 'trailing-data'].sort());
  const client = await newVisitor();
  for (const [who, getter] of [['管理端', admin], ['訪客端', client]]) {
    for (const size of ['thumb', 'full']) {
      const res = await getter.get(`/photo/${photos[2].id}/${size}`);
      assert.equal(res.status, 200);
      assert.deepEqual(inspectJpeg(res.buffer), { ok: true, width: 600, height: 400, meta: [] }, `${who} ${size}`);
      for (const leak of ['Exif', 'TestPhone', 'Tokyo Tower', 'private note', 'ICC_PROFILE', 'TRAILER', '2026:11:14']) {
        assert.ok(!res.buffer.includes(leak), `${who} ${size} 不應該還有「${leak}」`);
      }
    }
  }
  // 不是 JPEG、尺寸超過上限、缺檔案、沒填說明：都不收，也不會多出照片
  const count = async () => ((await admin.get('/photos')).text.match(/class="admin__photo"/g) || []).length;
  const beforeCount = await count();
  const base = { alt_ja: 'x', alt_zh: 'x' };
  const bad = [
    [{ ...base, full: fixture('not-a-jpeg.png'), thumb: fixture('sample-1-thumb.jpg') }, 400],
    [{ ...base, full: fixture('sample-1-full.jpg'), thumb: Buffer.from('<script>alert(1)</script>') }, 400],
    [{ ...base, full: fixture('sample-1-full.jpg'), thumb: fixture('phone-like.jpg') }, 400],           // 縮圖長邊 2000 > 1200
    [{ ...base, full: fixture('cmyk.jpg'), thumb: fixture('sample-1-thumb.jpg') }, 400],                 // 四個色版（CMYK）：不收
    [{ ...base, full: fixture('sample-1-full.jpg'), thumb: fixture('sample-1-thumb.jpg').subarray(0, 4000) }, 400],   // 被截斷
    [{ ...base, full: fixture('sample-1-full.jpg') }, 400],
    [{ full: fixture('sample-1-full.jpg'), thumb: fixture('sample-1-thumb.jpg') }, 400],
    [{ ...base, full: fixture('sample-1-full.jpg'), thumb: fixture('sample-1-thumb.jpg'), csrf: 'f'.repeat(64) }, 403],
    [{ ...base, full: fixture('sample-1-full.jpg'), thumb: fixture('sample-1-thumb.jpg'), origin: 'https://evil.example' }, 403],
  ];
  for (const [options, status] of bad) {
    const { res } = await uploadPhoto(admin, options);
    assert.equal(res.status, status, res.text.slice(0, 80));
  }
  assert.equal(await count(), beforeCount);
});

test('照片：不經過瀏覽器重新編碼、直接送到伺服器的檔案也一樣被清理（JFIF 檔頭裡的縮圖、多塞的資料）', async () => {
  // 手工做一個「合法」的 JPEG：JFIF 檔頭裡帶一張 8×6 的內嵌縮圖，後面再多塞一段資料
  const clean = fixture('sample-2-thumb.jpg'), cleanFull = fixture('sample-2-full.jpg');
  const header = (thumb, extra) => {
    const body = Buffer.concat([Buffer.from('JFIF\0', 'latin1'), Buffer.from([1, 2, 1, 0, 72, 0, 72, 8, 6]), thumb, extra]);
    return Buffer.concat([Buffer.from([0xff, 0xe0, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
  };
  const thumbPixels = Buffer.alloc(8 * 6 * 3, 'EMBEDDED-THUMBNAIL-OF-THE-UNCROPPED-ORIGINAL/', 'latin1');
  const craft = (base, extra) => Buffer.concat([base.subarray(0, 2), header(thumbPixels, Buffer.from(extra, 'latin1')), base.subarray(2 + JFIF_HEADER.length)]);
  const full = craft(cleanFull, 'EXTRA-PAYLOAD-IN-JFIF-HEADER'), thumb = craft(clean, '');
  assert.deepEqual(inspectJpeg(full).meta, ['JFIF-thumbnail', 'JFIF-extra-data']);
  assert.deepEqual(inspectJpeg(thumb).meta, ['JFIF-thumbnail']);

  const { res, body } = await uploadPhoto(admin, { full, thumb, alt_ja: 'PRIVATE-ALT-9 サンプル画像', alt_zh: 'PRIVATE-ALT-9 範例圖片' });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(body.removed.sort(), ['JFIF-extra-data', 'JFIF-thumbnail']);
  const client = await newVisitor();
  for (const [who, getter] of [['管理端', admin], ['訪客端', client]]) {
    for (const [size, original] of [['thumb', clean], ['full', cleanFull]]) {
      const stored = await getter.get(`/photo/${body.id}/${size}`);
      assert.equal(stored.status, 200);
      assert.deepEqual(inspectJpeg(stored.buffer).meta, [], `${who} ${size}`);
      assert.ok(stored.buffer.equals(original), `${who} ${size}：存下來的就是沒有夾帶東西的那張圖`);
      assert.ok(stored.buffer.subarray(2, 2 + JFIF_HEADER.length).equals(Buffer.from(JFIF_HEADER)), '檔頭是固定的 18 個位元組');
      for (const leak of ['EMBEDDED-THUMBNAIL', 'EXTRA-PAYLOAD']) { assert.ok(!stored.buffer.includes(leak), `${who} ${size} 不應該還有「${leak}」`); }
    }
  }
  // 收尾：刪掉這張，不影響後面的測試
  const removed = await admin.post(`/photos/${body.id}/delete`, { csrf: await adminCsrf(admin, '/photos') });
  assert.equal(removed.status, 303);
});

test('照片：站主可以修改說明、調整順序、刪除；刪除後訪客端拿不到', async () => {
  const { body } = await uploadPhoto(admin, { full: fixture('sample-3-full.jpg'), thumb: fixture('sample-3-thumb.jpg'), alt_ja: 'PRIVATE-ALT-4 横長', alt_zh: 'PRIVATE-ALT-4 橫式', caption_ja: 'PRIVATE-CAPTION-4', caption_zh: 'PRIVATE-CAPTION-4' });
  const id = body.id;
  photos.push({ id });
  const client = await newVisitor();
  assert.ok((await client.get('/')).text.includes('PRIVATE-CAPTION-4'));
  const csrf = await adminCsrf(admin, '/photos');
  const updated = await admin.post(`/photos/${id}`, { csrf, alt_ja: 'PRIVATE-ALT-4 更新', alt_zh: 'PRIVATE-ALT-4 更新', caption_ja: 'PRIVATE-CAPTION-4 <b>更新</b>', caption_zh: '', taken_on: '2026-08-23', position: '0' });
  assert.equal(updated.status, 303);
  const page = await client.get('/');
  assert.ok(page.text.includes('PRIVATE-CAPTION-4 &lt;b&gt;更新&lt;/b&gt;'), '說明裡的 HTML 只會被當成文字');
  assert.ok(page.text.includes('2026年8月23日'));
  assert.ok(page.text.indexOf(`/photo/${id}/thumb`) < page.text.indexOf(`/photo/${photos[1].id}/thumb`), '順序改成 0 之後，排到原本第二張的前面');
  assert.equal((await client.get(`/photo/${id}/full`)).status, 200);

  const removed = await admin.post(`/photos/${id}/delete`, { csrf });
  assert.equal(removed.status, 303);
  assert.equal((await client.get(`/photo/${id}/full`)).status, 404);
  assert.equal((await client.get(`/photo/${id}/thumb`)).status, 404);
  assert.equal((await admin.get(`/photo/${id}/full`)).status, 404, '檔案已經從儲存空間移除');
  assert.ok(!(await client.get('/')).text.includes(id));
  photos = photos.filter((p) => p.id !== id);
});

/* ================================================================================================
   驗收 6：測試回覆確實出現在站主管理頁，換裝置後仍能讀取；惡意 HTML 只能當文字顯示
   ================================================================================================ */

const EVIL = `<script>alert('xss-4c7e')</script><img src=x onerror="alert(1)"> </p><a href="javascript:alert(2)">x</a> & "quotes" 'single' 彩花へ🌸`;

test('驗收 6-1：回覆存進資料庫後才顯示成功；惡意 HTML 在管理頁只是文字', async () => {
  const client = await newVisitor();
  secretsSeen.replyBodies.push(EVIL);
  const sent = await sendReply(client, EVIL, { json: true });
  assert.equal(sent.res.status, 200);
  assert.equal(sent.json.ok, true);
  assert.match(sent.json.nonce, /^[a-f0-9]{32}$/);
  assert.ok(!sent.res.text.includes('xss-4c7e'), '成功的回應裡不會把內容送回來');

  // 站主的收件匣（另一個服務、另一個用戶端，沒有任何訪客 cookie）
  const fresh = adminClient(stack, await stack.access.sign());
  const page = await fresh.get('/');
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('&lt;script&gt;alert(&#39;xss-4c7e&#39;)&lt;/script&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'), '內容經過轉換、原樣顯示成文字');
  assert.ok(!page.text.includes("<script>alert('xss-4c7e')"), '不可以有真的 <script>');
  assert.ok(!/<img src=x/i.test(page.text) && !page.text.includes('<a href="javascript:'), '不可以有真的標籤');
  assert.ok(page.text.includes('持有訪客密碼的人'), '管理頁要說明回覆的來源沒有經過身分驗證');
  assert.ok(!/已驗證的彩花|本人確認済|verified/i.test(page.text.replace('請不要把它當成已驗證身分的訊息', '')));
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);

  // 匯出檔裡是原本的文字，而且是以附件的形式下載、不會被當成網頁
  const exported = await fresh.get('/export.json');
  assert.equal(exported.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.match(exported.headers.get('content-disposition'), /^attachment; filename="replies-\d{8}\.json"$/);
  assert.equal(exported.headers.get('x-content-type-options'), 'nosniff');
  const stored = JSON.parse(exported.text).replies.filter((r) => r.body === EVIL);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].lang, 'ja');
  assert.match(stored[0].session_ref, /^[a-f0-9]{12}$/);
});

test('驗收 6-2：同一則回覆（同一個送出編號、同樣的內容）重送不會存成兩筆；改了內容再送，兩個版本都會留下', async () => {
  const client = await newVisitor();
  const form = await visitorForm(client);
  const text = 'IDEMPOTENT-8a2d 同じ内容を二回送っても一件だけ';
  secretsSeen.replyBodies.push(text);
  const first = await sendReply(client, text, { form });
  const second = await sendReply(client, text, { form });                       // 重新整理、或第一次的回應在路上斷了之後再按一次
  assert.deepEqual([first.res.status, second.res.status], [303, 303]);
  assert.equal((await inbox()).filter((r) => r.body === text).length, 1);

  // 同時按了兩次
  const form2 = await visitorForm(client);
  const twin = 'IDEMPOTENT-TWIN-19e0 同時に二回';
  secretsSeen.replyBodies.push(twin);
  const results = await Promise.all([sendReply(client, twin, { form: form2 }), sendReply(client, twin, { form: form2 })]);
  assert.ok(results.every((r) => r.res.status === 303));
  assert.equal((await inbox()).filter((r) => r.body === twin).length, 1);

  // 第一次其實有存進去，訪客以為失敗、改了幾個字再送：新的內容也要存下來，不可以只回報成功
  const edited = text + '（書き直し）';
  secretsSeen.replyBodies.push(edited);
  const third = await sendReply(client, edited, { form });
  assert.equal(third.res.status, 303);
  const all = await inbox();
  assert.equal(all.filter((r) => r.body === text).length, 1);
  assert.equal(all.filter((r) => r.body === edited).length, 1);
});

test('驗收 6-3：送出失敗時不會顯示成功，而且寫好的內容會留在畫面上', async () => {
  const client = await newVisitor();
  const count = (await inbox()).length;
  const form = await visitorForm(client);

  // 太長（上限 2000 個字，表情符號算一個字）
  const ok2000 = '🌸'.repeat(2000);
  const tooLong = 'あ'.repeat(2001) + '<b>tail</b>';
  const long = await sendReply(client, tooLong, { form });
  assert.equal(long.res.status, 400);
  assert.ok(long.res.text.includes('2000文字以内'), '要有清楚的提示');
  assert.ok(long.res.text.includes('あ'.repeat(2001) + '&lt;b&gt;tail&lt;/b&gt;</textarea>'), '剛剛寫的內容留在輸入欄（而且是純文字）');
  assert.equal(field(long.res.text, 'nonce'), form.nonce, '沿用同一個送出編號');
  assert.ok(!replyStatus(long.res.text).includes('送信しました'), '狀態列沒有顯示送出成功');

  // 空白、防偽造編號不對、送出編號不對
  const empty = await sendReply(client, '   \n  ', { form });
  assert.equal(empty.res.status, 400);
  const badCsrf = await sendReply(client, 'KEEP-ME-71aa 内容は残る', { form, csrf: 'e'.repeat(64) });
  assert.equal(badCsrf.res.status, 403);
  assert.ok(badCsrf.res.text.includes('KEEP-ME-71aa 内容は残る</textarea>'));
  assert.equal(field(badCsrf.res.text, 'nonce'), form.nonce, '防偽造編號不對時，放回頁面的仍是同一個送出編號');
  const badNonce = await sendReply(client, 'KEEP-ME-71ab', { form, nonce: 'not-a-nonce"><script>alert(7)</script>' });
  assert.equal(badNonce.res.status, 400);
  assert.match(field(badNonce.res.text, 'nonce'), /^[a-f0-9]{32}$/, '格式不對的送出編號不會被放回頁面，換成新的');
  assert.ok(!badNonce.res.text.includes('not-a-nonce') && !badNonce.res.text.includes('<script>alert(7)'));
  const apiFail = await sendReply(client, tooLong, { form, json: true });
  assert.equal(apiFail.res.status, 400);
  assert.deepEqual([apiFail.json.ok, apiFail.json.code], [false, 'replyTooLong']);
  // 超過大小上限的請求
  const huge = await client.post('/reply', { csrf: form.csrf, nonce: form.nonce, body: 'x'.repeat(40000) });
  assert.equal(huge.status, 413);
  // 不是一般表單
  const asJson = await client.request('/reply', { method: 'POST', body: JSON.stringify({ csrf: form.csrf, nonce: form.nonce, body: 'json body' }), headers: { 'Content-Type': 'application/json' } });
  assert.equal(asJson.status, 415);
  assert.equal((await inbox()).length, count, '失敗的都沒有被存下來');

  // 剛好 2000 個字可以送；登入過期後送出：不存，內容放回畫面讓對方複製
  secretsSeen.replyBodies.push(ok2000.slice(0, 48));
  assert.equal((await sendReply(client, ok2000, { form })).res.status, 303);
  assert.equal((await inbox()).filter((r) => r.body === ok2000).length, 1);

  const expiring = await newVisitor();
  const expForm = await visitorForm(expiring);
  await expiring.post('/logout', { csrf: expForm.csrf });
  const stale = new Client(stack.visitorUrl);
  const draft = 'DRAFT-c0de <i>下書き</i> まだ送れていない内容';
  const late = await stale.post('/reply', { csrf: expForm.csrf, nonce: expForm.nonce, body: draft }, { headers: { Cookie: `__Host-room-session=${secretsSeen.sessionTokens.at(-1)}` }, cookies: false });
  assert.equal(late.status, 401);
  assert.ok(isGate(late));
  assert.ok(late.text.includes('DRAFT-c0de &lt;i&gt;下書き&lt;/i&gt; まだ送れていない内容</textarea>'), '還沒送出的內容放回畫面（純文字、唯讀）');
  noPrivate(late.text.replace(draft, ''), '登入過期的回應');
  assert.ok(!(await inbox()).some((r) => r.body.includes('DRAFT-c0de')));
});

test('登入過期時寫到一半的回覆不會丟（沒有腳本）：內容跟著登入表單走，登入成功後回到回覆的輸入欄；伺服器不存草稿', async () => {
  await unlockLogin();
  const visitor = await newVisitor();
  const form = await visitorForm(visitor);
  const token = visitor.jar.get('__Host-room-session');
  await visitor.post('/logout', { csrf: form.csrf });            // 讓這一次登入失效（過期、被撤銷、換密碼走的是同一條路）
  const draft = 'DRAFT-7e11 </textarea><script>alert(1)</script> 途中まで書いた内容\n二行目 🌸';
  const escaped = 'DRAFT-7e11 &lt;/textarea&gt;&lt;script&gt;alert(1)&lt;/script&gt; 途中まで書いた内容\n二行目 🌸</textarea>';
  secretsSeen.replyBodies.push(draft.slice(0, 10));

  // 1. 送出時才發現登入已經失效：不存，回到登入頁；草稿放在登入表單裡（唯讀、純文字）
  const browser = new Client(stack.visitorUrl);
  browser.jar.set('__Host-room-session', token);
  const late = await browser.post('/reply', { csrf: form.csrf, nonce: form.nonce, body: draft });
  assert.equal(late.status, 401);
  assert.ok(isGate(late));
  assert.match(late.text, /<form class="room__form" method="post" action="\/login"[^>]*>[\s\S]*<textarea [^>]*name="draft"[^>]*readonly>[\s\S]*<\/textarea>\s*<\/form>/, '草稿在登入表單裡面');
  assert.match(late.text, /<form class="room__form" method="post" action="\/login"[^>]*>[\s\S]*<input type="hidden" name="nonce" value="[a-f0-9]{32}">[\s\S]*<\/form>/, '草稿的送出編號也在登入表單裡面');
  assert.equal(field(late.text, 'nonce'), form.nonce, '而且就是原本那一則的送出編號');
  assert.ok(late.text.includes(escaped) && !late.text.includes('<script>alert(1)'), '草稿只會被當成文字');
  assert.match(gateStatus(late.text), /送信できたかどうか確認できていません。入力した内容は下に残っています。.*送信を続けられます。$/, '說明：無法確認有沒有送出、內容留著、可以繼續送出');
  assert.ok(late.text.includes('<label class="room__label" for="room-draft">送信を確認できていないメッセージ</label>'), '草稿的標籤');
  assert.doesNotMatch(late.text, SAYS_NOT_SENT, '登入頁上不斷定「還沒送出」');
  noPrivate(late.text.replace(escaped, ''), '登入過期的回應');
  // 草稿沒有被存進任何資料表
  for (const table of ['replies', 'settings', 'sessions', 'audit', 'rate_limits', 'photos']) {
    assert.ok(!JSON.stringify(await stack.sql(`SELECT * FROM ${table}`)).includes('DRAFT-7e11'), `${table} 裡不應該有草稿`);
  }

  // 2. 合言葉打錯：草稿還在
  const wrong = await browser.post('/login', { csrf: field(late.text, 'csrf'), password: 'ffff-ffff-ffff-ffff-ffff-ffff-ffff-ffff', nonce: field(late.text, 'nonce'), draft });
  assert.equal(wrong.status, 401);
  assert.ok(isGate(wrong) && wrong.text.includes(escaped) && wrong.text.includes('合言葉が違うようです'));
  assert.equal(field(wrong.text, 'nonce'), form.nonce, '合言葉打錯之後，送出編號還在');

  // 3. 合言葉正確：直接回到專區，草稿在回覆的輸入欄裡，而且還沒有送出
  const back = await browser.post('/login', { csrf: field(wrong.text, 'csrf'), password, nonce: field(wrong.text, 'nonce'), draft });
  assert.equal(back.status, 200);
  assert.ok(isRoom(back));
  assert.equal(field(back.text, 'nonce'), form.nonce, '回到專區後，回覆表單裡是原本那一則的送出編號');
  assert.notEqual(field(back.text, 'csrf'), form.csrf, '防偽造編號則是新登入的');
  secretsSeen.sessionTokens.push(browser.jar.get('__Host-room-session'));
  assert.match(back.text, /<textarea class="reply__input" id="reply-body" name="body"[^>]*>DRAFT-7e11 /);
  assert.ok(back.text.includes(escaped) && !back.text.includes('<script>alert(1)'));
  assert.equal(replyStatus(back.text), 'ログインし直しました。メッセージを送信できたかどうかは、まだ確認できていません。内容はそのまま残っています。「送信する」を押すと、送信を続けられます。');
  assert.equal(back.headers.get('cache-control'), 'private, no-store');
  assert.ok(!(await inbox()).some((r) => r.body.includes('DRAFT-7e11')), '回到頁面不等於送出');

  // 4. 按送出：存下來的就是原本寫的內容，只有一筆
  const sent = await browser.post('/reply', { csrf: field(back.text, 'csrf'), nonce: field(back.text, 'nonce'), body: draft });
  assert.equal(sent.status, 303);
  assert.equal((await inbox()).filter((r) => r.body === draft).length, 1);

  // 草稿太長（超過回覆的上限）時只帶回上限以內的部分；登入表單本身也有大小上限
  const other = new Client(stack.visitorUrl);
  const page = await other.get('/');
  const long = await other.post('/login', { csrf: field(page.text, 'csrf'), password, draft: 'あ'.repeat(2500) });
  assert.equal(long.status, 200);
  assert.ok(long.text.includes('あ'.repeat(2000) + '</textarea>') && !long.text.includes('あ'.repeat(2001)));
  assert.match(field(long.text, 'nonce'), /^[a-f0-9]{32}$/, '草稿沒有帶送出編號時，發一個新的');
  secretsSeen.sessionTokens.push(other.jar.get('__Host-room-session'));
  // 草稿帶著格式不對的送出編號：不會被放進頁面，換成新的；沒有草稿時，送出編號不會被帶著走
  const odd = new Client(stack.visitorUrl);
  const oddGate = await odd.get('/');
  const crafted = '"><script>alert(8)</script>';
  const oddWrong = await odd.post('/login', { csrf: field(oddGate.text, 'csrf'), password: 'ffff-ffff-ffff-ffff-ffff-ffff-ffff-fff0', nonce: crafted, draft: 'DRAFT-odd' });
  assert.equal(oddWrong.status, 401);
  assert.ok(!oddWrong.text.includes('alert(8)') && field(oddWrong.text, 'nonce') === null, '格式不對的送出編號不會出現在登入頁');
  const oddBack = await odd.post('/login', { csrf: field(oddWrong.text, 'csrf'), password, nonce: crafted, draft: 'DRAFT-odd' });
  assert.equal(oddBack.status, 200);
  assert.match(field(oddBack.text, 'nonce'), /^[a-f0-9]{32}$/);
  assert.ok(!oddBack.text.includes('alert(8)'));
  secretsSeen.sessionTokens.push(odd.jar.get('__Host-room-session'));
  const bare = new Client(stack.visitorUrl);
  const bareGate = await bare.get('/');
  const bareWrong = await bare.post('/login', { csrf: field(bareGate.text, 'csrf'), password: 'ffff-ffff-ffff-ffff-ffff-ffff-ffff-fff1', nonce: 'a'.repeat(32) });
  assert.equal(bareWrong.status, 401);
  assert.equal(field(bareWrong.text, 'nonce'), null, '沒有草稿就沒有東西要帶');
  const huge = await new Client(stack.visitorUrl).post('/login', { csrf: 'x', password: 'x', draft: 'x'.repeat(40000) });
  assert.equal(huge.status, 413);
  await unlockLogin();
});

test('登入過期時寫到一半的回覆不會丟（有腳本）：不離開頁面重新登入，換上新的防偽造編號後照樣送出（送出編號不變）', async () => {
  await unlockLogin();
  const accept = { headers: { Accept: 'application/json' } };
  const page = await newVisitor();                                 // 這個 Client 就是「還開著的那一頁」
  const form = await visitorForm(page);
  const firstToken = page.jar.get('__Host-room-session');
  await new Client(stack.visitorUrl).post('/logout', { csrf: form.csrf }, { headers: { Cookie: `__Host-room-session=${firstToken}` }, cookies: false });
  const draft = 'DRAFT-5a2f このページのまま送り直す内容';
  secretsSeen.replyBodies.push(draft.slice(0, 10));

  // 1. 送出 → 401，原因是登入過期；什麼都沒有存
  const late = await page.post('/reply', { csrf: form.csrf, nonce: form.nonce, body: draft }, accept);
  assert.equal(late.status, 401);
  assert.deepEqual([JSON.parse(late.text).ok, JSON.parse(late.text).code], [false, 'session']);
  assert.match(JSON.parse(late.text).message, /送信できたかどうか確認できていません。入力した内容はそのまま残っています。ログインし直すと、送信を続けられます。$/);
  assert.doesNotMatch(JSON.parse(late.text).message, SAYS_NOT_SENT);
  assert.ok(!late.text.includes('DRAFT-5a2f'), '回應裡不需要把內容再傳回來（它還在頁面的輸入欄裡）');

  // 2. 頁面向伺服器要登入表單用的編號。沒登入的人拿到的只有這個編號，沒有任何私人內容
  const info = await page.get('/session');
  assert.equal(info.status, 200);
  const session = JSON.parse(info.text);
  assert.deepEqual([session.signedIn, session.reply], [false, null]);
  assert.match(session.csrf, /^[a-f0-9]{32}$/);
  assert.equal(info.headers.get('cache-control'), 'private, no-store');
  assert.equal(info.headers.get('access-control-allow-origin'), null, '別的網站讀不到這個回應');
  assert.equal(info.headers.get('cross-origin-resource-policy'), 'same-origin');
  noPrivate(info.text, '/session');

  // 3. 合言葉打錯 → 401 與說明；打對 → 新的登入、新的防偽造編號（回應裡沒有送出編號：那不是登入該換的東西）
  const wrong = await page.post('/login', { csrf: session.csrf, password: 'ffff-ffff-ffff-ffff-ffff-ffff-ffff-ffff' }, accept);
  assert.equal(wrong.status, 401);
  assert.deepEqual([JSON.parse(wrong.text).ok, JSON.parse(wrong.text).code], [false, 'errWrong']);
  assert.ok(JSON.parse(wrong.text).message.includes('合言葉が違うようです'));
  assert.equal((await page.post('/login', { csrf: 'f'.repeat(32), password }, accept)).status, 403, '防偽造編號不對的登入不受理');
  const again = await page.post('/login', { csrf: session.csrf, password }, accept);
  assert.equal(again.status, 200);
  const fresh = JSON.parse(again.text);
  assert.equal(fresh.ok, true);
  assert.match(fresh.csrf, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(fresh).sort(), ['csrf', 'message', 'ok'], '重新登入的回應只有新的防偽造編號，沒有送出編號');
  assert.notEqual(fresh.csrf, form.csrf);
  assert.notEqual(page.jar.get('__Host-room-session'), firstToken);
  secretsSeen.sessionTokens.push(page.jar.get('__Host-room-session'));
  assert.ok(!again.text.includes(password) && !again.text.includes(page.jar.get('__Host-room-session')), '回應裡沒有密碼，也沒有登入憑證');
  noPrivate(again.text, '重新登入的回應');

  // 4. 用新的防偽造編號、原本的送出編號送出剛剛那份內容：存進去，只有一筆
  const sent = await page.post('/reply', { csrf: fresh.csrf, nonce: form.nonce, body: draft }, accept);
  assert.equal(sent.status, 200);
  assert.equal(JSON.parse(sent.text).ok, true);
  assert.equal((await inbox()).filter((r) => r.body === draft).length, 1);
  const next = JSON.parse(sent.text).nonce;                        // 伺服器確認存好之後，才給下一則的送出編號
  assert.match(next, /^[a-f0-9]{32}$/);
  assert.notEqual(next, form.nonce);

  // 5. 頁面上的防偽造編號過期（例如在另一個分頁重新登入過）：送出會被拒絕，但向 /session 要到的新編號可以用。
  //    /session 只給防偽造編號，不發送出編號
  const staleCsrf = await page.post('/reply', { csrf: form.csrf, nonce: next, body: draft + ' 2' }, accept);
  assert.equal(staleCsrf.status, 403);
  assert.equal(JSON.parse(staleCsrf.text).code, 'errExpired');
  // 說明用回覆專用的那一句（code 不變）：無法確認有沒有送出、內容留著、再按一次
  assert.match(JSON.parse(staleCsrf.text).message, /送信できたかどうか確認できませんでした。入力した内容はそのまま残っています。もう一度「送信する」を押してください。$/);
  const now = JSON.parse((await page.get('/session')).text);
  assert.equal(now.signedIn, true);
  assert.deepEqual(now.reply, { csrf: fresh.csrf });
  const resent = await page.post('/reply', { csrf: now.reply.csrf, nonce: next, body: draft + ' 2' }, accept);
  assert.equal(JSON.parse(resent.text).ok, true);
  assert.equal((await inbox()).filter((r) => r.body === draft + ' 2').length, 1);

  // 用腳本登入和用表單登入算在同一個限速裡
  const attacker = new Client(stack.visitorUrl);
  const gate = JSON.parse((await attacker.get('/session')).text);
  const statuses = [];
  for (let i = 0; i < 7; i++) { statuses.push((await attacker.post('/login', { csrf: gate.csrf, password: `0000-0000-0000-0000-0000-0000-0000-000${i}` }, accept)).status); }
  assert.deepEqual(statuses.slice(-2), [429, 429], JSON.stringify(statuses));
  await unlockLogin();
});

/* ------------------------------------------------------------------------------------------------
   跨登入的去重：回覆其實已經存好，只是成功的回應沒有送到頁面。之後不管登入怎麼變，再送同一則都只有一筆。
   「同一則」由回覆表單裡的送出編號（nonce）＋內容決定，和登入無關；防偽造編號則跟著登入換新。
   ------------------------------------------------------------------------------------------------ */

const replyCopies = async (body) => (await inbox()).filter((r) => r.body === body).length;
const sendJson = async (client, csrf, nonce, body) => {
  const res = await client.post('/reply', { csrf, nonce, body }, { headers: { Accept: 'application/json' } });
  return { status: res.status, data: JSON.parse(res.text) };
};

test('已寫入但成功的回應沒有送到 → 登入失效 → 重新登入後再送同一則：仍然只有一筆（有腳本的頁面）；開始下一則時，同樣的文字可以再送', async () => {
  await unlockLogin();
  /** 頁面上重新登入（和 room.js 一樣：向 /session 要登入用的編號，再送出合言葉）。回傳登入回應的內容（裡面有新的防偽造編號） */
  const relogin = async (page) => {
    const info = JSON.parse((await page.get('/session')).text);
    assert.deepEqual([info.signedIn, info.reply], [false, null]);
    const res = await page.post('/login', { csrf: info.csrf, password }, { headers: { Accept: 'application/json' } });
    assert.equal(res.status, 200);
    secretsSeen.sessionTokens.push(page.jar.get('__Host-room-session'));
    return JSON.parse(res.text);
  };
  // 登入失效的四種原因。對「是不是同一次送出」的判斷來說，它們不應該有任何差別
  const cases = [
    ['ttl', '登入的期限到了', async () => { await sleep(3200); }],
    ['logout', '在別的地方登出', async (page, form) => {
      const res = await new Client(stack.visitorUrl).post('/logout', { csrf: form.csrf }, { headers: { Cookie: `__Host-room-session=${page.jar.get('__Host-room-session')}` }, cookies: false });
      assert.equal(res.status, 303);
    }],
    ['revoke', '站主撤銷所有登入', async () => { assert.equal((await admin.post('/access/revoke', { csrf: await adminCsrf(admin) })).status, 303); }],
    ['rotate', '站主換了密碼', async () => { password = await generateVisitorPassword(admin); secretsSeen.passwords.push(password); }],
  ];
  for (const [tag, name, invalidate] of cases) {
    const page = new Client(stack.visitorUrl);                 // 這個 Client 就是「還開著的那一頁」
    if (tag === 'ttl') {
      // 用「登入 2 秒就過期」的訪客端登入（和其他服務共用同一個資料庫），把 cookie 帶到一般的訪客端：這一次登入真的會自己過期。
      // 期限以整秒計算，所以等到下一秒剛開始才登入，讓這一次登入有接近完整的 2 秒可以用（下面要在過期前送出兩次）
      await sleep(1000 - (Date.now() % 1000) + 30);
      const quick = await newVisitor(stack.shortUrl);
      page.jar.set('__Host-room-session', quick.jar.get('__Host-room-session'));
    } else {
      assert.equal((await visitorLogin(page, password)).status, 303, name);
      secretsSeen.sessionTokens.push(page.jar.get('__Host-room-session'));
    }
    const form = await visitorForm(page);
    assert.match(form.nonce || '', /^[a-f0-9]{32}$/, name);
    const text = `DEDUPE-${tag}-3f1a 保存はされたが、成功の返事が届かなかった返信`;
    secretsSeen.replyBodies.push(text);

    // 1. 第一次送出：伺服器存好了。假設這個成功的回應沒有送到頁面（所以頁面不知道下一個送出編號，也沒有清空輸入欄）
    const first = await sendJson(page, form.csrf, form.nonce, text);
    assert.deepEqual([first.status, first.data.ok], [200, true], name);
    // 2. 原本的登入還有效時重試：仍然只有一筆
    const retry = await sendJson(page, form.csrf, form.nonce, text);
    assert.deepEqual([retry.status, retry.data.ok], [200, true], name);
    assert.equal(await replyCopies(text), 1, `${name}：原登入下重試`);
    // 3. 登入失效之後再送：被擋下，原因是登入
    await invalidate(page, form);
    const late = await sendJson(page, form.csrf, form.nonce, text);
    assert.deepEqual([late.status, late.data.ok, late.data.code], [401, false, 'session'], name);
    // 4. 在頁面上重新登入：防偽造編號是新的，送出編號還是頁面上原本那一個
    const signedIn = await relogin(page);
    const csrf = signedIn.csrf;
    assert.notEqual(csrf, form.csrf, name);
    // 5. 權限仍然先檢查：就算這一則其實已經存過，沒登入、或防偽造編號不對的請求也不會被回報成功
    const anonymous = await sendJson(new Client(stack.visitorUrl), csrf, form.nonce, text);
    assert.deepEqual([anonymous.status, anonymous.data.ok], [401, false], `${name}：沒登入`);
    const oldCsrf = await sendJson(page, form.csrf, form.nonce, text);
    assert.deepEqual([oldCsrf.status, oldCsrf.data.ok, oldCsrf.data.code], [403, false, 'errExpired'], `${name}：舊的防偽造編號`);
    // 6. 再送同一則（新的防偽造編號、原本的送出編號）：成功，而且資料庫仍然只有一筆
    const again = await sendJson(page, csrf, form.nonce, text);
    assert.deepEqual([again.status, again.data.ok], [200, true], name);
    assert.equal(await replyCopies(text), 1, `${name}：重新登入後再送，不可以變成兩筆`);
    assert.equal('nonce' in signedIn, false, `${name}：重新登入的回應不發新的送出編號`);
    // 7. 伺服器確認存好之後，頁面才拿到下一則的送出編號：同樣的文字再送一次，是新的一則
    assert.match(again.data.nonce, /^[a-f0-9]{32}$/);
    assert.notEqual(again.data.nonce, form.nonce);
    const nextOne = await sendJson(page, csrf, again.data.nonce, text);
    assert.deepEqual([nextOne.status, nextOne.data.ok], [200, true], name);
    assert.equal(await replyCopies(text), 2, `${name}：明確開始下一則時，同樣的文字可以再送一則`);
  }
  await unlockLogin();
});

test('已寫入但成功的回應沒有送到 → 在另一個分頁重新登入過（這一頁的防偽造編號過期）→ 換上新的防偽造編號重送：仍然只有一筆', async () => {
  // 有腳本的頁面：被拒絕（403）→ 向 /session 要目前的防偽造編號 → 自動重送
  const page = await newVisitor();
  const form = await visitorForm(page);
  const text = 'DEDUPE-tab-77c1 別のタブでログインし直す前に保存されていた返信';
  secretsSeen.replyBodies.push(text);
  const first = await sendJson(page, form.csrf, form.nonce, text);                 // 存好了；成功的回應沒有送到頁面
  assert.deepEqual([first.status, first.data.ok], [200, true]);
  const otherTab = await newVisitor();                                              // 同一個瀏覽器的另一個分頁重新登入
  page.jar.set('__Host-room-session', otherTab.jar.get('__Host-room-session'));    // → 這個瀏覽器的 cookie 換成新的那一次登入
  const stale = await sendJson(page, form.csrf, form.nonce, text);
  assert.deepEqual([stale.status, stale.data.code], [403, 'errExpired']);
  const info = JSON.parse((await page.get('/session')).text);
  assert.equal(info.signedIn, true);
  assert.notEqual(info.reply.csrf, form.csrf);
  const auto = await sendJson(page, info.reply.csrf, form.nonce, text);
  assert.deepEqual([auto.status, auto.data.ok], [200, true]);
  assert.equal(await replyCopies(text), 1, '跨分頁更新防偽造編號後重送，不可以變成兩筆');
  assert.deepEqual(Object.keys(info.reply), ['csrf'], '/session 只給防偽造編號，不發新的送出編號');

  // 沒有腳本的頁面遇到同樣的情況：伺服器把「目前的防偽造編號」與「原本的送出編號」連同內容放回頁面，再按一次送出即可
  const plain = await newVisitor();
  const plainForm = await visitorForm(plain);
  const text2 = 'DEDUPE-tab-nojs-0d4e スクリプトなしで、別のタブのあとに送り直す返信';
  secretsSeen.replyBodies.push(text2);
  assert.equal((await plain.post('/reply', { csrf: plainForm.csrf, nonce: plainForm.nonce, body: text2 })).status, 303);   // 存好了；轉址的回應沒有送到
  const otherTab2 = await newVisitor();
  plain.jar.set('__Host-room-session', otherTab2.jar.get('__Host-room-session'));
  const rejected = await plain.post('/reply', { csrf: plainForm.csrf, nonce: plainForm.nonce, body: text2 });
  assert.equal(rejected.status, 403);
  assert.ok(isRoom(rejected) && rejected.text.includes(`${text2}</textarea>`), '內容留在輸入欄');
  assert.match(replyStatus(rejected.text), /送信できたかどうか確認できませんでした。入力した内容はそのまま残っています。/, '這一則其實已經存好：說明不可以斷定沒有送出');
  assert.doesNotMatch(replyStatus(rejected.text), SAYS_NOT_SENT);
  const resent = await plain.post('/reply', { csrf: field(rejected.text, 'csrf'), nonce: field(rejected.text, 'nonce'), body: text2 });
  assert.equal(resent.status, 303);
  assert.equal(await replyCopies(text2), 1, '沒有腳本：防偽造編號過期後再按一次送出，不可以變成兩筆');
  assert.equal(field(rejected.text, 'nonce'), plainForm.nonce, '放回頁面的送出編號不變');
  assert.notEqual(field(rejected.text, 'csrf'), plainForm.csrf, '防偽造編號換成目前這次登入的');
});

test('已寫入但成功的回應沒有送到 → 登入失效 → 沒有腳本的頁面重新送出同一份表單、登入、再送：仍然只有一筆；之後同樣的文字可以再送一則', async () => {
  await unlockLogin();
  const browser = await newVisitor();
  const form = await visitorForm(browser);
  const text = 'DEDUPE-nojs-52b8 スクリプトなしの下書き往復\n二行目もそのまま';
  secretsSeen.replyBodies.push(text.slice(0, 24));
  // 1. 送出：伺服器存好並回了轉址，但這個回應沒有送到瀏覽器（瀏覽器還停在原本那一頁）
  assert.equal((await browser.post('/reply', { csrf: form.csrf, nonce: form.nonce, body: text })).status, 303);
  assert.equal(await replyCopies(text), 1);
  // 2. 登入失效（站主撤銷所有登入）之後，瀏覽器重新送出同一份表單：回到登入頁，草稿與它的送出編號都在登入表單裡
  assert.equal((await admin.post('/access/revoke', { csrf: await adminCsrf(admin) })).status, 303);
  const late = await browser.post('/reply', { csrf: form.csrf, nonce: form.nonce, body: text });
  assert.equal(late.status, 401);
  assert.ok(isGate(late));
  assert.equal(await replyCopies(text), 1);
  // 這一則其實已經存好：登入頁上的說明與草稿的標籤都不可以說它「還沒送出」
  assert.match(gateStatus(late.text), /送信できたかどうか確認できていません/);
  assert.ok(late.text.includes('送信を確認できていないメッセージ'));
  assert.doesNotMatch(late.text, SAYS_NOT_SENT);
  // 3. 輸入合言葉。登入表單裡有的每一欄都跟著送出，和瀏覽器一樣（包含草稿，以及頁面有放的話、草稿的送出編號）：
  //    回到專區，草稿回到回覆的表單
  const carried = field(late.text, 'nonce');
  const back = await browser.post('/login', { csrf: field(late.text, 'csrf'), password, draft: text, ...(carried ? { nonce: carried } : {}) });
  assert.equal(back.status, 200);
  assert.ok(isRoom(back));
  secretsSeen.sessionTokens.push(browser.jar.get('__Host-room-session'));
  assert.notEqual(field(back.text, 'csrf'), form.csrf);
  assert.match(replyStatus(back.text), /送信できたかどうかは、まだ確認できていません。.*送信を続けられます。$/, '回到專區後的說明也不斷定「還沒送出」');
  assert.doesNotMatch(replyStatus(back.text), SAYS_NOT_SENT);
  assert.equal(await replyCopies(text), 1, '回到頁面不等於送出');
  // 4. 再按送出（送的是頁面上回覆表單裡的欄位）：資料庫仍然只有一筆
  const sent = await browser.post('/reply', { csrf: field(back.text, 'csrf'), nonce: field(back.text, 'nonce'), body: text });
  assert.equal(sent.status, 303);
  assert.equal(sent.location, '/?sent=1#reply');
  assert.equal(await replyCopies(text), 1, '草稿往返之後再送，不可以變成兩筆');
  assert.equal(carried, form.nonce, '登入表單裡帶著草稿原本的送出編號');
  assert.equal(field(back.text, 'nonce'), form.nonce, '回到專區後，回覆表單裡還是它');
  // 5. 送出成功後的那一頁有新的送出編號：同樣的文字再送一次，是新的一則
  const after = await browser.get('/?sent=1');
  assert.match(field(after.text, 'nonce'), /^[a-f0-9]{32}$/);
  assert.notEqual(field(after.text, 'nonce'), form.nonce);
  assert.equal((await browser.post('/reply', { csrf: field(after.text, 'csrf'), nonce: field(after.text, 'nonce'), body: text })).status, 303);
  assert.equal(await replyCopies(text), 2, '明確開始下一則時，同樣的文字可以再送一則');
  await unlockLogin();
});

test('驗收 6-4：奇怪的輸入照原樣存成文字（SQL 語法、控制字元、換行）', async () => {
  const client = await newVisitor();
  const sql = `IN-JEC-TION-5e1a'); DROP TABLE replies;-- " OR 1=1 -- \\ %00 {{7*7}} \${7*7}`;
  secretsSeen.replyBodies.push(sql);
  assert.equal((await sendReply(client, sql)).res.status, 303);
  const multi = 'LINES-7b3c 一行目\r\n二行目\r三行目\n\n\u0000\u0007\u001b[31m四行目\u007f　';
  assert.equal((await sendReply(client, multi)).res.status, 303);
  const all = await inbox();
  assert.ok(all.some((r) => r.body === sql), 'SQL 語法只是文字，資料表還在');
  const lines = all.find((r) => r.body.startsWith('LINES-7b3c'));
  assert.equal(lines.body, 'LINES-7b3c 一行目\n二行目\n三行目\n\n[31m四行目', '換行統一、控制字元去掉、頭尾空白不算');
  assert.ok(all.length >= 6);
});

test('驗收 6-5：站主可以刪除回覆；刪除後收件匣與匯出檔都沒有它', async () => {
  const target = (await inbox()).find((r) => r.body === EVIL);
  assert.ok(target);
  const csrf = await adminCsrf(admin, '/');
  assert.equal((await admin.post(`/replies/${target.id}/delete`, { csrf: 'f'.repeat(64) })).status, 403, '防偽造編號不對的刪除不會生效');
  assert.equal((await admin.post(`/replies/${target.id}/delete`, { csrf }, { origin: 'https://evil.example' })).status, 403, '來自別的網站的刪除不會生效');
  assert.ok((await inbox()).some((r) => r.id === target.id));
  const res = await admin.post(`/replies/${target.id}/delete`, { csrf });
  assert.equal(res.status, 303);
  assert.ok(!(await inbox()).some((r) => r.id === target.id));
  assert.ok(!(await admin.get('/')).text.includes('xss-4c7e'));
  assert.ok((await admin.get('/access')).text.includes('刪除回覆'), '管理紀錄裡有這個動作');
});

/* ================================================================================================
   驗收 7：超過設定門檻的登入嘗試與回覆送出，會受到限速
   ================================================================================================ */

test('驗收 7-1：同一個來源錯 5 次之後，連正確的密碼也要等；站主可以解除', async () => {
  await unlockLogin();
  await awayFromWindowEdge();
  const client = new Client(stack.visitorUrl);
  for (let i = 1; i <= 5; i++) {
    const res = await visitorLogin(client, `wrong-guess-number-${i}-xxxxxxxx`);
    assert.equal(res.status, 401, `第 ${i} 次`);
    assert.ok(res.text.includes('合言葉が違うようです'));
  }
  const sixth = await visitorLogin(client, 'wrong-guess-number-6-xxxxxxxx');
  assert.equal(sixth.status, 429);
  const wait = Number(sixth.headers.get('retry-after'));
  assert.ok(wait >= 1 && wait <= 600, `Retry-After: ${wait}`);
  assert.ok(sixth.text.includes('入力の回数が多すぎます'));
  assert.ok(isGate(sixth));
  const correct = await visitorLogin(new Client(stack.visitorUrl), password);
  assert.equal(correct.status, 429, '被擋住的期間，正確的密碼也不受理');
  assert.equal(correct.setCookie.some((c) => c.startsWith('__Host-room-session=')), false);
  // 已經登入的人不受影響
  await unlockLogin();
  assert.equal((await visitorLogin(new Client(stack.visitorUrl), password)).status, 303, '站主清除限速紀錄後可以登入');
});

test('驗收 7-2：同時送出一大批錯的密碼，被拿去比對的最多 5 個', async () => {
  await unlockLogin();
  await awayFromWindowEdge();
  const attempts = await Promise.all(Array.from({ length: 24 }, async (unused, i) => {
    const client = new Client(stack.visitorUrl);
    return (await visitorLogin(client, `parallel-wrong-guess-${i}-xxxxxxxx`)).status;
  }));
  const evaluated = attempts.filter((s) => s === 401).length;
  const limited = attempts.filter((s) => s === 429).length;
  assert.equal(evaluated + limited, 24, attempts.join(','));
  assert.ok(evaluated <= 5, `有 ${evaluated} 個被受理`);
  assert.ok(limited >= 19);
  await unlockLogin();
});

test('驗收 7-3：同一次登入 10 分鐘內最多送 5 則回覆；被擋下的不會存，內容留在畫面上', async () => {
  await awayFromWindowEdge();
  const client = await newVisitor();
  const count = (await inbox()).length;
  for (let i = 1; i <= 5; i++) {
    const text = `RATE-OK-${i}-d41d 連続で送るテスト`;
    secretsSeen.replyBodies.push(text);
    assert.equal((await sendReply(client, text)).res.status, 303, `第 ${i} 則`);
  }
  const blocked = await sendReply(client, 'RATE-BLOCKED-6-d41d これは保存されない');
  assert.equal(blocked.res.status, 429);
  assert.ok(Number(blocked.res.headers.get('retry-after')) >= 1);
  assert.ok(blocked.res.text.includes('送信の回数が多すぎます'));
  assert.ok(blocked.res.text.includes('RATE-BLOCKED-6-d41d これは保存されない</textarea>'), '內容留在輸入欄');
  const blockedApi = await sendReply(client, 'RATE-BLOCKED-7-d41d', { json: true });
  assert.equal(blockedApi.res.status, 429);
  assert.equal(blockedApi.json.code, 'replyLimited');
  const all = await inbox();
  assert.equal(all.length, count + 5);
  assert.ok(!all.some((r) => r.body.includes('RATE-BLOCKED')));
  // 已經存過的那一則重送（例如重新整理）不算新的一則，也不會被擋
  // 另一次登入不受這個人的額度影響
  const other = await newVisitor();
  secretsSeen.replyBodies.push('RATE-OTHER-d41d 別のログイン');
  assert.equal((await sendReply(other, 'RATE-OTHER-d41d 別のログイン')).res.status, 303);
});

test('驗收 7-4：同時送出一大批回覆，存下來的最多 5 則', async () => {
  await awayFromWindowEdge();
  const client = await newVisitor();
  const count = (await inbox()).length;
  const results = await Promise.all(Array.from({ length: 12 }, async (unused, i) => {
    const form = await visitorForm(client);
    return (await sendReply(client, `BURST-${i}-9f0a 同時に送る`, { form })).res.status;
  }));
  const saved = (await inbox()).filter((r) => r.body.startsWith('BURST-')).length;
  assert.ok(saved <= 5, `存了 ${saved} 則`);
  assert.equal(saved, results.filter((s) => s === 303).length, '顯示成功的數量 = 真的存下來的數量');
  assert.equal(results.filter((s) => s === 429).length, 12 - saved);
  assert.equal((await inbox()).length, count + saved);
});

/* ------------------------------------------------------------------------------------------------
   回覆去重的整體檢查：隨機安排各種動作的順序，和一個簡單的模型比對。
   放在限速的測試之後：這個測試會用掉一些「同一個 IP 一天 60 則」的額度，額度不夠時它自己能應付（被擋下的不算存進去），
   不會影響前面需要固定次數的測試。
   ------------------------------------------------------------------------------------------------ */

test('隨機安排的送出順序（成功的回應有時收不到、登入失效、重新登入、別的分頁登入、改內容）：資料庫裡的筆數永遠等於「不同的送出」的數量', async (t) => {
  await unlockLogin();
  await awayFromWindowEdge();
  /** 固定種子的亂數：每次執行走的是同一條路，失敗時可以重現 */
  const random = (seed) => () => { seed = (seed + 0x6D2B79F5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const accept = { headers: { Accept: 'application/json' } };
  let scenarios = 0, sends = 0, deduped = 0;
  for (const seed of [20261115, 7, 4242]) {
    const next = random(seed);
    const pick = (list) => list[Math.floor(next() * list.length)];
    const marker = `MODEL-${seed}-9c1e`;
    secretsSeen.replyBodies.push(marker);
    // 「這一頁」的狀態：登入 cookie、表單裡的防偽造編號與送出編號、輸入欄的內容
    const page = new Client(stack.visitorUrl);
    assert.equal((await visitorLogin(page, password)).status, 303);
    secretsSeen.sessionTokens.push(page.jar.get('__Host-room-session'));
    const form = await visitorForm(page);
    let csrf = form.csrf, nonce = form.nonce, version = 1, draft = `${marker} 下書き 1`, signedIn = true;
    const stored = new Set();          // 伺服器回報「已經存好」的（送出編號｜內容）
    const trail = [];
    /** 送出目前的內容。received：頁面有沒有收到成功的回應（沒收到的話，頁面不知道已經存好，也不會換送出編號） */
    const send = async (received, retried = false) => {
      const key = `${nonce}|${draft}`;
      const res = await page.post('/reply', { csrf, nonce, body: draft }, accept);
      const data = JSON.parse(res.text);
      sends += 1;
      if (res.status === 200 && data.ok) {
        if (stored.has(key)) { deduped += 1; }
        stored.add(key);
        if (received) {
          nonce = data.nonce;                                    // 伺服器確認存好之後才換下一個送出編號
          if (next() < 0.5) { version += 1; draft = `${marker} 下書き ${version}`; }   // 下一則：有時候是一模一樣的文字
        }
        return 'ok';
      }
      if (stored.has(key) && signedIn && res.status !== 403) { assert.fail(`已經存過的那一則重送被拒絕：HTTP ${res.status}（${trail.join(' ')}）`); }
      if (res.status === 401) { assert.equal(signedIn, false, `登入還有效卻被當成沒登入（${trail.join(' ')}）`); return 'session'; }
      if (res.status === 403 && data.code === 'errExpired' && !retried) {
        // 這一頁的防偽造編號過期：和 room.js 一樣，向 /session 要新的再送一次（送出編號不變）
        const info = JSON.parse((await page.get('/session')).text);
        assert.equal(info.signedIn, true);
        csrf = info.reply.csrf;
        return send(received, true);
      }
      assert.equal(res.status, 429, `沒有預期到的回應：HTTP ${res.status} ${res.text}（${trail.join(' ')}）`);
      return 'limited';
    };
    const actions = {
      'send': () => send(true),
      'send-lost': () => send(false),                            // 存好了，但成功的回應沒有送到頁面
      'expire': async () => {                                    // 登入在別的地方被登出
        if (!signedIn) { return; }
        await new Client(stack.visitorUrl).post('/logout', { csrf }, { headers: { Cookie: `__Host-room-session=${page.jar.get('__Host-room-session')}` }, cookies: false });
        signedIn = false;
      },
      'relogin': async () => {                                   // 在頁面上重新登入：只換防偽造編號
        if (signedIn) { return; }
        const info = JSON.parse((await page.get('/session')).text);
        const res = await page.post('/login', { csrf: info.csrf, password }, accept);
        assert.equal(res.status, 200);
        csrf = JSON.parse(res.text).csrf;
        signedIn = true;
        secretsSeen.sessionTokens.push(page.jar.get('__Host-room-session'));
      },
      'other-tab': async () => {                                 // 同一個瀏覽器的另一個分頁重新登入：cookie 換了，這一頁的防偽造編號過期
        const other = await newVisitor();
        page.jar.set('__Host-room-session', other.jar.get('__Host-room-session'));
        signedIn = true;
      },
      'edit': async () => { version += 1; draft = `${marker} 下書き ${version}`; },   // 改了內容（送出編號不變）
    };
    for (let step = 0; step < 26; step++) {
      const name = pick(['send', 'send', 'send-lost', 'send-lost', 'send-lost', 'expire', 'relogin', 'relogin', 'other-tab', 'edit']);
      trail.push(name);
      await actions[name]();
    }
    // 收尾：確定登入有效，再把目前的內容送出並收到回應
    trail.push('relogin', 'send');
    await actions.relogin();
    await send(true);

    const rows = (await inbox()).filter((r) => r.body.startsWith(marker));
    const expected = [...stored].map((key) => key.slice(key.indexOf('|') + 1)).sort();
    assert.deepEqual(rows.map((r) => r.body).sort(), expected, `種子 ${seed}：資料庫裡的回覆應該剛好是「不同的送出」各一筆（${trail.join(' ')}）`);
    assert.ok(stored.size >= 3, `種子 ${seed}：這條路至少存了幾則（${stored.size}）`);
    scenarios += 1;
  }
  assert.ok(deduped >= 5, `這幾條路裡，「已經存過的那一則再送一次」至少出現幾次（${deduped}）`);
  t.diagnostic(`走了 ${scenarios} 條隨機的路，共 ${sends} 次送出，其中 ${deduped} 次是已經存過的那一則再送`);
  const used = await stack.sql("SELECT MAX(count) AS used FROM rate_limits WHERE bucket LIKE 'reply:ip:%'");
  t.diagnostic(`到這裡為止，同一個 IP 今天用掉的回覆額度：${used[0].used}／60`);
  await unlockLogin();
});

/* ================================================================================================
   其他防護：跨站偽造請求、cookie 的屬性、內容安全政策、日誌
   ================================================================================================ */

test('登入 cookie：__Host- 開頭、Secure、HttpOnly、SameSite=Lax、有期限', async () => {
  const client = new Client(stack.visitorUrl);
  const res = await visitorLogin(client, password);
  const session = res.setCookie.find((c) => c.startsWith('__Host-room-session='));
  const parts = session.split('; ');
  assert.match(parts[0], /^__Host-room-session=[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(parts.slice(1).sort(), ['HttpOnly', 'Max-Age=604800', 'Path=/', 'SameSite=Lax', 'Secure'].sort());
  secretsSeen.sessionTokens.push(parts[0].split('=')[1]);
  const gate = await new Client(stack.visitorUrl).get('/');
  const csrfCookie = gate.setCookie.find((c) => c.startsWith('__Host-room-csrf='));
  assert.ok(csrfCookie.includes('Secure') && csrfCookie.includes('HttpOnly') && csrfCookie.includes('SameSite=Strict') && csrfCookie.includes('Path=/'));
  assert.ok(!/Domain=/i.test(session + csrfCookie));
  // 每次登入的憑證都不一樣
  const again = await visitorLogin(new Client(stack.visitorUrl), password);
  assert.notEqual(again.setCookie.find((c) => c.startsWith('__Host-room-session=')), session);
});

test('跨站偽造請求：沒有 Origin、Origin 是別的網站、防偽造編號不對，一律不受理', async () => {
  await unlockLogin();
  // 登入
  const client = new Client(stack.visitorUrl);
  const page = await client.get('/');
  const csrf = field(page.text, 'csrf');
  assert.equal((await client.post('/login', { csrf, password }, { origin: null })).status, 403, '沒有 Origin');
  assert.equal((await client.post('/login', { csrf, password }, { origin: 'https://evil.example' })).status, 403, '別的網站');
  assert.equal((await client.post('/login', { csrf, password }, { origin: 'null' })).status, 403, 'Origin: null');
  assert.equal((await client.post('/login', { csrf: 'a'.repeat(32), password })).status, 403, '編號不對');
  assert.equal((await new Client(stack.visitorUrl).post('/login', { csrf, password })).status, 403, '沒有對應的 cookie');
  assert.equal(client.jar.has('__Host-room-session'), false);
  assert.equal((await client.post('/login', { csrf, password })).status, 303, '正常的請求可以登入');

  // 回覆與登出
  const form = await visitorForm(client);
  const count = (await inbox()).length;
  for (const origin of [null, 'https://evil.example', stack.adminUrl]) {
    assert.equal((await client.post('/reply', { csrf: form.csrf, nonce: form.nonce, body: 'cross-site reply' }, { origin })).status, 403);
    assert.equal((await client.post('/logout', { csrf: form.csrf }, { origin })).status, 403);
  }
  assert.equal((await inbox()).length, count);
  assert.ok(isRoom(await client.get('/')), '登入狀態沒有被別的網站登出');
  // GET 不會改變任何狀態
  for (const url of ['/logout', '/reply', '/login']) { assert.equal((await client.get(url)).status, 404, url); }
  assert.ok(isRoom(await client.get('/')));

  // 管理端
  const adminCsrfToken = await adminCsrf(admin);
  for (const origin of [null, 'https://evil.example', stack.visitorUrl]) {
    assert.equal((await admin.post('/access/revoke', { csrf: adminCsrfToken }, { origin })).status, 403);
    assert.equal((await admin.post('/content', { csrf: adminCsrfToken, title_ja: 'hacked' }, { origin })).status, 403);
  }
  assert.equal((await admin.post('/content', { csrf: 'f'.repeat(64), title_ja: 'hacked' })).status, 403);
  assert.ok(isRoom(await client.get('/')), '標題沒有被改掉，登入也沒有被撤銷');
});

test('語言切換：日文預設，可以切到繁體中文；登入前後都能切', async () => {
  const client = new Client(stack.visitorUrl);
  const ja = await client.get('/');
  assert.match(ja.text, /<html lang="ja">/);
  assert.ok(ja.text.includes('合言葉のページ'));
  const sw = await client.get('/lang/zh');
  assert.equal(sw.status, 303);
  assert.ok(sw.setCookie.some((c) => c.startsWith('__Host-room-lang=zh') && c.includes('Secure') && c.includes('HttpOnly') && c.includes('SameSite=Lax')));
  const zh = await client.get('/');
  assert.match(zh.text, /<html lang="zh-Hant">/);
  assert.ok(zh.text.includes('通關密語頁面'));
  assert.equal((await visitorLogin(client, password)).status, 303);
  const room = await client.get('/');
  assert.ok(room.text.includes('PRIVATE-TITLE-7f3a 確認用的標題') && room.text.includes('PRIVATE-CAPTION-1 範例照片') && room.text.includes('2026 年 11 月 14 日'));
  assert.equal((await client.get('/lang/xx')).status, 404);
  await client.get('/?lang=ja');
  assert.ok((await client.get('/')).text.includes('PRIVATE-TITLE-7f3a 確認用のタイトル'));
});

test('日誌：沒有密碼、登入憑證、管理者憑證、金鑰或回覆的內容', async () => {
  const log = stack.logs.join('');
  assert.ok(log.includes('"event":"login_ok"') && log.includes('"event":"login_failed"') && log.includes('"event":"reply_saved"'), '日誌裡有事件名稱');
  assert.ok(log.includes('"event":"login_rate_limited"') && log.includes('"event":"reply_rate_limited"') && log.includes('"event":"admin_denied_invalid-token"'));
  for (const pw of secretsSeen.passwords) {
    assert.ok(!log.includes(pw) && !log.includes(normalizePassword(pw)) && !log.includes(encodeURIComponent(pw)), '日誌裡不可以有訪客密碼');
  }
  for (const token of secretsSeen.sessionTokens.filter(Boolean)) { assert.ok(!log.includes(token), '日誌裡不可以有登入憑證'); }
  for (const token of secretsSeen.adminTokens) { assert.ok(!log.includes(token) && !log.includes(token.split('.')[2]), '日誌裡不可以有管理者憑證'); }
  for (const body of secretsSeen.replyBodies) { assert.ok(!log.includes(body.slice(0, 16)), `日誌裡不可以有回覆內容：${body.slice(0, 16)}`); }
  for (const marker of [...PRIVATE_MARKERS, 'wrong-guess-number', 'parallel-wrong-guess', stack.secrets.PEPPER, stack.secrets.SESSION_SECRET]) {
    assert.ok(!log.includes(marker), `日誌裡不可以有 ${marker.slice(0, 20)}`);
  }
  assert.ok(secretsSeen.passwords.length >= 3 && secretsSeen.sessionTokens.length >= 10 && secretsSeen.replyBodies.length >= 10);
});

/* ================================================================================================
   驗收 6（續）：整個服務重新啟動後，回覆、照片與密碼都還在（資料存在資料庫與儲存空間，不在記憶體）
   ================================================================================================ */

test('驗收 6-6：所有服務停掉再啟動（等於換一台機器、換一個裝置來看），回覆與照片都還在', async () => {
  const before = await inbox();
  assert.ok(before.length >= 10);
  const { dir, secrets } = stack;
  await stack.stop({ remove: false });
  stack = await startStack({ dir, secrets, shortTtlSeconds: 2 });
  try {
    admin = adminClient(stack, await stack.access.sign({ lifetime: 3600 }));
    const afterRestart = await inbox();
    assert.deepEqual(afterRestart, before, '重新啟動後，收件匣的內容完全一樣');
    const client = await newVisitor();
    const page = await client.get('/');
    assert.ok(isRoom(page));
    for (const photo of photos) {
      assert.ok(page.text.includes(`/photo/${photo.id}/thumb`));
      assert.equal((await client.get(`/photo/${photo.id}/full`)).status, 200);
      assert.equal((await new Client(stack.visitorUrl).get(`/photo/${photo.id}/full`)).status, 401);
    }
  } finally {
    await stack.stop();
    await rm(dir, { recursive: true, force: true });
    stack = null;
  }
});
