// 「部署後檢查」腳本（scripts/check_deployed.mjs）自己的測試：
// - 對本機的測試環境跑一遍完整的檢查（含真實的測試圖、登出、撤銷、換密碼、回覆），應該全部通過
// - 對一個「故意做錯」的假服務跑一遍，確認每一種錯都會被判定為沒通過
// - 連不上、缺少資訊、需要人手操作時，判定是「無法判定」，不是通過
// - 被限速（429）、伺服器錯誤（5xx）、沒有驗證過的轉址（3xx）、看不出是誰拒絕的回應，也是「無法判定」，不是通過
//
//   node --test tests/check_deployed.spec.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { seededStack, fixturePath } from './helpers/seed.mjs';
import { adminCsrf, generateVisitorPassword } from './helpers/client.mjs';
import { ROOT, freePort } from './helpers/stack.mjs';
import { runChecks, judgePlainHttp, judgeAccessRedirect, judgePreviewUrl, judgeBucketUrl, judgeNoExplorer, judgeOldPassword, judgeLoginRate, hasProjectHeaders, normalizeTeamDomain, MANUAL_ITEMS } from '../scripts/check_deployed.mjs';
import { baseHeaders } from '../shared/util.js';

let env;
before(async () => { env = await seededStack(); });
after(async () => { if (env) { await env.stop(); } });

const byId = (run) => Object.fromEntries(run.results.map((r) => [r.id, r]));
const statusOf = (run, id) => (byId(run)[id] || { status: 'missing' }).status;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** 限速用的是固定時間窗；測試剛好跨過時間窗的交界會誤判，所以太接近交界時先等一下 */
async function awayFromWindowEdge(windowSeconds = 600, marginSeconds = 20) {
  const left = windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds);
  if (left <= marginSeconds) { await sleep((left + 1) * 1000); }
}

/* ---------- 判定的規則 ---------- */

test('http:// 的判定：轉到 https 才算通過；連不上是「無法判定」，不是通過', () => {
  const site = 'https://ayaka-room.example.workers.dev';
  assert.equal(judgePlainHttp({ status: 301, location: 'https://ayaka-room.example.workers.dev/' }, site).status, 'pass');
  assert.equal(judgePlainHttp({ status: 308, location: 'https://ayaka-room.example.workers.dev/' }, site).status, 'pass');
  for (const error of ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT', 'TimeoutError']) {
    const verdict = judgePlainHttp({ error }, site);
    assert.equal(verdict.status, 'unknown', error);
    assert.ok(verdict.detail.includes(error));
  }
  assert.equal(judgePlainHttp({ status: 200, location: '', gate: true }, site).status, 'fail', '用 http 就拿得到登入頁');
  assert.equal(judgePlainHttp({ status: 200, location: '', gate: false }, site).status, 'fail');
  assert.equal(judgePlainHttp({ status: 301, location: 'http://ayaka-room.example.workers.dev/' }, site).status, 'fail', '轉到的還是 http');
  assert.equal(judgePlainHttp({ status: 302, location: 'https://somewhere-else.example/' }, site).status, 'fail', '轉到別的主機');
  assert.equal(judgePlainHttp({ status: 301, location: '' }, site).status, 'fail');
  assert.equal(judgePlainHttp({ status: 403, location: '' }, site).status, 'unknown');
});

test('Access 轉址的判定：解析主機名稱，核對是不是預期的團隊網域', () => {
  const adminUrl = 'https://ayaka-room-admin.example.workers.dev';
  const team = 'myteam.cloudflareaccess.com';
  const to = (location, status = 302) => ({ status, location });
  const login = 'https://myteam.cloudflareaccess.com/cdn-cgi/access/login/ayaka-room-admin.example.workers.dev?kid=abc123&redirect_url=%2F';
  assert.deepEqual(judgeAccessRedirect(to(login), adminUrl, team), { status: 'pass', detail: '轉到 myteam.cloudflareaccess.com', host: team, kid: 'abc123' });
  assert.equal(judgeAccessRedirect(to(login), adminUrl, team, 'abc123').status, 'pass');
  assert.equal(judgeAccessRedirect(to(login), adminUrl, team, 'another-app').status, 'fail', '應用程式編號不符');
  assert.equal(judgeAccessRedirect(to(login), adminUrl, null).status, 'unknown', '沒有提供預期的團隊網域');
  assert.equal(judgeAccessRedirect(to(login), adminUrl, 'otherteam.cloudflareaccess.com').status, 'fail', '別人的團隊網域');
  // 只是網址裡「有出現」cloudflareaccess.com 不算
  for (const location of [
    'https://evil.example/?next=myteam.cloudflareaccess.com', 'https://myteam.cloudflareaccess.com.evil.example/login', 'https://evil.example/myteam.cloudflareaccess.com',
    'https://myteam.cloudflareaccess.com@evil.example/', 'http://myteam.cloudflareaccess.com/cdn-cgi/access/login', 'https://cloudflareaccess.com/', '/login', '',
  ]) {
    assert.equal(judgeAccessRedirect(to(location), adminUrl, team).status, 'fail', location);
    assert.equal(judgeAccessRedirect(to(location), adminUrl, null).status, 'fail', location + '（沒有提供團隊網域時也一樣）');
  }
  assert.equal(judgeAccessRedirect({ status: 403, location: '' }, adminUrl, team).status, 'fail', '403 表示 Access 沒有擋在前面');
  assert.equal(judgeAccessRedirect({ status: 200, location: '' }, adminUrl, team).status, 'fail');
  assert.equal(normalizeTeamDomain('myteam'), team);
  assert.equal(normalizeTeamDomain('https://MyTeam.cloudflareaccess.com/'), team);
  assert.equal(normalizeTeamDomain('myteam.cloudflareaccess.com.evil.example'), null);
  assert.equal(normalizeTeamDomain('evil.example'), null);
  assert.equal(normalizeTeamDomain(''), null);
});

/** 這個專案的 Worker 每個回應都帶的標頭，整理成判定函式吃的樣子（名稱小寫） */
const projectHeaders = (options) => Object.fromEntries(Object.entries(baseHeaders(options)).map(([name, value]) => [name.toLowerCase(), value]));

