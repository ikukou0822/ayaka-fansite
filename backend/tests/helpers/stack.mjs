// 本機的受控測試環境：用 wrangler dev（和 Cloudflare 正式環境同一個執行引擎 workerd）把訪客端與管理端跑起來，
// 兩邊共用同一個本機資料庫與儲存桶；另外起一個「模擬 Cloudflare Access」的小伺服器，提供驗證管理者憑證用的公鑰。
// 這裡的金鑰與密碼都是每次執行時隨機產生的測試值，不是正式的。

import { spawn, execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

const run = promisify(execFile);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WRANGLER = path.join(ROOT, 'node_modules', '.bin', 'wrangler');
// X_LOCAL_EXPLORER／X_LOCAL_OBSERVABILITY：wrangler dev 預設會在同一個本機連接埠上多開一組「開發者檢視資料用」的網址
// （/cdn-cgi/local/explorer/…，不需要登入就能看本機的資料庫與儲存桶）。那是開發工具的功能，部署到 Cloudflare 之後不存在；
// 測試時把它關掉，讓本機環境只剩下 Worker 自己的網址。
export const WRANGLER_ENV = {
  ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0',
  X_LOCAL_EXPLORER: 'false', X_LOCAL_OBSERVABILITY: 'false',
};
const ENV = WRANGLER_ENV;

export const ADMIN_EMAIL = 'owner@example.test';
export const ACCESS_AUD = 'test-audience-0123456789abcdef0123456789abcdef';

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

/** 模擬 Cloudflare Access：只提供公鑰（/cdn-cgi/access/certs），並可以用對應的私鑰簽出測試用的管理者憑證 */
async function startMockAccess() {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const kid = 'test-' + randomBytes(6).toString('hex');
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const port = await freePort();
  const server = http.createServer((req, res) => {
    if (req.url === '/cdn-cgi/access/certs') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const issuer = `http://127.0.0.1:${port}`;
  /** 簽一個憑證。options 可以改掉任何一項，用來做「偽造／過期／對象不符」的測試 */
  const sign = async (options = {}) => {
    const claims = { email: options.email === undefined ? ADMIN_EMAIL : options.email, type: 'app' };
    if (claims.email === null) { delete claims.email; }
    const issuedAt = Math.floor(Date.now() / 1000) + (options.issuedOffset || 0);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: options.alg || 'RS256', kid: options.kid || kid })
      .setIssuer(options.issuer || issuer)
      .setAudience(options.audience || ACCESS_AUD)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + (options.lifetime || 300))
      .sign(options.key || privateKey);
  };
  return { issuer, kid, jwk, sign, close: () => new Promise((resolve) => server.close(resolve)) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function spawnWorker(name, args, logs) {
  const child = spawn(WRANGLER, ['dev', ...args, '--ip', '127.0.0.1', '--log-level', 'log', '--show-interactive-dev-session=false'],
    { cwd: ROOT, env: ENV, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = '';
  const collect = (chunk) => { child.output += chunk; logs.push(`[${name}] ${chunk}`); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  return child;
}

function stopWorker(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { return resolve(); }
    child.once('exit', resolve);
    try { process.kill(-child.pid, 'SIGTERM'); } catch (err) { resolve(); }
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (err) { /* 已經結束 */ } }, 4000).unref();
  });
}

/**
 * 啟動一個 Worker 並等它能回應，回傳 { child, url }。
 *
 * - 幾個本機程序共用同一份資料庫檔案，啟動的瞬間偶爾會搶不到檔案鎖（SQLITE_BUSY，只有本機模擬會遇到），
 *   所以一次啟動一個，失敗就重來。
 * - 每一次嘗試都換一組新的連接埠，而且要等到 wrangler 自己印出「Ready on …:<這個連接埠>」才算啟動：
 *   「先找一個空的連接埠、再交給 wrangler」之間有空檔，連接埠可能被別的程序（例如另一個 wrangler 的內部服務）搶先用掉；
 *   那時候對這個連接埠送請求，回應的會是別的服務。只看「有沒有回應」會把它誤認成已經啟動。
 */
export async function launchWorker(name, args, probePath, logs, pickPort = freePort) {
  const broken = /failed to start|SQLITE_BUSY|EADDRINUSE|Address already in use/i;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const port = await pickPort(), inspector = await freePort();
    const url = `http://localhost:${port}`;
    const child = spawnWorker(name, [...args, '--port', String(port), '--inspector-port', String(inspector)], logs);
    const announced = () => (/Ready on http:\/\/[^\s:]+:(\d+)/.exec(child.output) || [])[1];
    const deadline = Date.now() + 45000;
    let up = false;
    while (Date.now() < deadline && child.exitCode === null && !broken.test(child.output)) {
      const listening = announced();
      if (listening && listening !== String(port)) { break; }          // wrangler 改用了別的連接埠：這一次不算，重來
      if (listening) {
        try {
          const res = await fetch(url + probePath, { redirect: 'manual' });
          await res.arrayBuffer();
          if (res.status < 500) { up = true; break; }
        } catch (err) { /* 還沒起來 */ }
      }
      await sleep(200);
    }
    // 起來之後再確認一下沒有緊接著倒下
    if (up) { await sleep(300); if (child.exitCode === null && !broken.test(child.output)) { return { child, url }; } }
    await stopWorker(child);
    await sleep(400 * attempt);
  }
  throw new Error(`could not start ${name}\n` + logs.join('').slice(-4000));
}

