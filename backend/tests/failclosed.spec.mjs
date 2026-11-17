// 「設定不完整或驗證服務出錯時，預設拒絕」的測試：故意把服務設定壞，確認它什麼都不給。
//
//   node --test tests/failclosed.spec.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, rm, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { seededStack, SAMPLE } from './helpers/seed.mjs';
import { Client, field, visitorLogin, visitorForm, adminClient, adminCsrf } from './helpers/client.mjs';
import { ROOT, ADMIN_EMAIL, ACCESS_AUD } from './helpers/stack.mjs';

let env, stack, visitor, cookieHeader, photoUrl;

const leaks = (text) => text.includes(SAMPLE.title_ja) || text.includes('サンプルの写真') || text.includes('data-reply-form') || env.photoIds.some((id) => text.includes(id));

before(async () => {
  env = await seededStack();
  stack = env.stack;
  // 一位真的登入成功的訪客：下面每一種壞掉的情況，都拿這個有效的 cookie 去試
  visitor = new Client(stack.visitorUrl);
  assert.equal((await visitorLogin(visitor, env.password)).status, 303);
  cookieHeader = visitor.cookieHeader();
  photoUrl = `/photo/${env.photoIds[0]}/full`;
  assert.equal((await visitor.get(photoUrl)).status, 200, '對照組：正常的服務上，這個 cookie 看得到照片');
});

after(async () => {
  if (env) { await env.stop(); }
});

test('訪客端沒有設定金鑰（或金鑰太短）：整個服務不可用，有效的登入也拿不到任何內容', async () => {
  for (const vars of [{}, { PEPPER: 'short', SESSION_SECRET: 'short' }, { PEPPER: stack.secrets.PEPPER }, { SESSION_SECRET: stack.secrets.SESSION_SECRET }]) {
    const url = await stack.launch('visitor', { vars });
    const client = new Client(url);
    const page = await client.get('/', { headers: { Cookie: cookieHeader }, cookies: false });
    assert.equal(page.status, 503, JSON.stringify(Object.keys(vars)));
    assert.ok(page.text.includes('ただいま準備中です'));
    assert.ok(!leaks(page.text));
    const photo = await client.get(photoUrl, { headers: { Cookie: cookieHeader }, cookies: false });
    assert.equal(photo.status, 503);
    assert.ok(!(photo.headers.get('content-type') || '').includes('image'));
    const login = await client.post('/login', { csrf: 'x', password: env.password });
    assert.equal(login.status, 503);
    assert.equal(login.setCookie.some((c) => c.startsWith('__Host-room-session=')), false);
    const reply = await client.post('/reply', { csrf: 'x', nonce: 'a'.repeat(32), body: 'x' }, { headers: { Cookie: cookieHeader }, cookies: false });
    assert.equal(reply.status, 503);
  }
});