test('預覽網址的判定：連得到 Worker 就是沒通過；其他回應一律「無法判定」，不會回報通過', () => {
  // 沒通過：回應是這個專案的 Worker 送出來的（不管狀態碼），或被轉到 Cloudflare Access
  assert.equal(judgePreviewUrl({ status: 200, location: '', text: '<form class="room__form" method="post" action="/login">' }).status, 'fail', '看得到訪客端的登入頁');
  assert.equal(judgePreviewUrl({ status: 403, location: '', text: 'Forbidden (missing-token)\n' }).status, 'fail', '管理端的 Worker 在回應');
  assert.equal(judgePreviewUrl({ status: 302, location: 'https://myteam.cloudflareaccess.com/cdn-cgi/access/login/x', text: '' }).status, 'fail', '被 Access 擋著，但網址是開著的');
  // 回應的內容看不出來，但帶著這個專案的標頭（例如 Worker 自己回的 503、404、500）：一樣是連得到 Worker
  for (const [status, text] of [[503, 'Unavailable: secrets are not configured'], [503, 'Unavailable'], [500, 'Error'], [404, 'Not found'], [405, 'Method not allowed'], [303, '']]) {
    const verdict = judgePreviewUrl({ status, location: '', text, headers: projectHeaders() });
    assert.equal(verdict.status, 'fail', `帶著專案標頭的 HTTP ${status}`);
    assert.match(verdict.detail, /回應來自這個專案的 Worker/);
  }
  assert.equal(hasProjectHeaders(projectHeaders()), true);
  assert.equal(hasProjectHeaders(projectHeaders({ connect: true })), true, '登入後頁面的標頭（多了 connect-src）也認得');
  assert.equal(hasProjectHeaders({ 'content-security-policy': "default-src 'none'", 'x-robots-tag': 'noindex' }), false, '別人的網站剛好有幾個類似的標頭不算');
  assert.equal(hasProjectHeaders({}), false);
  assert.equal(hasProjectHeaders(undefined), false);

  // Codex 複核指出的兩個案例：503 與 429 以前被算成通過
  for (const status of [503, 429]) {
    const verdict = judgePreviewUrl({ status, location: '', text: status === 503 ? 'Service Unavailable' : 'Too Many Requests' });
    assert.equal(verdict.status, 'unknown', `preview：HTTP ${status}`);
    assert.match(verdict.detail, /請到後台確認 Preview URLs 是關閉的/);
  }
  assert.match(judgePreviewUrl({ status: 429, location: '', text: '' }).detail, /被限速/);
  assert.match(judgePreviewUrl({ status: 503, location: '', text: '' }).detail, /伺服器錯誤/);
  // 其他的 5xx、沒有驗證過的轉址、看不出是誰拒絕的回應：都不能當成「已經關閉」
  for (const status of [500, 502, 504, 520, 522, 530]) { assert.equal(judgePreviewUrl({ status, location: '', text: 'error' }).status, 'unknown', `HTTP ${status}`); }
  for (const [status, location] of [[301, 'https://example.com/'], [302, 'https://ayaka-room.example.workers.dev/'], [302, '/somewhere'], [307, ''], [308, 'http://myteam.cloudflareaccess.com/x'],
    [302, 'https://myteam.cloudflareaccess.com.evil.example/login'], [302, 'https://evil.example/?next=myteam.cloudflareaccess.com']]) {
    const verdict = judgePreviewUrl({ status, location, text: '' });
    assert.equal(verdict.status, 'unknown', `HTTP ${status} → ${location}`);
    assert.match(verdict.detail, /沒有跟著轉址/);
  }
  assert.match(judgePreviewUrl({ status: 301, location: 'https://example.com/x', text: '' }).detail, /轉到 example\.com/);
  // 平台的「這裡沒有東西」頁面：和「已經關閉」相符，但版本編號不存在時也是它 → 無法判定，不是通過
  for (const text of ['There is nothing here yet', 'error code: 1042', 'Not found', '']) {
    const verdict = judgePreviewUrl({ status: 404, location: '', text });
    assert.equal(verdict.status, 'unknown', `404：${text}`);
    assert.match(verdict.detail, /版本編號不存在/);
  }
  for (const status of [400, 401, 403, 410, 451]) { assert.equal(judgePreviewUrl({ status, location: '', text: 'denied' }).status, 'unknown', `HTTP ${status}`); }
  assert.equal(judgePreviewUrl({ status: 200, location: '', text: 'some other page' }).status, 'unknown');
  assert.equal(judgePreviewUrl({ status: 204, location: '', text: '' }).status, 'unknown');
  assert.equal(judgePreviewUrl({ error: 'ENOTFOUND' }).status, 'unknown');
  // 沒有任何一種回應會被判成通過
  for (let status = 100; status <= 599; status++) {
    for (const location of ['', 'https://example.com/', 'https://myteam.cloudflareaccess.com/login']) {
      assert.notEqual(judgePreviewUrl({ status, location, text: '' }).status, 'pass', `HTTP ${status} ${location}`);
    }
  }
});