/**
 * 啟動整個測試環境。
 * options.shortTtlSeconds：另外起一個「登入只有幾秒就過期」的訪客端（共用同一個資料庫），用來測登入過期
 * options.dir、options.secrets：沿用上一次的狀態目錄與金鑰（測「整個服務重新啟動後資料還在」）；不指定就用新的暫存目錄與新的隨機金鑰
 * 回傳的 stop({ remove }) 會結束所有程序；remove 預設 true（刪掉狀態目錄）
 */
export async function startStack(options = {}) {
  const dir = options.dir || await mkdtemp(path.join(os.tmpdir(), 'ayaka-room-test-'));
  const state = path.join(dir, 'state');
  const secrets = options.secrets || { PEPPER: randomBytes(32).toString('hex'), SESSION_SECRET: randomBytes(32).toString('hex') };
  const access = await startMockAccess();
  const envFile = async (name, vars) => {
    const file = path.join(dir, name);
    await writeFile(file, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
    return file;
  };

  await run(WRANGLER, ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state, '-c', 'visitor/wrangler.jsonc'], { cwd: ROOT, env: ENV });

  const logs = [];
  const children = [];
  const stop = async ({ remove = true } = {}) => {
    await Promise.all(children.map(stopWorker));
    await access.close();
    if (remove) { await rm(dir, { recursive: true, force: true }); }
  };
  /** 啟動一個 Worker，回傳它的網址（連接埠在啟動時才決定） */
  const start = async (name, config, vars, stateDir, probePath) => {
    const { child, url } = await launchWorker(name, ['-c', config, '--persist-to', stateDir, '--env-file', await envFile(`${name}.env`, vars)], probePath, logs);
    children.push(child);
    return url;
  };
  let visitorUrl, adminUrl, shortUrl = null, adminVars;
  try {
    visitorUrl = await start('visitor', 'visitor/wrangler.jsonc', { ...secrets, PUBLIC_SITE_URL: options.publicSiteUrl || 'http://127.0.0.1:9/' }, state, '/robots.txt');
    adminVars = { ...secrets, ENVIRONMENT: 'local', TEAM_DOMAIN: access.issuer, POLICY_AUD: ACCESS_AUD, ADMIN_EMAILS: ADMIN_EMAIL, VISITOR_URL: visitorUrl };
    adminUrl = await start('admin', 'admin/wrangler.jsonc', adminVars, state, '/');
    if (options.shortTtlSeconds) {
      shortUrl = await start('short', 'visitor/wrangler.jsonc', { ...secrets, SESSION_TTL_SECONDS: String(options.shortTtlSeconds || 2) }, state, '/robots.txt');
    }
  } catch (err) {
    await stop({ remove: !options.dir });
    throw err;
  }
  /**
   * 再起一個 Worker（訪客端或管理端），用自己的一組變數；預設共用同一份資料庫與儲存桶。
   * 用來測「設定不完整或服務出錯時，一律拒絕」：例如沒有金鑰的訪客端、Access 沒設定好的管理端。
   * options.vars 會完全取代預設的變數；options.state 可以指向另一個（例如空的）狀態目錄；options.config 可以換成另一份設定檔
   */
  let extraCount = 0;
  const launch = async (kind, options = {}) => {
    extraCount += 1;
    return start(`${kind}-extra-${extraCount}`, options.config || `${kind}/wrangler.jsonc`, options.vars || {}, options.state || state, kind === 'visitor' ? '/robots.txt' : '/');
  };
  /** 直接對本機的資料庫下一句 SQL（只給測試用：安排「資料庫裡被放進不該有的東西」這類情況）。回傳查到的列 */
  const sql = async (command) => {
    const { stdout } = await run(WRANGLER, ['d1', 'execute', 'DB', '--local', '--persist-to', state, '-c', 'visitor/wrangler.jsonc', '--json', '--command', command], { cwd: ROOT, env: ENV });
    return JSON.parse(stdout)[0].results;
  };
  return { dir, state, secrets, access, visitorUrl, adminUrl, shortUrl, logs, stop, launch, adminVars, sql };
}

/**
 * 模擬「Cloudflare Access 擋在管理端前面」：一個本機的轉送服務，替每個請求加上（測試用的）管理者憑證再轉給管理端。
 * 只用在本機的瀏覽器測試與預覽——正式環境裡這件事由 Cloudflare Access 做，登入與多因素驗證也在那裡。
 */
export async function startAccessProxy(stack) {
  const port = await freePort();
  const target = new URL(stack.adminUrl);
  const origin = `http://localhost:${port}`;
  const server = http.createServer(async (req, res) => {
    try {
      const headers = { ...req.headers, host: target.host, 'cf-access-jwt-assertion': await stack.access.sign() };
      if (headers.origin === origin) { headers.origin = target.origin; }
      const upstream = http.request({ host: '127.0.0.1', port: target.port, method: req.method, path: req.url, headers }, (reply) => {
        res.writeHead(reply.statusCode, reply.headers);
        reply.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) { res.writeHead(502); } res.end(); });
      req.pipe(upstream);
    } catch (err) {
      res.writeHead(500); res.end();
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { url: origin, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}
