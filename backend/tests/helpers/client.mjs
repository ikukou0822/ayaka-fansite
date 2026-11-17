// 測試用的小型 HTTP 用戶端：自己記 cookie（像瀏覽器一樣），不自動跟隨轉址，方便檢查每一步的回應。

import http from 'node:http';

export class Client {
  constructor(base, { headers = {} } = {}) {
    this.base = base;
    this.origin = new URL(base).origin;
    this.headers = headers;
    this.jar = new Map();
  }

  cookieHeader() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }

  remember(res) {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';').map((s) => s.trim());
      const i = pair.indexOf('=');
      const name = pair.slice(0, i), value = pair.slice(i + 1);
      const expired = attrs.some((a) => /^max-age=0$/i.test(a)) || value === '';
      if (expired) { this.jar.delete(name); } else { this.jar.set(name, value); }
    }
  }

  /** options: method, form（物件 → urlencoded）, body, headers, origin（預設帶本站的 Origin；傳 null 就不帶）, cookies（false 就不帶 cookie） */
  async request(path, options = {}) {
    const headers = { ...this.headers, ...(options.headers || {}) };
    const method = options.method || (options.form || options.body ? 'POST' : 'GET');
    if (options.cookies !== false && this.jar.size) { headers.Cookie = this.cookieHeader(); }
    let body = options.body;
    if (options.form) {
      body = new URLSearchParams(options.form).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    if (method !== 'GET' && method !== 'HEAD' && options.origin !== null) { headers.Origin = options.origin || this.origin; }
    const res = await fetch(this.base + path, { method, headers, body, redirect: 'manual' });
    if (options.cookies !== false) { this.remember(res); }
    const buffer = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, setCookie: res.headers.getSetCookie(), buffer, text: buffer.toString('utf8'), location: res.headers.get('location') };
  }

  get(path, options) { return this.request(path, options); }
  post(path, form, options = {}) { return this.request(path, { ...options, form }); }
}

export function field(html, name) {
  const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  return m ? m[1] : null;
}

/** 訪客登入（先開首頁拿到防偽造編號，再送出密碼）。回傳登入請求的回應 */
export async function visitorLogin(client, password) {
  const page = await client.get('/');
  const csrf = field(page.text, 'csrf');
  return client.post('/login', { csrf, password });
}

/** 已登入的訪客頁面上的表單欄位 */
export async function visitorForm(client) {
  const page = await client.get('/');
  return { page, csrf: field(page.text, 'csrf'), nonce: field(page.text, 'nonce') };
}

export function adminClient(stack, token) {
  return new Client(stack.adminUrl, { headers: token ? { 'Cf-Access-Jwt-Assertion': token } : {} });
}

export async function adminCsrf(client, path = '/access') {
  const page = await client.get(path);
  const m = /data-csrf="([a-f0-9]{64})"/.exec(page.text);
  if (!m) { throw new Error(`no csrf on ${path}: HTTP ${page.status}`); }
  return m[1];
}

/** 「密碼與登入」頁上換密碼表單的欄位：防偽造編號、這一頁顯示時的密碼版本 */
export async function accessForm(client) {
  const page = await client.get('/access');
  const csrf = /data-csrf="([a-f0-9]{64})"/.exec(page.text);
  const version = /name="version" value="(\d+)"/.exec(page.text);
  if (!csrf || !version) { throw new Error(`no access form: HTTP ${page.status}`); }
  return { csrf: csrf[1], version: version[1] };
}

/** 用管理頁產生一組新的訪客密碼，回傳密碼（只會出現在這一次的回應裡） */
export async function generateVisitorPassword(client) {
  const res = await client.post('/access/generate', await accessForm(client));
  const m = /data-new-password>([^<]+)</.exec(res.text);
  if (res.status !== 200 || !m) { throw new Error(`password generation failed: HTTP ${res.status}`); }
  return m[1];
}

/**
 * 用分塊傳輸（沒有 Content-Length）慢慢送出一個很大的 POST，看伺服器什麼時候回應。
 * 每 delayMs 送一塊，最多送 maxChunks 塊；伺服器一回應就停止。回傳 { status, body, chunksSent, completed }：
 * completed 是 false 表示「還沒送完，伺服器就已經回應了」——也就是伺服器沒有等著把整個內容讀完。
 */
export function streamPost(url, { headers = {}, chunkBytes = 16 * 1024, maxChunks = 200, delayMs = 15 } = {}) {
  return new Promise((resolve) => {
    const target = new URL(url);
    let sent = 0, timer = null, settled = false, completed = false;
    const req = http.request({ host: '127.0.0.1', port: target.port, path: target.pathname, method: 'POST',
      headers: { Host: target.host, Origin: target.origin, 'Transfer-Encoding': 'chunked', ...headers } });
    const finish = (result) => {
      if (settled) { return; }
      settled = true;
      clearInterval(timer);
      req.destroy();
      resolve({ ...result, chunksSent: sent, completed });
    };
    req.on('response', (res) => {
      const parts = [];
      res.on('data', (chunk) => parts.push(chunk));
      res.on('end', () => finish({ status: res.statusCode, body: Buffer.concat(parts).toString('utf8') }));
      res.on('error', () => finish({ status: res.statusCode, body: '' }));
    });
    req.on('error', (err) => finish({ status: null, body: '', error: err.code || err.message }));
    const chunk = Buffer.alloc(chunkBytes, 0x61);
    timer = setInterval(() => {
      if (sent >= maxChunks) { clearInterval(timer); completed = true; req.end(); return; }
      sent += 1;
      req.write(chunk);
    }, delayMs);
  });
}