test('儲存桶公開網址的判定：拿得到圖片就是沒通過；其他回應一律「無法判定」，不會回報通過', () => {
  // 沒通過：不用登入就拿到圖片（這一條維持原樣）
  assert.equal(judgeBucketUrl({ status: 200, jpeg: true, type: 'image/jpeg' }).status, 'fail');
  assert.equal(judgeBucketUrl({ status: 200, jpeg: true, type: 'application/octet-stream' }).status, 'fail', '類型不對，但內容是 JPEG');
  assert.equal(judgeBucketUrl({ status: 200, jpeg: false, type: 'image/webp' }).status, 'fail');
  assert.equal(judgeBucketUrl({ status: 206, jpeg: true, type: 'image/jpeg' }).status, 'fail', '只拿到一部分也算拿到');
  // Codex 複核指出的兩個案例：503、以及 302 轉到另一個圖片網址，以前被算成通過
  const busy = judgeBucketUrl({ status: 503, location: '', type: 'text/html', jpeg: false });
  assert.equal(busy.status, 'unknown', 'bucket：HTTP 503');
  assert.match(busy.detail, /伺服器錯誤/);
  const moved = judgeBucketUrl({ status: 302, location: 'https://pub-0123456789abcdef0123456789abcdef.r2.dev/photos/x/full.jpg', type: '', jpeg: false });
  assert.equal(moved.status, 'unknown', 'bucket：HTTP 302 → 另一個圖片網址');
  assert.match(moved.detail, /轉到 pub-0123456789abcdef0123456789abcdef\.r2\.dev：沒有跟著轉址/);
  // 其他不確定的回應
  assert.equal(judgeBucketUrl({ status: 429, location: '', type: 'text/plain', jpeg: false }).status, 'unknown');
  for (const status of [500, 502, 504, 522]) { assert.equal(judgeBucketUrl({ status, location: '', type: 'text/html', jpeg: false }).status, 'unknown', `HTTP ${status}`); }
  for (const status of [301, 303, 307, 308]) { assert.equal(judgeBucketUrl({ status, location: 'https://example.com/a.jpg', type: '', jpeg: false }).status, 'unknown', `HTTP ${status}`); }
  // 被拒絕、找不到：拿不到檔案不等於公開入口是關的（網址或路徑打錯也拿不到）
  const denied = judgeBucketUrl({ status: 401, jpeg: false, type: 'text/html' });
  assert.equal(denied.status, 'unknown');
  assert.match(denied.detail, /wrangler r2 bucket dev-url get/);
  assert.equal(judgeBucketUrl({ status: 403, jpeg: false, type: 'text/html' }).status, 'unknown');
  const missing = judgeBucketUrl({ status: 404, jpeg: false, type: 'text/html' });
  assert.equal(missing.status, 'unknown');
  assert.match(missing.detail, /可能表示公開網址是開著的、只是路徑不對/);
  assert.equal(judgeBucketUrl({ status: 200, jpeg: false, type: 'application/octet-stream' }).status, 'unknown');
  assert.equal(judgeBucketUrl({ error: 'ECONNREFUSED' }).status, 'unknown');
  for (let status = 100; status <= 599; status++) {
    assert.notEqual(judgeBucketUrl({ status, location: 'https://example.com/a.jpg', type: 'text/html', jpeg: false }).status, 'pass', `HTTP ${status}`);
  }
});

test('同一類的另外三項判定：開發工具的檢視網址、換密碼後的舊密碼、登入的限速——被限速或伺服器錯誤不算通過', () => {
  // 開發工具的檢視網址
  assert.equal(judgeNoExplorer({ status: 404, text: 'Not found' }).status, 'pass');
  for (const status of [400, 401, 403, 405, 410]) { assert.equal(judgeNoExplorer({ status, text: '' }).status, 'pass', `HTTP ${status}`); }
  assert.equal(judgeNoExplorer({ status: 200, text: '{"success": true, "result": []}' }).status, 'fail');
  for (const status of [429, 500, 502, 503, 302, 301, 204]) { assert.equal(judgeNoExplorer({ status, text: '' }).status, 'unknown', `HTTP ${status}`); }
  assert.equal(judgeNoExplorer({ status: 200, text: '<html>something else</html>' }).status, 'unknown');
  // 換密碼後用舊密碼登入
  assert.equal(judgeOldPassword({ status: 401, signedIn: false }).status, 'pass');
  assert.equal(judgeOldPassword({ status: 303, signedIn: true }).status, 'fail');
  for (const status of [429, 500, 503, 403, 400, 302, 303, 200]) {
    const verdict = judgeOldPassword({ status, signedIn: false });
    assert.equal(verdict.status, 'unknown', `HTTP ${status}`);
    assert.match(verdict.detail, /無法確認舊密碼已經失效/);
  }
  // 登入的限速：要先看到「密碼不對」、然後才開始被擋，才算通過
  assert.equal(judgeLoginRate([401, 401, 401, 401, 401, 429, 429]).status, 'pass');
  assert.equal(judgeLoginRate([401, 401, 401, 401, 429, 429, 429]).status, 'pass', '這個 IP 先前已經錯過一次');
  assert.equal(judgeLoginRate([401, 429, 429, 429, 429, 429, 429]).status, 'pass');
  assert.equal(judgeLoginRate([401, 401, 401, 401, 401, 429, 429]).detail, '401 → 401 → 401 → 401 → 401 → 429 → 429');
  // 一開始就是 429（以前算通過）：可能這個 IP 本來就在限速中，也可能是平台在擋 → 無法判定
  const limitedFromStart = judgeLoginRate([429, 429, 429, 429, 429, 429, 429]);
  assert.equal(limitedFromStart.status, 'unknown');
  assert.match(limitedFromStart.detail, /第一次嘗試就被限速/);
  // 伺服器錯誤、登入沒有被受理：無法判定
  for (const statuses of [[503, 503, 503, 503, 503, 503, 503], [401, 401, 500, 429, 429, 429, 429], [401, 401, 401, 401, 401, 429, 502], [403, 403, 403, 403, 403, 403, 403],
    [401, 401, 403, 401, 401, 429, 429], [403, 429, 429, 429, 429, 429, 429], [401, 401, 401, 401, 401, 429, 403], []]) {
    assert.equal(judgeLoginRate(statuses).status, 'unknown', statuses.join(','));
  }
  // 沒有被擋、太晚才擋、擋了之後又放行：沒通過
  assert.equal(judgeLoginRate([401, 401, 401, 401, 401, 401, 401]).status, 'fail');
  assert.equal(judgeLoginRate([401, 401, 401, 401, 401, 401, 429]).status, 'fail', '錯超過 5 次才被擋');
  assert.equal(judgeLoginRate([401, 401, 401, 401, 401, 429, 401]).status, 'fail', '被擋之後又受理');
  assert.equal(judgeLoginRate([401, 401, 429, 303, 429, 429, 429]).status, 'fail', '被擋之後竟然登入成功');
});

/* ---------- 對本機的測試環境跑完整的檢查 ---------- */