test('訪客端與管理端的金鑰不一樣：不會把正確的密碼當成打錯，而是顯示「準備中」並記錄設定有問題', async () => {
  const url = await stack.launch('visitor', { vars: { PEPPER: randomBytes(32).toString('hex'), SESSION_SECRET: stack.secrets.SESSION_SECRET } });
  for (let i = 0; i < 7; i++) {                                   // 試 7 次：都不算進「打錯的次數」，不會變成被限速
    const res = await visitorLogin(new Client(url), env.password);
    assert.equal(res.status, 503, `第 ${i + 1} 次`);
    assert.ok(res.text.includes('ただいま準備中です'));
    assert.equal(res.setCookie.some((c) => c.startsWith('__Host-room-session=')), false);
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(stack.logs.join('').includes('"event":"config_pepper_mismatch"'));
  assert.equal((await visitorLogin(new Client(stack.visitorUrl), env.password)).status, 303, '正常的服務不受影響');
});

test('資料庫壞掉（查不到登入狀態）：不給頁面內容、不給照片、不能登入、不存回覆', async () => {
  // 複製一份狀態：照片檔案都還在，但把資料庫拿掉（等於資料庫查詢全部失敗）
  const broken = path.join(stack.dir, 'state-without-database');
  await cp(stack.state, broken, { recursive: true });
  await rm(path.join(broken, 'v3', 'd1'), { recursive: true, force: true });
  const url = await stack.launch('visitor', { vars: stack.secrets, state: broken });
  const client = new Client(url);

  const page = await client.get('/', { headers: { Cookie: cookieHeader, Accept: 'text/html' }, cookies: false });
  assert.equal(page.status, 500);
  assert.ok(page.text.includes('うまく表示できませんでした'));
  assert.ok(!leaks(page.text));
  const photo = await client.get(photoUrl, { headers: { Cookie: cookieHeader }, cookies: false });
  assert.equal(photo.status, 500);
  assert.ok(photo.buffer.length < 64, '沒有圖片資料');
  assert.equal(photo.headers.get('cache-control'), 'private, no-store');

  // 登入：連限速的計數都寫不進去 → 不受理（不會因為「查不到限速紀錄」就放行）
  const gate = await client.get('/');
  assert.equal(gate.status, 200, '沒帶 cookie 時只是登入表單（不需要資料庫）');
  assert.ok(!leaks(gate.text));
  const login = await client.post('/login', { csrf: field(gate.text, 'csrf'), password: env.password });
  assert.equal(login.status, 500);
  assert.equal(login.setCookie.some((c) => c.startsWith('__Host-room-session=')), false);
  const form = await visitorForm(visitor);
  const reply = await client.post('/reply', { csrf: form.csrf, nonce: form.nonce, body: 'database is down' }, { headers: { Cookie: cookieHeader, Accept: 'application/json' }, cookies: false });
  assert.equal(reply.status, 500);
  assert.ok(!reply.text.includes('"ok":true'));
});

test('管理端的 Cloudflare Access 沒設定好：就算帶著簽章正確的憑證，也一律 403', async () => {
  const token = await stack.access.sign();
  assert.equal((await adminClient(stack, token).get('/')).status, 200, '對照組：設定正確的管理端接受這個憑證');
  const { ENVIRONMENT, ...withoutLocalFlag } = stack.adminVars;
  const broken = {
    '沒有設定對象（AUD）': { ...stack.adminVars, POLICY_AUD: '' },
    '沒有設定站主的信箱': { ...stack.adminVars, ADMIN_EMAILS: '' },
    '信箱的格式不對': { ...stack.adminVars, ADMIN_EMAILS: 'owner' },
    '不是本機測試，團隊網域卻不是 cloudflareaccess.com（本機用的模擬 Access 在正式環境不會被接受）': withoutLocalFlag,
    '取不到驗證用的公鑰': { ...stack.adminVars, TEAM_DOMAIN: 'http://127.0.0.1:9' },
    '團隊網域指向別人的網站': { ...stack.adminVars, TEAM_DOMAIN: 'https://attacker.example' },
    '完全沒設定（設定檔裡的預留值）': {},
  };
  for (const [name, vars] of Object.entries(broken)) {
    const url = await stack.launch('admin', { vars });
    const client = new Client(url, { headers: { 'Cf-Access-Jwt-Assertion': token } });
    for (const target of ['/', '/export.json', '/photos', photoUrl, '/admin.css']) {
      const res = await client.get(target);
      assert.equal(res.status, 403, `${name} → ${target}`);
      assert.match(res.text, /^Forbidden \((not-configured|invalid-token)\)\n$/, `${name} → ${target}`);
    }
    assert.equal((await client.post('/access/generate', { csrf: 'x'.repeat(64) })).status, 403, name);
  }
  assert.equal((await visitorLogin(new Client(stack.visitorUrl), env.password)).status, 303, '密碼沒有被任何一個壞掉的管理端換掉');
});

test('Access 直接掛在 Worker 上時（身分在 ctx.access）：對象或信箱不符一樣拒絕；相符才進得去', async () => {
  // wrangler 可以在本機模擬「Access 已經驗證過這個請求」（設定檔的 access.dev）。這份設定只在測試時臨時產生，不在 repo 裡
  const base = JSON.parse((await readFile(path.join(ROOT, 'admin', 'wrangler.jsonc'), 'utf8')).replace(/^\s*\/\/.*$/gm, ''));
  base.main = path.join(ROOT, 'admin', 'src', 'index.js');
  base.d1_databases[0].migrations_dir = path.join(ROOT, 'migrations');
  const launch = async (name, dev) => {
    const file = path.join(stack.dir, `wrangler.${name}.jsonc`);
    await writeFile(file, JSON.stringify({ ...base, access: { dev } }, null, 2));
    return new Client(await stack.launch('admin', { vars: stack.adminVars, config: file }));   // 這些請求都不帶任何憑證標頭
  };

  const ok = await launch('ctx-ok', { aud: ACCESS_AUD, identity: { email: ADMIN_EMAIL, name: 'Owner' } });
  const page = await ok.get('/');
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('收件匣') && page.text.includes(ADMIN_EMAIL));
  assert.equal((await ok.post('/access/unlock', { csrf: await adminCsrf(ok) })).status, 303, '通過驗證後，管理功能可以用');
  assert.equal((await ok.get('/admin.css')).status, 200);

  const wrongAud = await launch('ctx-aud', { aud: 'some-other-application', identity: { email: ADMIN_EMAIL } });
  const r1 = await wrongAud.get('/');
  assert.equal(r1.status, 403);
  assert.match(r1.text, /^Forbidden \(aud-mismatch\)\n.*some-other-application/);
  assert.equal((await wrongAud.get('/export.json')).status, 403);

  const stranger = await launch('ctx-email', { aud: ACCESS_AUD, identity: { email: 'visitor@example.test' } });
  const r2 = await stranger.get('/');
  assert.equal(r2.status, 403);
  assert.match(r2.text, /^Forbidden \(not-allowed\)\n.*visitor@example\.test/);
  assert.equal((await stranger.post('/access/generate', { csrf: 'x'.repeat(64) })).status, 403);

  const nameless = await launch('ctx-noemail', { aud: ACCESS_AUD });
  const r3 = await nameless.get('/');
  assert.equal(r3.status, 403);
  assert.match(r3.text, /^Forbidden \((no-email|identity-unavailable)\)\n$/);
});

