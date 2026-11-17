// 兩個 Worker（訪客端、管理端）共用的小工具：雜湊、cookie、回應標頭、表單讀取。
// 只用 Workers 內建的 Web Crypto，沒有第三方程式庫。

const encoder = new TextEncoder();

export function now() { return Math.floor(Date.now() / 1000); }

/** 把文字放進 HTML 之前一定先經過這裡：訪客寫的任何內容都只會被當成文字顯示 */
export function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function toHex(bytes) {
  let out = '';
  for (const b of new Uint8Array(bytes)) { out += b.toString(16).padStart(2, '0'); }
  return out;
}

export function toBase64Url(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) { bin += String.fromCharCode(b); }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 隨機憑證（預設 32 bytes = 256 bit，base64url 43 個字） */
export function randomToken(bytes = 32) {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function randomHex(bytes = 16) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(String(text))));
}

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(String(message))));
}

/** 固定時間比較兩個字串（先各自雜湊成一樣長，再逐位元組比對），不會因為「前幾個字對了」而比較慢 */
export async function safeEqual(a, b) {
  const [x, y] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(String(a))),
    crypto.subtle.digest('SHA-256', encoder.encode(String(b))),
  ]);
  if (crypto.subtle.timingSafeEqual) { return crypto.subtle.timingSafeEqual(x, y); }
  const p = new Uint8Array(x), q = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < p.length; i++) { diff |= p[i] ^ q[i]; }
  return diff === 0;
}

/** 金鑰有沒有設定好（部署時用 wrangler secret put 設定；太短或沒設就當作服務不可用，一律拒絕） */
export function secretOk(value) { return typeof value === 'string' && value.length >= 32; }

export function parseCookies(header) {
  const out = Object.create(null);   // 沒有原型的物件：cookie 取名叫 __proto__ 之類的也只是一般的名字
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) { return; }
    const name = part.slice(0, i).trim();
    if (name && !(name in out)) { out[name] = part.slice(i + 1).trim(); }
  });
  return out;
}

/** Set-Cookie 的值。一律 Secure、Path=/；預設 HttpOnly、SameSite=Lax */
export function cookie(name, value, { maxAge = null, httpOnly = true, sameSite = 'Lax' } = {}) {
  const parts = [`${name}=${value}`, 'Path=/', 'Secure', `SameSite=${sameSite}`];
  if (httpOnly) { parts.push('HttpOnly'); }
  if (maxAge != null) { parts.push(`Max-Age=${maxAge}`); }
  return parts.join('; ');
}

/** 每個回應都帶的標頭：內容安全政策、不給快取、不給嵌入、不給搜尋引擎收錄 */
export function baseHeaders({ connect = false } = {}) {
  return {
    'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; " +
      (connect ? "connect-src 'self'; " : '') + "form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'same-origin',   // 連到別的網站時不帶來源；不能用 no-referrer：那會讓瀏覽器把表單的 Origin 送成 null，下面的 sameOrigin 就無法判斷
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    'Strict-Transport-Security': 'max-age=31536000',
  };
}

function withHeaders(base, extra) {
  const headers = new Headers(base);
  (extra || []).forEach(([k, v]) => headers.append(k, v));
  return headers;
}

export function html(body, status = 200, extra = [], options = {}) {
  return new Response(body, { status, headers: withHeaders({ ...baseHeaders(options), 'Content-Type': 'text/html; charset=utf-8' }, extra) });
}

export function json(data, status = 200, extra = []) {
  return new Response(JSON.stringify(data), { status, headers: withHeaders({ ...baseHeaders(), 'Content-Type': 'application/json; charset=utf-8' }, extra) });
}

export function text(body, status = 200, extra = []) {
  return new Response(body, { status, headers: withHeaders({ ...baseHeaders(), 'Content-Type': 'text/plain; charset=utf-8' }, extra) });
}

export function redirect(location, extra = []) {
  return new Response(null, { status: 303, headers: withHeaders({ ...baseHeaders(), Location: location }, extra) });
}

/**
 * POST 一定要來自本站自己的頁面：
 * - Origin 標頭必須等於本站網址（瀏覽器送 POST 時會帶；沒有、是 null、或是別的網站都不算）
 * - 瀏覽器有送 Sec-Fetch-Site 的話，必須是 same-origin（這個標頭網頁上的程式改不了）
 */
export function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin) { return false; }
  const site = request.headers.get('sec-fetch-site');
  return !site || site === 'same-origin';
}

export class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

/**
 * 讀取 POST 的內容，最多讀到 maxBytes，回傳 Uint8Array。
 * - Content-Length 只用來提早拒絕：對方可以不送、也可以寫得比實際小，所以不能拿它當作實際大小。
 * - 實際內容用串流一塊一塊讀；累計超過上限的那一刻就停止讀取並取消串流，回 413。
 *   不會先把整個內容讀進記憶體再檢查（沒有 Content-Length 的分塊上傳也一樣只讀到上限為止）。
 */
export async function readBody(request, maxBytes) {
  const declared = Number(request.headers.get('content-length') || '0');
  if (declared > maxBytes) { throw new HttpError(413, 'too-large'); }
  if (!request.body) { return new Uint8Array(0); }
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) { break; }
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});          // 不再讀剩下的內容（也不等對方送完）
      throw new HttpError(413, 'too-large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

/** 讀一般表單（application/x-www-form-urlencoded） */
export async function readForm(request, maxBytes = 16 * 1024) {
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') { throw new HttpError(415, 'unsupported-type'); }
  const buf = await readBody(request, maxBytes);
  return new URLSearchParams(new TextDecoder().decode(buf));
}

/** 訪客的 IP（Cloudflare 會填 CF-Connecting-IP，訪客自己改不了）。只拿來做限速，而且會先加金鑰雜湊 */
export function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

/** 記錄事件：只寫事件名稱，不寫密碼、憑證或留言內容 */
export function logEvent(name) {
  console.log(JSON.stringify({ event: String(name) }));
}

/** 日期（YYYY-MM-DD 或 YYYY-MM）→ 日文／中文寫法 */
export function formatDate(value, lang) {
  if (!value) { return ''; }
  const parts = String(value).split('-').map(Number);
  const units = lang === 'zh' ? [' 年', ' 月', ' 日'] : ['年', '月', '日'];
  return parts.map((n, i) => n + units[i]).join(lang === 'zh' ? ' ' : '');
}

/** 時間戳（秒）→ 日本時間的「YYYY-MM-DD HH:MM」 */
export function formatTime(seconds) {
  const d = new Date((seconds + 9 * 3600) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