test('本機測試環境：用真實的測試圖走完登入、登出、撤銷、換密碼與回覆，全部通過', async () => {
  let fresh = null, marker = null;
  const actions = [];
  const run = await runChecks({ visitor: env.stack.visitorUrl, admin: env.stack.adminUrl, local: true, photoId: env.photoIds[0], password: env.password, reply: true }, {
    act: async (kind) => {
      actions.push(kind);
      if (kind === 'revoke') { assert.equal((await env.admin.post('/access/revoke', { csrf: await adminCsrf(env.admin) })).status, 303); }
      if (kind === 'rotate') { fresh = await generateVisitorPassword(env.admin); }
      return true;
    },
    newPassword: async () => fresh,
    confirm: async (question) => {
      // 腳本把同一則送了三次（其中一次是重新登入之後送的）：收件匣裡要剛好一則
      marker = /「(check-[a-f0-9]{8})」/.exec(question)[1];
      const replies = JSON.parse((await env.admin.get('/export.json')).text).replies;
      return replies.filter((r) => r.body.includes(marker)).length === 1;
    },
  });
  env.password = fresh;
  assert.deepEqual(actions, ['revoke', 'rotate']);
  assert.deepEqual(run.results.filter((r) => r.status !== 'pass'), [], '沒有失敗，也沒有無法判定');
  for (const id of ['visitor.home', 'visitor.no-store', 'photo.anon', 'photo.forged', 'photo.signed-in', 'photo.no-store', 'photo.clean', 'photo.after-signed-in-read', 'photo.after-logout',
    'photo.after-revoke', 'photo.after-revoke.page', 'photo.relogin-after-revoke', 'photo.after-rotate', 'photo.old-password', 'photo.new-password', 'reply.stored', 'reply.dedupe', 'reply.dedupe-relogin', 'reply.inbox',
    'visitor.no-explorer',
    'admin.blocked/', 'admin.blocked/photo/:id/full', 'admin.fake-token', 'admin.post-anon', 'admin.visitor-cookie']) {
    assert.equal(statusOf(run, id), 'pass', id);
  }
  assert.ok(marker);
  // 本機沒有 https 與 Cloudflare Access：這兩項不檢查（也不會被記成通過）
  assert.equal(statusOf(run, 'visitor.plain-http'), 'missing');
  assert.equal(statusOf(run, 'admin.access-host'), 'missing');
  assert.deepEqual(run.manual.map((item) => item.title), MANUAL_ITEMS.map(([title]) => title));
  assert.ok(run.manual.some((item) => item.title.includes('MFA')) && run.manual.some((item) => item.title.includes('R2')) && run.manual.some((item) => item.title.includes('預覽網址'))
    && run.manual.some((item) => item.title.includes('CPU')) && run.manual.some((item) => item.title.includes('iPhone')) && run.manual.some((item) => item.title.includes('泡泡')));
  // 結果裡沒有密碼，也沒有登入憑證
  const dump = JSON.stringify(run);
  assert.ok(!dump.includes(fresh) && !dump.includes('__Host-room-session='));
});

test('沒有人在旁邊操作、或缺少資訊時：需要人手的項目是「無法判定」', async () => {
  // 沒有密碼：只做得到「沒登入拿不到」
  const noPassword = await runChecks({ visitor: env.stack.visitorUrl, local: true, photoId: env.photoIds[1] });
  assert.equal(statusOf(noPassword, 'photo.anon'), 'pass');
  assert.equal(statusOf(noPassword, 'photo.signed-in'), 'unknown');
  assert.equal(noPassword.counts.fail, 0);
  // 有密碼、但沒有人去管理頁按按鈕
  const unattended = await runChecks({ visitor: env.stack.visitorUrl, admin: env.stack.adminUrl, local: true, photoId: env.photoIds[1], password: env.password, reply: true });
  assert.equal(statusOf(unattended, 'photo.after-logout'), 'pass');
  assert.equal(statusOf(unattended, 'photo.after-revoke'), 'unknown');
  assert.equal(statusOf(unattended, 'photo.after-rotate'), 'unknown');
  assert.equal(statusOf(unattended, 'reply.stored'), 'pass');
  assert.equal(statusOf(unattended, 'reply.dedupe-relogin'), 'pass');
  assert.equal(statusOf(unattended, 'reply.inbox'), 'unknown');
  // 沒有人看收件匣，但資料庫裡確實只有一筆（三次送出、其中一次在重新登入之後）
  const stored = JSON.parse((await env.admin.get('/export.json')).text).replies.filter((r) => r.body.includes('check_deployed'));
  assert.equal(new Set(stored.map((r) => r.body)).size, stored.length, '每一則測試回覆都只存了一筆');
  assert.equal(unattended.counts.fail, 0);
  assert.ok(unattended.counts.unknown >= 3);
  // 照片編號不存在：登入後拿不到 → 沒通過，並提示檢查編號
  const wrongId = await runChecks({ visitor: env.stack.visitorUrl, local: true, photoId: 'f'.repeat(32), password: env.password });
  assert.equal(statusOf(wrongId, 'photo.signed-in'), 'fail');
  assert.ok(byId(wrongId)['photo.signed-in'].detail.includes('--photo-id'));
  // 密碼不對
  const wrongPassword = await runChecks({ visitor: env.stack.visitorUrl, local: true, photoId: env.photoIds[1], password: '0000-0000-0000-0000-0000-0000-0000-0000' });
  assert.equal(statusOf(wrongPassword, 'photo.signed-in'), 'fail');
  // 清掉這幾次測試留下的回覆與限速紀錄
  assert.equal((await env.admin.post('/access/unlock', { csrf: await adminCsrf(env.admin) })).status, 303);
});