test('回覆的每日總量上限：所有登入合計到達上限後，誰都不能再送（合言葉外流時收件匣不會被灌爆）', async () => {
  const url = await stack.launch('visitor', { vars: { ...stack.secrets, REPLY_DAILY_CAP: '3' } });   // 這個測試用的訪客端：一天最多 3 則
  const login = async () => { const c = new Client(url); assert.equal((await visitorLogin(c, env.password)).status, 303); return c; };
  const send = async (client, body) => { const form = await visitorForm(client); return client.post('/reply', { csrf: form.csrf, nonce: form.nonce, body }); };
  const day = 86400, left = day - (Math.floor(Date.now() / 1000) % day);
  if (left < 15) { await new Promise((r) => setTimeout(r, (left + 1) * 1000)); }      // 不要剛好跨過日界線
  const a = await login(), b = await login();
  assert.equal((await send(a, 'CAP-1 一通目')).status, 303);
  assert.equal((await send(a, 'CAP-2 二通目')).status, 303);
  assert.equal((await send(b, 'CAP-3 別の人の一通目')).status, 303);
  for (const client of [a, b, await login()]) {
    const blocked = await send(client, 'CAP-4 これは保存されない');
    assert.equal(blocked.status, 429);
    assert.ok(blocked.text.includes('CAP-4 これは保存されない</textarea>'), '內容留在輸入欄');
  }
  const stored = JSON.parse((await env.admin.get('/export.json')).text).replies.filter((r) => r.body.startsWith('CAP-'));
  assert.deepEqual(stored.map((r) => r.body).sort(), ['CAP-1 一通目', 'CAP-2 二通目', 'CAP-3 別の人の一通目']);
});