test('限速的檢查（本機測試環境）：先是「密碼不對」、再被擋才算通過；這個 IP 已經在限速中時再跑一次，是無法判定', async () => {
  await awayFromWindowEdge();
  const unlock = async () => assert.equal((await env.admin.post('/access/unlock', { csrf: await adminCsrf(env.admin) })).status, 303);
  await unlock();
  const first = await runChecks({ visitor: env.stack.visitorUrl, local: true, rate: true });
  assert.equal(statusOf(first, 'rate.login'), 'pass', byId(first)['rate.login'].detail);
  assert.equal(byId(first)['rate.login'].detail, '401 → 401 → 401 → 401 → 401 → 429 → 429');
  // 馬上再跑一次：第一次嘗試就是 429。以前這樣也算通過；現在是無法判定，並提示先清除限速紀錄
  const again = await runChecks({ visitor: env.stack.visitorUrl, local: true, rate: true });
  assert.equal(statusOf(again, 'rate.login'), 'unknown');
  assert.match(byId(again)['rate.login'].detail, /^429 → 429 → 429 → 429 → 429 → 429 → 429：第一次嘗試就被限速/);
  await unlock();
});

/** 不管問什麼都回同一個狀態碼的服務 */
async function startUniform(status) {
  const port = await freePort();
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(status, status === 302 ? { Location: 'https://example.com/' } : { 'Content-Type': 'text/plain' }); res.end(status === 200 ? 'hello' : 'x'); });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { url: `http://localhost:${port}`, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

test('整個服務對任何請求都回同一種回應（伺服器錯誤、被限速、轉址、不相干的頁面）：沒有任何一項被算成通過', async () => {
  const everything = (base, local) => ({ visitor: base, admin: base, teamDomain: 'myteam', local, photoId: PHOTO_ID, password: GOOD_PASSWORD, reply: true, rate: true, previewUrls: [base + '/'], bucketUrl: base + '/x.jpg' });
  const io = { act: async () => true, confirm: async () => null, newPassword: async () => '9999-8888-7777-6666-5555-4444-3333-2222' };
  for (const status of [500, 502, 503, 429, 302, 200]) {
    const service = await startUniform(status);
    try {
      for (const local of [true, false]) {
        const run = await runChecks(everything(service.url, local), io);
        assert.deepEqual(run.results.filter((r) => r.status === 'pass').map((r) => r.id), [], `HTTP ${status}（local=${local}）不可以有任何一項通過`);
        assert.ok(run.counts.fail + run.counts.unknown >= 30, `HTTP ${status}`);
      }
    } finally { await service.close(); }
  }
  // 整個服務都回「拒絕」或「找不到」時，只有「確認某個東西不存在／不受理」的項目會通過；首頁、登入後才拿得到的東西都不會
  const allowed = {
    404: /^visitor\.no-route\/|^visitor\.no-explorer$/,
    403: /^visitor\.login-(no-origin|cross|no-csrf)$|^visitor\.no-explorer$|^admin\.(blocked\/|fake-token$|post-anon$|visitor-cookie$)/,
    401: /^visitor\.fake-photo\.|^visitor\.no-explorer$|^photo\.(anon|forged)$|^admin\.(blocked\/|fake-token$|post-anon$|visitor-cookie$)/,
  };
  for (const [status, pattern] of Object.entries(allowed)) {
    const service = await startUniform(Number(status));
    try {
      const run = await runChecks(everything(service.url, false), io);
      const passed = run.results.filter((r) => r.status === 'pass').map((r) => r.id);
      assert.deepEqual(passed.filter((id) => !pattern.test(id)), [], `HTTP ${status}：不該通過的項目`);
      for (const id of ['visitor.home', 'photo.signed-in', 'rate.login', 'admin.access-host', 'preview.1', 'bucket.public']) { assert.notEqual(statusOf(run, id), 'pass', `HTTP ${status}：${id}`); }
      assert.ok(run.counts.fail >= 10, `HTTP ${status}`);
    } finally { await service.close(); }
  }
});

test('完全連不上的網址：每一項都是「無法判定」，沒有任何一項被算成通過', async () => {
  const port = await freePort();
  const run = await runChecks({ visitor: `https://127.0.0.1:${port}`, admin: `https://127.0.0.1:${port}`, teamDomain: 'myteam', photoId: 'a'.repeat(32), password: 'x', reply: true, rate: true });
  assert.equal(run.counts.pass, 0);
  assert.equal(run.counts.fail, 0);
  assert.ok(run.counts.unknown >= 4, JSON.stringify(run.counts));
  assert.equal(statusOf(run, 'visitor.plain-http'), 'unknown');
});

/* ---------- 故意做錯的假服務：每一種錯都要被抓到 ---------- */

const PHOTO_ID = 'c'.repeat(32);
const GOOD_PASSWORD = '1111-2222-3333-4444-5555-6666-7777-8888';       // 假服務用的測試值

/**
 * 一個長得像訪客端的假服務。flaws 是它故意做錯的地方。
 * fault：{ at, status }——第 at 個請求（從 1 算起）不照常處理，直接回 status（模擬「剛好那一次被限速或伺服器出錯」）
 */
async function startFlawed(flaws = [], fault = null) {
  const flawed = (name) => flaws.includes(name);
  const sessions = new Set();
  let password = GOOD_PASSWORD, counter = 0, readBySomeone = false, requests = 0;
  const clean = readFileSync(fixturePath('sample-1-thumb.jpg')), dirty = readFileSync(fixturePath('with-metadata.jpg'));
  const port = await freePort();
  const headers = (extra = {}) => ({ 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'", 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex', 'Strict-Transport-Security': 'max-age=1', 'Referrer-Policy': 'same-origin', ...extra });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const cookie = /__Host-room-session=([^;]+)/.exec(req.headers.cookie || '');
    const signedIn = !!cookie && sessions.has(cookie[1]);
    const send = (status, body, extra = {}) => { res.writeHead(status, headers(extra)); res.end(req.method === 'HEAD' ? undefined : body); };
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests += 1;
      if (fault && requests === fault.at) { res.writeHead(fault.status, { 'Content-Type': 'text/plain' }); return res.end(req.method === 'HEAD' ? undefined : 'temporary failure'); }
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const photo = /^\/photo\/([a-f0-9]{32})\/(thumb|full)$/.exec(url.pathname);
      if (photo) {
        const leak = flawed('open') || (flawed('cached-after-read') && readBySomeone) || (flawed('query-bypass') && url.search) || (flawed('range-bypass') && req.headers.range) || (flawed('head-leak') && req.method === 'HEAD');
        if (!signedIn && !leak) { return send(401, 'Unauthorized', { 'Content-Type': 'text/plain' }); }
        if (photo[1] !== PHOTO_ID) { return send(404, 'Not found', { 'Content-Type': 'text/plain' }); }
        if (signedIn) { readBySomeone = true; }
        const extra = { 'Content-Type': 'image/jpeg' };
        if (flawed('cacheable')) { extra['Cache-Control'] = 'public, max-age=3600'; }
        if (flawed('cached-after-read') && !signedIn) { extra['CF-Cache-Status'] = 'HIT'; }
        return send(200, flawed('dirty-photo') ? dirty : clean, extra);
      }
      if (req.method === 'POST' && req.headers.origin !== `http://localhost:${port}`) { return send(403, 'Forbidden'); }
      if (url.pathname === '/login' && req.method === 'POST') {
        if (form.get('csrf') !== 'login-csrf') { return send(403, 'gate <form action="/login">'); }
        if (form.get('password') !== password) { return send(flawed('wrong-password-429') ? 429 : (flawed('wrong-password-503') ? 503 : 401), 'gate <form action="/login">'); }
        const id = `session-${++counter}`;
        sessions.add(id);
        return send(303, '', { Location: '/', 'Set-Cookie': `__Host-room-session=${id}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600` });
      }
      if (url.pathname === '/logout' && req.method === 'POST') {
        if (cookie && !flawed('logout-keeps-session')) { sessions.delete(cookie[1]); }
        return send(303, '', { Location: '/?out=1', 'Set-Cookie': '__Host-room-session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0' });
      }
      if (url.pathname === '/reply' && req.method === 'POST') {
        if (!signedIn) { return send(401, 'gate <form action="/login">'); }
        return send(200, JSON.stringify({ ok: true, nonce: 'n' }), { 'Content-Type': 'application/json' });
      }
      if (url.pathname === '/') {
        if (signedIn) { return send(200, '<form data-reply-form><input name="csrf" value="reply-csrf"><input name="nonce" value="nonce-1"></form>'); }
        return send(200, '<form action="/login"><input name="csrf" value="login-csrf"></form>', { 'Set-Cookie': '__Host-room-csrf=login-csrf; Path=/; Secure; HttpOnly; SameSite=Strict' });
      }
      if (url.pathname.startsWith('/cdn-cgi/local/explorer/')) {
        if (flawed('explorer-open')) { return send(200, '{"success":true,"result":[{"name":"ayaka-room"}]}', { 'Content-Type': 'application/json' }); }
        if (flawed('explorer-503')) { return send(503, 'Service Unavailable'); }
        if (flawed('explorer-429')) { return send(429, 'Too Many Requests'); }
      }
      return send(404, 'Not found');
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://localhost:${port}`,
    requests: () => requests,
    revoke: () => { if (!flawed('revoke-noop')) { sessions.clear(); } },
    rotate: () => { if (!flawed('rotate-keeps-sessions')) { sessions.clear(); } if (!flawed('rotate-keeps-password')) { password = '9999-8888-7777-6666-5555-4444-3333-2222'; } return '9999-8888-7777-6666-5555-4444-3333-2222'; },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

async function checkFlawed(flaws, fault = null) {
  const service = await startFlawed(flaws, fault);
  try {
    let fresh = null;
    const run = await runChecks({ visitor: service.url, local: true, photoId: PHOTO_ID, password: GOOD_PASSWORD, reply: true }, {
      act: async (kind) => { if (kind === 'revoke') { service.revoke(); } else { fresh = service.rotate(); } return true; },
      newPassword: async () => fresh,
      confirm: async () => true,
    });
    run.requests = service.requests();
    return run;
  } finally { await service.close(); }
}

test('假服務（沒有故意做錯的地方）：測試圖的每一項都通過——確認假服務本身和檢查對得上', async () => {
  const run = await checkFlawed([]);
  assert.deepEqual(run.results.filter((r) => r.section === '測試圖' && r.status !== 'pass'), []);
  assert.ok(run.results.filter((r) => r.section === '測試圖').length >= 12);
});

/** 假服務故意做錯的每一種情況：[說明, 做錯的地方, 應該因此沒通過的項目] */
const FLAW_CASES = [
  ['照片不用登入就拿得到', ['open'], ['photo.anon', 'photo.forged', 'photo.after-signed-in-read', 'photo.after-logout', 'photo.after-revoke', 'photo.after-rotate']],
  ['登入的人讀過之後，沒登入的人也拿得到（被共用的快取記住）', ['cached-after-read'], ['photo.after-signed-in-read', 'photo.after-logout']],
  ['網址加上參數就繞過檢查', ['query-bypass'], ['photo.after-signed-in-read']],
  ['帶 Range 標頭就繞過檢查', ['range-bypass'], ['photo.after-signed-in-read']],
  ['HEAD 請求不檢查登入', ['head-leak'], ['photo.after-signed-in-read']],
  ['圖片的回應可以被快取', ['cacheable'], ['photo.no-store']],
  ['存下來的檔案帶著 Exif 等資料', ['dirty-photo'], ['photo.clean']],
  ['登出後舊的 cookie 還能用', ['logout-keeps-session'], ['photo.after-logout']],
  ['撤銷沒有作用', ['revoke-noop'], ['photo.after-revoke', 'photo.after-revoke.page']],
  ['換密碼後舊的登入還能用', ['rotate-keeps-sessions'], ['photo.after-rotate']],
  ['換密碼後舊密碼還能登入', ['rotate-keeps-password'], ['photo.old-password']],
  ['開發工具的檢視網址有回應', ['explorer-open'], ['visitor.no-explorer']],
];

test('故意做錯的假服務：每一種錯都會被判定為沒通過', async () => {
  for (const [name, flaws, expected] of FLAW_CASES) {
    const run = await checkFlawed(flaws);
    for (const id of expected) { assert.equal(statusOf(run, id), 'fail', `${name}：${id} 應該沒通過`); }
    assert.ok(run.counts.fail >= expected.length, name);
  }
});

test('檢查的途中剛好有一個請求被限速或伺服器出錯：原本抓得到的問題不會因此被判成通過', async (t) => {
  // 對每一種做錯的假服務，輪流讓「第 k 個請求」（每一個位置都試）改回 503 或 429，再跑一次檢查：
  // 原本該沒通過的項目可以變成「無法判定」（或沒有執行到），但不可以變成「通過」——暫時的錯誤不能把問題蓋掉
  let runs = 0;
  for (const [name, flaws, expected] of FLAW_CASES) {
    const baseline = await checkFlawed(flaws);
    assert.ok(baseline.requests > 40, `${name}：請求數 ${baseline.requests}`);
    for (let at = 1; at <= baseline.requests; at++) {
      for (const status of [503, 429]) {
        const run = await checkFlawed(flaws, { at, status });
        runs += 1;
        for (const id of expected) {
          assert.notEqual(statusOf(run, id), 'pass', `${name}：第 ${at} 個請求回 ${status} 時，${id} 被判成通過（${(byId(run)[id] || {}).detail || ''}）`);
        }
      }
    }
  }
  t.diagnostic(`試了 ${runs} 種「某一個請求出錯」的情況`);
  assert.ok(runs > 1500);
});

test('假服務回「被限速」或「伺服器錯誤」：那一項是無法判定，不是通過', async () => {
  // 換密碼之後用舊密碼登入，得到的是 429／503 而不是「密碼不對」：不能證明舊密碼已經失效
  for (const flaw of ['wrong-password-429', 'wrong-password-503']) {
    const run = await checkFlawed([flaw]);
    assert.equal(statusOf(run, 'photo.old-password'), 'unknown', flaw);
    assert.equal(statusOf(run, 'photo.after-rotate'), 'pass', flaw);
    assert.equal(statusOf(run, 'photo.new-password'), 'pass', flaw);
  }
  // 開發工具的檢視網址回 503／429：不能證明它不存在
  for (const flaw of ['explorer-503', 'explorer-429']) {
    const run = await checkFlawed([flaw]);
    assert.equal(statusOf(run, 'visitor.no-explorer'), 'unknown', flaw);
  }
  assert.equal(statusOf(await checkFlawed([]), 'visitor.no-explorer'), 'pass');
  assert.equal(statusOf(await checkFlawed([]), 'photo.old-password'), 'pass');
});

/** 一個可以指定每個路徑怎麼回應的小服務：用來模擬「其他入口」各種看不出結果的回應 */
async function startOddities() {
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const image = readFileSync(fixturePath('sample-1-thumb.jpg'));
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    const send = (status, headers, body = '') => { res.writeHead(status, headers); res.end(body); };
    const routes = {
      '/busy': () => send(503, { 'Content-Type': 'text/plain' }, 'Service Unavailable'),
      '/limited': () => send(429, { 'Content-Type': 'text/plain', 'Retry-After': '60' }, 'Too Many Requests'),
      '/gone': () => send(404, { 'Content-Type': 'text/plain' }, 'error code: 1042'),
      '/denied': () => send(401, { 'Content-Type': 'text/html' }, '<h1>Error 401</h1><p>You are not authorized to view this bucket</p>'),
      '/forbidden': () => send(403, { 'Content-Type': 'text/html' }, '<h1>Access denied</h1>'),
      '/moved-to-image': () => send(302, { Location: `${base}/image.jpg` }),
      '/loop': () => send(302, { Location: `${base}/loop` }),
      '/image.jpg': () => send(200, { 'Content-Type': 'image/jpeg' }, image),
      '/ours-503': () => send(503, { ...baseHeaders(), 'Content-Type': 'text/plain; charset=utf-8' }, 'Unavailable'),
      '/access': () => send(302, { Location: 'https://myteam.cloudflareaccess.com/cdn-cgi/access/login/x?kid=abc' }),
      '/other-page': () => send(200, { 'Content-Type': 'text/html' }, '<h1>Welcome</h1>'),
    };
    (routes[new URL(req.url, base).pathname] || (() => send(404, { 'Content-Type': 'text/plain' }, 'Not found')))();
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { base, hits: () => hits, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

test('其他入口（實際送請求）：503、429、轉址、被拒絕、找不到都是無法判定；連得到 Worker、拿得到圖片才是沒通過；沒有一項會被算成通過', async () => {
  const service = await startFlawed([]);
  const odd = await startOddities();
  try {
    const previews = ['/busy', '/limited', '/gone', '/denied', '/forbidden', '/moved-to-image', '/other-page', '/ours-503', '/access'];
    const run = await runChecks({ visitor: service.url, local: true, previewUrls: previews.map((path) => odd.base + path), bucketUrl: odd.base + '/busy' });
    const got = Object.fromEntries(previews.map((path, index) => [path, statusOf(run, `preview.${index + 1}`)]));
    assert.deepEqual(got, {
      '/busy': 'unknown', '/limited': 'unknown', '/gone': 'unknown', '/denied': 'unknown', '/forbidden': 'unknown', '/moved-to-image': 'unknown', '/other-page': 'unknown',
      '/ours-503': 'fail', '/access': 'fail',
    });
    assert.match(byId(run)['preview.8'].detail, /回應來自這個專案的 Worker/);
    assert.equal(statusOf(run, 'bucket.public'), 'unknown', 'bucket：503');
    assert.equal(run.results.filter((r) => r.section === '其他入口' && r.status === 'pass').length, 0);

    const bucket = async (path) => byId(await runChecks({ visitor: service.url, local: true, bucketUrl: odd.base + path }))['bucket.public'];
    assert.equal((await bucket('/image.jpg')).status, 'fail', '不用登入就拿到圖片');
    const moved = await bucket('/moved-to-image');
    assert.equal(moved.status, 'unknown', '302 轉到另一個圖片網址：沒有驗證過，不算通過');
    assert.match(moved.detail, /沒有跟著轉址/);
    for (const path of ['/limited', '/denied', '/forbidden', '/gone', '/loop', '/other-page', '/no-such-path']) { assert.equal((await bucket(path)).status, 'unknown', path); }
    // 轉址沒有被跟隨：/image.jpg 只被直接要過那一次
    const before = odd.hits();
    await bucket('/moved-to-image');
    await bucket('/loop');
    assert.equal(odd.hits(), before + 2, '每個網址只送一個請求，不跟著轉址走');
  } finally {
    await service.close();
    await odd.close();
  }
});

test('不是本機模式時：用 http 就拿得到頁面、管理端轉到別的網域，都會被判定為沒通過', async () => {
  const service = await startFlawed([]);
  const port = await freePort();
  let location = 'https://otherteam.cloudflareaccess.com/cdn-cgi/access/login/x?kid=abc';
  const adminLike = http.createServer((req, res) => { res.writeHead(302, { Location: location }); res.end(); });
  await new Promise((resolve) => adminLike.listen(port, '127.0.0.1', resolve));
  try {
    const admin = `http://localhost:${port}`;
    const wrongTeam = await runChecks({ visitor: service.url, admin, teamDomain: 'myteam.cloudflareaccess.com' });
    assert.equal(statusOf(wrongTeam, 'visitor.plain-http'), 'fail', '用 http 連線直接拿到登入頁');
    assert.equal(statusOf(wrongTeam, 'admin.access-host'), 'fail', '轉到的不是預期的團隊網域');
    assert.equal(statusOf(wrongTeam, 'admin.blocked/'), 'fail');
    assert.equal(statusOf(await runChecks({ visitor: service.url, admin }), 'admin.access-host'), 'unknown', '沒有提供團隊網域：無法判定');
    location = 'https://evil.example/login?team=myteam.cloudflareaccess.com';
    const evil = await runChecks({ visitor: service.url, admin, teamDomain: 'myteam' });
    assert.equal(statusOf(evil, 'admin.access-host'), 'fail');
    assert.equal(statusOf(evil, 'admin.blocked/'), 'fail', '轉到別的網站不算「被 Access 擋下」');
    location = 'https://myteam.cloudflareaccess.com/cdn-cgi/access/login/x?kid=abc';
    const right = await runChecks({ visitor: service.url, admin, teamDomain: 'myteam', aud: 'abc' });
    assert.equal(statusOf(right, 'admin.access-host'), 'pass');
    assert.equal(statusOf(right, 'admin.blocked/'), 'pass');
    assert.equal(statusOf(await runChecks({ visitor: service.url, admin, teamDomain: 'myteam', aud: 'not-this-app' }), 'admin.access-host'), 'fail');
    // 其他入口：有人把「預覽網址」開著（打開就是訪客端）、儲存桶的公開網址拿得到檔案
    const open = await startFlawed(['open']);
    try {
      const closedPort = await freePort();
      const extras = await runChecks({ visitor: service.url, local: true, previewUrls: [service.url + '/', admin + '/', `http://localhost:${closedPort}/`, service.url + '/no-such-page'], bucketUrl: `${open.url}/photo/${PHOTO_ID}/full` });
      // 第 4 個網址是「有服務在、但回 404」：以前算通過；現在是無法判定（看不出是不是關閉了）
      assert.deepEqual(['preview.1', 'preview.2', 'preview.3', 'preview.4', 'bucket.public'].map((id) => statusOf(extras, id)), ['fail', 'fail', 'unknown', 'unknown', 'fail']);
      // 沒登入拿這張圖得到 401：拿不到，但不能證明公開入口是關的 → 無法判定
      assert.equal(statusOf(await runChecks({ visitor: service.url, local: true, bucketUrl: `${service.url}/photo/${PHOTO_ID}/full` }), 'bucket.public'), 'unknown');
    } finally { await open.close(); }
  } finally {
    await service.close();
    await new Promise((resolve) => { adminLike.closeAllConnections(); adminLike.close(resolve); });
  }
});

/* ---------- 命令列 ---------- */

function cli(args, envVars = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(ROOT, 'scripts', 'check_deployed.mjs'), ...args], { env: { ...process.env, ...envVars }, timeout: 120000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

test('命令列：沒有人操作時結束代碼是 2（有無法判定的項目）；最後列出要人確認的項目；密碼不會出現在輸出或報告裡', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'check-deployed-'));
  try {
    const report = path.join(dir, 'report.json');
    const run = await cli(['--visitor', env.stack.visitorUrl, '--admin', env.stack.adminUrl, '--local', '--photo-id', env.photoIds[2], '--no-prompt', '--report', report], { ROOM_TEST_PASSWORD: env.password });
    assert.equal(run.code, 2, run.stdout.slice(-600) + run.stderr);
    assert.match(run.stdout, /結果：通過 \d+ 項、沒通過 0 項、無法判定 [1-9]\d* 項/);
    assert.match(run.stdout, /？ 站主撤銷所有登入後，原本登入中的人拿不到/);
    assert.match(run.stdout, /仍然要由人確認的項目/);
    for (const item of ['管理端的多因素驗證（MFA）', 'R2 的公開入口', '預覽網址', 'CPU 用量', 'iPhone Safari', '泡泡']) { assert.ok(run.stdout.includes(item), item); }
    assert.ok(!run.stdout.includes(env.password) && !run.stderr.includes(env.password));
    const saved = readFileSync(report, 'utf8');
    assert.ok(!saved.includes(env.password) && !saved.includes('room-session='));
    const parsed = JSON.parse(saved);
    assert.equal(parsed.photo_checked, true);
    assert.equal(parsed.counts.fail, 0);
    assert.ok(parsed.results.length > 30 && parsed.manual.length === MANUAL_ITEMS.length);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('命令列：密碼不可以寫在參數裡；網址或照片編號不對時不會開始檢查', async () => {
  for (const args of [
    ['--visitor', env.stack.visitorUrl, '--local', '--password', 'x'],
    ['--visitor', 'http://example.com'],                                  // 正式環境一定是 https
    ['--visitor', 'https://example.com/some/path'],
    ['--visitor', env.stack.visitorUrl, '--local', '--photo-id', 'not-an-id'],
    ['--visitor', env.stack.visitorUrl, '--local', '--team-domain', 'evil.example'],
    [],
  ]) {
    const run = await cli(args);
    assert.equal(run.code, 64, args.join(' '));
    assert.match(run.stderr, /用法/);
  }
});
