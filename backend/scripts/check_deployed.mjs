#!/usr/bin/env node
// 部署之後的檢查：從外面對正式網址送請求，確認私人內容拿不到、管理端被 Cloudflare Access 擋住。
//
//   node scripts/check_deployed.mjs --visitor https://ayaka-room.<子網域>.workers.dev \
//        --admin https://ayaka-room-admin.<子網域>.workers.dev --team-domain <團隊名稱>.cloudflareaccess.com
//
// 每一項的結果有三種：✔ 通過、✖ 沒通過、？ 無法判定（例如連不上、缺少判斷需要的資訊、需要人手操作；
// 「其他入口」「開發工具的檢視網址」「舊密碼」「限速」這幾項遇到被限速、伺服器錯誤或沒有驗證過的轉址時也是）。
// 「無法判定」不算通過。結束代碼：0 = 全部通過；1 = 有沒通過的；2 = 沒有失敗，但有無法判定的；64 = 參數不對。
//
// 選用的檢查：
//   --photo-id <32 個十六進位字>   用「已經上傳的合成測試圖」的真實編號，檢查同一個圖片網址在各種狀態下拿不拿得到：
//                                  沒登入、偽造的 cookie、登入後、登入的人讀過之後換沒登入的人來讀、登出後、
//                                  撤銷所有登入後、換密碼後。需要測試階段的訪客密碼（見下）。
//                                  其中「撤銷」與「換密碼」要到管理頁按按鈕，腳本會停下來等你。
//   --reply                        用測試密碼登入後送出一則標明是測試的回覆（同一則會再送兩次：同一次登入重送、重新登入之後重送），
//                                  再請你到管理頁確認收到，而且只有一則（留言入庫、管理頁讀取、重送不會重複）
//   --rate                         連續送幾次錯的密碼，確認會被限速（會讓這個 IP 最多 10 分鐘內無法登入；管理頁可以解除）。
//                                  要先看到「密碼不對」再被擋才算通過；這個 IP 已經在限速中時是無法判定（先到管理頁清除再跑）
//   --aud <AUD>                    核對 Access 登入網址裡的應用程式編號是不是預期的那一個
//   --preview-url <網址>           某一個版本的預覽網址（https://<版本編號前 8 碼>-<Worker 名稱>.<子網域>.workers.dev，
//                                  版本編號用 wrangler versions list 查）。可以給很多個
//   --r2-url <網址>                儲存桶的公開網址（如果曾經開過 r2.dev 或自訂網域）加上測試圖的路徑
//                                  這兩項是「找得到問題才算數」的檢查：連得到 Worker、拿得到檔案 → 沒通過；
//                                  其他任何回應（找不到、被拒絕、被限速、伺服器錯誤、轉到別處）一律是「無法判定」，
//                                  因為單憑一個網址的回應，分不出「已經關閉」和「網址打錯、版本不存在、一時出錯」。
//                                  「已經關閉」要看後台的設定，列在最後的人工項目裡
//   --report <檔名>                把結果另外寫成 JSON（不含密碼與 cookie），可以附在驗收紀錄裡
//   --no-prompt                    不停下來等人；需要人手操作的項目一律記為「無法判定」
//   --local                        檢查本機預覽（http://localhost:…）時用：略過只有正式環境才有的項目
//
// 訪客密碼只從環境變數 ROOM_TEST_PASSWORD 讀取，或在執行時輸入（不會顯示在畫面上）；不接受命令列參數，
// 也不會被印出來或寫進報告。請只用「合成測試階段」的密碼跑這個腳本——檢查會請你換掉它；
// 換完之後再把新的密碼寫給對方。
//
// 這個腳本做不到、必須由人確認的項目，會在最後列出來（管理端的 MFA、R2 的公開入口、預覽網址、CPU 用量、真實手機）。

import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { inspectJpeg } from '../shared/jpeg.js';

export const MANUAL_ITEMS = [
  ['管理端的多因素驗證（MFA）', '用無痕視窗打開管理端，完成第一個登入步驟後「不要」完成第二因子：應該進不了管理頁。完成第二因子後才進得去。Access 的應用程式與政策兩層的 MFA 設定都不可以是 Disable MFA。'],
  ['Access 的政策', '管理端的 Access 應用程式只有一條 Allow 政策、只列站主的信箱；沒有 Bypass 或 Service Auth 政策。'],
  ['R2 的公開入口', '儲存桶的 r2.dev 公開網址是關閉的、沒有自訂網域：wrangler r2 bucket dev-url get <儲存桶> 與 wrangler r2 bucket domain list <儲存桶>，或到後台該儲存桶的 Settings 看。以這裡看到的設定為準；--r2-url 只能抓到「拿得到檔案」，拿不到時不能證明已經關閉。'],
  ['預覽網址', '兩個 Worker 的 Preview URLs（新版後台也叫 Version URLs）都是關閉的：後台 Workers & Pages > 該 Worker > Settings > Domains & Routes。以這裡看到的設定為準；--preview-url 只能抓到「連得到 Worker」，連不到時不能證明已經關閉（版本編號不存在時也一樣連不到）。'],
  ['各主要操作的 CPU 用量', '登入、開頁面、看照片、送出回覆、管理頁上傳照片：後台 Workers & Pages > Worker > Metrics 的 CPU Time，或 wrangler tail <Worker> --format json | node scripts/cpu_report.mjs --expect visitor（管理端用 --expect admin）。免費方案每次請求的上限是 10 ms。報告要是「✔」才算量過；「？ 無法判定」表示有請求缺少 CPU 數值、或有操作還沒量到，不算通過。'],
  ['真實的 iPhone Safari', '登入、看照片（放大、切換、關閉）、送出回覆、登入過期後重新登入、登出，在真的手機上各走一遍。電腦上手機尺寸的結果不能代替；這一次沒有在真的手機上做的項目記為「未驗證」。'],
  ['泡泡（傳送之前）', '範例內容的階段不對對方送出任何訊息。只確認三件事：不送出的草稿（字數與排版，用同樣長度的假字）、既有訊息上看得到的操作、iPhone Safari 上和登入有關的確認。要真的送出才能確認的項目，等正式內容定稿、站主決定傳送之後再記錄；藝人收件端從粉絲端看不到，記為「未驗證」。'],
];

/* ---------- 判定（單獨抽出來，方便測試） ---------- */

const pass = (detail = '') => ({ status: 'pass', detail });
const fail = (detail = '') => ({ status: 'fail', detail });
const unknown = (detail = '') => ({ status: 'unknown', detail });

/** 團隊網域可以寫成 team、team.cloudflareaccess.com 或 https://team.cloudflareaccess.com；回傳主機名稱（不合理就回傳 null） */
export function normalizeTeamDomain(value) {
  if (!value) { return null; }
  let host = String(value).trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/+$/, '');
  if (/^[a-z0-9-]+$/.test(host)) { host += '.cloudflareaccess.com'; }
  return /^[a-z0-9-]+\.cloudflareaccess\.com$/.test(host) ? host : null;
}

/**
 * 用 http:// 連線的結果該怎麼判定。outcome：{ status, location, gate } 或 { error }
 * - 轉到同一個主機的 https:// → 通過
 * - 用 http 就拿得到頁面內容 → 沒通過
 * - 連不上、逾時等一般的網路錯誤 → 無法判定（可能是對方不收 http，也可能只是這台電腦的網路問題）
 */
export function judgePlainHttp(outcome, httpsUrl) {
  if (outcome.error) { return unknown(`連線失敗（${outcome.error}）：分不出是對方不接受 http，還是這台電腦的網路問題`); }
  const host = new URL(httpsUrl).host;
  if ([301, 302, 307, 308].includes(outcome.status)) {
    let target = null;
    try { target = new URL(outcome.location); } catch (err) { /* 不是完整的網址 */ }
    if (target && target.protocol === 'https:' && target.host === host) { return pass(`HTTP ${outcome.status} → https://${target.host}`); }
    return fail(`HTTP ${outcome.status} 轉到 ${outcome.location || '（沒有 Location）'}，不是同一個主機的 https://`);
  }
  if (outcome.status >= 200 && outcome.status < 300) { return fail(`用 http 連線直接得到 HTTP ${outcome.status}${outcome.gate ? '（登入頁）' : ''}，沒有轉到 https`); }
  return unknown(`HTTP ${outcome.status}：沒有轉到 https，也沒有提供頁面內容；請用瀏覽器確認`);
}

/**
 * 管理端沒登入時的回應是不是「被 Cloudflare Access 轉到登入頁」，而且是預期的那個團隊網域。
 * 回傳 { status, detail, host, kid }。只認完整解析出來的主機名稱：網址裡其他地方出現 cloudflareaccess.com 不算。
 */
export function judgeAccessRedirect(response, adminUrl, teamHost, aud = null) {
  if (![301, 302, 303, 307].includes(response.status)) { return { ...fail(`HTTP ${response.status}，沒有轉到 Cloudflare Access 的登入頁（Access 可能還沒啟用，只是 Worker 自己在拒絕）`), host: null, kid: null }; }
  let target;
  try { target = new URL(response.location, adminUrl); } catch (err) { return { ...fail('Location 不是合法的網址'), host: null, kid: null }; }
  const host = target.hostname.toLowerCase();
  const kid = target.searchParams.get('kid');
  const base = { host, kid };
  if (target.protocol !== 'https:' || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(host)) { return { ...fail(`轉到 ${target.protocol}//${host}，不是 Cloudflare Access 的網域`), ...base }; }
  if (!teamHost) { return { ...unknown(`轉到 ${host}；沒有提供 --team-domain，無法核對是不是你的團隊網域`), ...base }; }
  if (host !== teamHost) { return { ...fail(`轉到 ${host}，不是預期的 ${teamHost}`), ...base }; }
  if (aud && kid !== aud) { return { ...fail(`登入網址裡的應用程式編號（kid）是 ${kid || '空的'}，不是預期的那一個`), ...base }; }
  return { ...pass(`轉到 ${host}${aud ? '，應用程式編號相符' : ''}`), ...base };
}

/** 這個專案的兩個 Worker 回的每一個回應都帶著同一組標頭（shared/util.js 的 baseHeaders）。headers：標頭名稱（小寫）→ 值 */
export function hasProjectHeaders(headers) {
  const h = headers || {};
  return /^default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self';/.test(h['content-security-policy'] || '')
    && (h['x-robots-tag'] || '') === 'noindex, nofollow, noarchive'
    && (h['permissions-policy'] || '').includes('interest-cohort=()');
}

/** 回應是不是這個專案的 Worker 送出來的：帶著專案的標頭，或內容裡有專案頁面的特徵（不管狀態碼是多少） */
function fromOurWorker(outcome) {
  if (hasProjectHeaders(outcome.headers)) { return true; }
  return ['action="/login"', 'data-reply-form', 'admin__', 'Forbidden (', '/room.css'].some((marker) => (outcome.text || '').includes(marker));
}

/** 轉址的目的地主機（只給說明文字用） */
function redirectTarget(location) {
  try { return new URL(location).host; } catch (err) { return location ? '（不是完整的網址）' : '（沒有 Location）'; }
}

/**
 * 「其他入口」這一類檢查共用的說法：沒有發現開著的跡象，但回應本身不能證明已經關閉 → 無法判定。
 * 不同的狀態碼各自說明「為什麼不能判定」。notFound：遇到 404 時的說明；confirm：該去哪裡確認
 */
function inconclusive(outcome, notFound, confirm) {
  const status = outcome.status;
  if (status >= 300 && status < 400) { return unknown(`HTTP ${status} 轉到 ${redirectTarget(outcome.location)}：沒有跟著轉址，不知道最後會連到哪裡。${confirm}`); }
  if (status === 429) { return unknown(`HTTP 429（被限速）：這一次沒有得到可以判斷的回應，請稍後再試。${confirm}`); }
  if (status >= 500) { return unknown(`HTTP ${status}（伺服器錯誤）：這一次沒有得到可以判斷的回應。${confirm}`); }
  if (status === 404) { return unknown(`HTTP 404（找不到）：${notFound}。${confirm}`); }
  if (status >= 400) { return unknown(`HTTP ${status}（被拒絕）：分不出是誰拒絕的、為什麼拒絕，不能當作「已經關閉」的證明。${confirm}`); }
  return unknown(`HTTP ${status}：不是可以判斷的回應。${confirm}`);
}

/**
 * 預覽網址（某一個版本專用的網址）應該是關閉的：打開它不應該連到我們的 Worker。
 * outcome：{ status, location, text, headers } 或 { error }
 *
 * 這個檢查只會有兩種結果：
 * - 沒通過：回應是這個專案的 Worker 送出來的（不管狀態碼），或被轉到 Cloudflare Access 的登入頁（網址是開著的，只是被 Access 擋著）
 * - 無法判定：其他任何回應。找不到（404）、被拒絕（401／403）、被限速（429）、伺服器錯誤（5xx）、轉到別處（3xx）
 *   都不能當成「預覽網址已經關閉」——網址裡的版本編號不存在時，平台回的也是找不到；429 與 5xx 則什麼都沒有說明。
 * 它不會回報「通過」：預覽網址是不是關閉，以後台的設定為準（MANUAL_ITEMS 的「預覽網址」）。
 */
export function judgePreviewUrl(outcome) {
  const confirm = '請到後台確認 Preview URLs 是關閉的';
  if (outcome.error) { return unknown(`連線失敗（${outcome.error}）：無法確認這個網址是不是關閉的。${confirm}`); }
  if (fromOurWorker(outcome)) { return fail(`HTTP ${outcome.status}：回應來自這個專案的 Worker，預覽網址是開著的`); }
  if (outcome.status >= 300 && outcome.status < 400) {
    let target = null;
    try { target = new URL(outcome.location || ''); } catch (err) { /* 不是完整的網址 */ }
    if (target && target.protocol === 'https:' && /^[a-z0-9-]+\.cloudflareaccess\.com$/.test(target.hostname.toLowerCase())) {
      return fail(`HTTP ${outcome.status} 轉到 Cloudflare Access：預覽網址是開著的（只是被 Access 擋著）`);
    }
  }
  if (outcome.status >= 200 && outcome.status < 300) { return unknown(`HTTP ${outcome.status}，但內容不像這個專案的頁面；請用瀏覽器確認這個網址是什麼`); }
  return inconclusive(outcome, '預覽網址關閉時可能是這個回應，但版本編號不存在、網址打錯時也是，不能當作證明', confirm);
}

/**
 * 儲存桶的公開網址不應該拿得到檔案。outcome：{ status, location, jpeg, type } 或 { error }
 *
 * 和預覽網址一樣，只會有兩種結果：
 * - 沒通過：不用登入就拿到圖片（2xx，內容是 JPEG 或類型是 image/…）
 * - 無法判定：其他任何回應。拿不到檔案不等於公開入口是關的——路徑或網址打錯也拿不到；
 *   在 r2.dev 上，「找不到這個檔案」反而可能表示公開網址是開著的，只是路徑不對。
 * 公開入口是不是關閉，以 wrangler 或後台看到的設定為準（MANUAL_ITEMS 的「R2 的公開入口」）。
 */
export function judgeBucketUrl(outcome) {
  const confirm = '請用 wrangler r2 bucket dev-url get <儲存桶> 與 wrangler r2 bucket domain list <儲存桶> 確認公開入口是關閉的';
  if (outcome.error) { return unknown(`連線失敗（${outcome.error}）：無法確認。${confirm}`); }
  if (outcome.status >= 200 && outcome.status < 300 && (outcome.jpeg || /image\//.test(outcome.type || ''))) { return fail(`HTTP ${outcome.status}：不用登入就拿得到檔案，儲存桶的公開入口是開著的`); }
  if (outcome.status >= 200 && outcome.status < 300) { return unknown(`HTTP ${outcome.status}，回應不是圖片；請用瀏覽器確認這個網址是什麼`); }
  return inconclusive(outcome, '這個路徑沒有檔案，但不能證明公開入口是關的——在 r2.dev 上，找不到檔案可能表示公開網址是開著的、只是路徑不對', confirm);
}

/**
 * 本機開發工具的資料檢視網址（/cdn-cgi/local/explorer/…，只會出現在 wrangler dev）在正式環境不應該有回應。
 * outcome：{ status, text }。有回應資料 → 沒通過；明確的「沒有這個網址／不受理」（4xx，限速除外）→ 通過；
 * 被限速、伺服器錯誤、轉址、其他內容 → 無法判定（那些回應沒有說明這個網址存不存在）
 */
export function judgeNoExplorer(outcome) {
  if (outcome.status === 200 && /"success"\s*:\s*true/.test(outcome.text || '')) { return fail('HTTP 200：開發工具的檢視網址有回應，不用登入就看得到資料'); }
  if ([400, 401, 403, 404, 405, 410].includes(outcome.status)) { return pass(`HTTP ${outcome.status}`); }
  return unknown(`HTTP ${outcome.status}：不是「沒有這個網址」的回應，無法確認`);
}

/**
 * 換密碼之後，用舊密碼登入的結果。attempt：{ status, signedIn }
 * 登入成功 → 沒通過；因為「密碼不對」被拒絕（401）→ 通過；
 * 其他原因沒登入成功（被限速 429、伺服器錯誤、沒拿到防偽造編號 403…）→ 無法判定：那不能證明舊密碼已經失效
 */
export function judgeOldPassword(attempt) {
  if (attempt.signedIn) { return fail('舊密碼還能登入'); }
  if (attempt.status === 401) { return pass('HTTP 401（密碼不對）'); }
  return unknown(`HTTP ${attempt.status}：沒有登入成功，但原因不是「密碼不對」（可能是被限速或伺服器錯誤），無法確認舊密碼已經失效`);
}

/**
 * 連續送出幾次錯的密碼之後，各次登入請求的狀態碼（依序）該怎麼判定。
 * 通過：前面幾次是「密碼不對」（401），最多 5 次之後開始被限速（429），而且之後每一次都是 429。
 * 一開始就是 429、夾著伺服器錯誤、或登入根本沒有被受理（例如 403）→ 無法判定：那看不出門檻有沒有作用
 * （這個 IP 可能本來就在限速中，也可能是平台在擋）。錯了很多次都沒有被擋、或被擋之後又放行 → 沒通過。
 */
export function judgeLoginRate(statuses) {
  const trail = statuses.join(' → ');
  if (!statuses.length) { return unknown('沒有送出任何登入請求'); }
  if (statuses.some((status) => status >= 500)) { return unknown(`${trail}：有伺服器錯誤，這一次沒有得到可以判斷的回應`); }
  const first = statuses.indexOf(429);
  if (first === -1) {
    if (statuses.every((status) => status === 401)) { return fail(`${trail}：錯了 ${statuses.length} 次都沒有被限速`); }
    return unknown(`${trail}：登入請求沒有被受理（不是「密碼不對」也不是「被限速」），無法判斷`);
  }
  if (first === 0) { return unknown(`${trail}：第一次嘗試就被限速。這個 IP 可能已經在限速中（先到管理頁清除登入的限速紀錄再跑一次），也可能是平台在擋；這樣看不出門檻有沒有作用`); }
  if (!statuses.slice(0, first).every((status) => status === 401)) { return unknown(`${trail}：被限速之前的回應不全是「密碼不對」，無法判斷`); }
  const after = statuses.slice(first);
  if (after.some((status) => status === 401 || status === 303)) { return fail(`${trail}：開始限速之後又受理了登入`); }
  if (!after.every((status) => status === 429)) { return unknown(`${trail}：開始限速之後出現別的回應，無法判斷`); }
  if (first > 5) { return fail(`${trail}：錯超過 5 次才被擋`); }
  return pass(trail);
}

/* ---------- 小型用戶端（自己記 cookie、不跟隨轉址） ---------- */

class Session {
  constructor(base) { this.base = base; this.origin = new URL(base).origin; this.jar = new Map(); }
  cookieHeader() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  async request(path, { method = 'GET', form = null, headers = {}, cookies = true, cookieHeader = null } = {}) {
    const all = { ...headers };
    const sendCookie = cookieHeader !== null ? cookieHeader : (cookies && this.jar.size ? this.cookieHeader() : '');
    if (sendCookie) { all.Cookie = sendCookie; }
    let body;
    if (form) { body = new URLSearchParams(form).toString(); all['Content-Type'] = 'application/x-www-form-urlencoded'; method = 'POST'; }
    if (method === 'POST' && !('Origin' in all)) { all.Origin = this.origin; }
    if (all.Origin === '') { delete all.Origin; }          // 傳空字串表示「不要帶 Origin」
    const res = await fetch(this.base + path, { method, headers: all, body, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    if (cookies && cookieHeader === null) {
      for (const line of res.headers.getSetCookie()) {
        const [pair, ...attrs] = line.split(';').map((s) => s.trim());
        const i = pair.indexOf('=');
        if (attrs.some((a) => /^max-age=0$/i.test(a)) || pair.slice(i + 1) === '') { this.jar.delete(pair.slice(0, i)); } else { this.jar.set(pair.slice(0, i), pair.slice(i + 1)); }
      }
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, buffer, text: buffer.toString('utf8'), location: res.headers.get('location') || '' };
  }
}
const field = (html, name) => (new RegExp(`name="${name}" value="([^"]*)"`).exec(html) || [])[1] || '';
const isGate = (r) => r.text.includes('action="/login"') && !r.text.includes('data-reply-form');
const isRoom = (r) => r.status === 200 && r.text.includes('data-reply-form');
const isJpeg = (r) => r.buffer.length > 3 && r.buffer[0] === 0xff && r.buffer[1] === 0xd8;

/* ---------- 檢查 ---------- */

/**
 * 執行檢查，回傳 { results: [{ id, section, label, status, detail }], manual, counts }。
 * options：visitor、admin、teamDomain、aud、local、rate、reply、photoId、password
 * io：log(text)、act(kind, message)（請人去管理頁做一個動作；回傳 true 表示做了）、
 *     confirm(question)（是非題；回傳 true／false／null）、newPassword()（換密碼之後的新密碼，可以回傳 null）
 */
export async function runChecks(options, io = {}) {
  const log = io.log || (() => {});
  const act = io.act || (async () => false);
  const confirm = io.confirm || (async () => null);
  const visitor = options.visitor.replace(/\/+$/, '');
  const admin = options.admin ? options.admin.replace(/\/+$/, '') : null;
  const teamHost = normalizeTeamDomain(options.teamDomain);
  const results = [];
  let section = '';
  const mark = { pass: '✔', fail: '✖', unknown: '？' };
  const record = (id, label, verdict) => {
    const entry = { id, section, label, status: verdict.status, detail: verdict.detail || '' };
    results.push(entry);
    log(`${mark[entry.status]} ${label}${entry.detail ? `　（${entry.detail}）` : ''}`);
    return entry.status === 'pass';
  };
  const check = (id, label, ok, detail = '') => record(id, label, ok ? pass(detail) : fail(detail));
  /** 連不上之類的錯誤不可以讓整個腳本中斷，也不可以算通過：記成無法判定 */
  const guarded = async (id, label, fn) => {
    try { return await fn(); } catch (err) { record(id, label, unknown(`請求失敗（${err.cause && err.cause.code ? err.cause.code : err.name}）`)); return null; }
  };
  const fakeId = randomBytes(16).toString('hex');
  const anon = () => new Session(visitor);
  /**
   * 用訪客密碼登入。回傳 { session, status }：session 是帶著登入 cookie 的 Session（沒登入成功就是 null），
   * status 是登入請求的 HTTP 狀態碼——沒登入成功時，要靠它分辨「密碼不對（401）」和「被限速、伺服器錯誤」
   */
  const signIn = async (password) => {
    const session = anon();
    const page = await session.request('/');
    const res = await session.request('/login', { form: { csrf: field(page.text, 'csrf'), password } });
    const ok = res.status === 303 && session.jar.has('__Host-room-session');
    return { session: ok ? session : null, status: res.status };
  };

  /* ----- 訪客端：不需要密碼的檢查 ----- */
  section = '訪客端';
  log(`\n訪客端：${visitor}`);
  const home = await guarded('visitor.home', '打開首頁', () => anon().request('/'));
  if (home) {
    check('visitor.home', '沒登入時首頁只有登入表單', home.status === 200 && isGate(home), `HTTP ${home.status}`);
    check('visitor.no-store', '回應標明不可快取（Cache-Control: private, no-store）', home.headers.get('cache-control') === 'private, no-store', home.headers.get('cache-control') || '沒有');
    check('visitor.csp', '有內容安全政策（CSP），預設全部禁止', /default-src 'none'/.test(home.headers.get('content-security-policy') || ''));
    check('visitor.frame', '不可被嵌入、不猜測檔案類型', home.headers.get('x-content-type-options') === 'nosniff' && home.headers.get('x-frame-options') === 'DENY');
    check('visitor.noindex', '不讓搜尋引擎收錄（noindex）', /noindex/.test(home.headers.get('x-robots-tag') || ''));
    check('visitor.hsts', '有 HSTS', !!home.headers.get('strict-transport-security'));
    check('visitor.referrer', 'Referrer-Policy 是 same-origin', home.headers.get('referrer-policy') === 'same-origin');
    const cookie = home.headers.getSetCookie().find((c) => c.startsWith('__Host-room-csrf=')) || '';
    check('visitor.cookie', 'cookie 帶有 Secure、HttpOnly、SameSite，而且是 __Host- 開頭', /; Secure/.test(cookie) && /; HttpOnly/.test(cookie) && /SameSite=Strict/.test(cookie) && /Path=\//.test(cookie) && !/Domain=/i.test(cookie));
  }
  await guarded('visitor.fake-photo', '不存在的照片編號', async () => {
    for (const size of ['thumb', 'full']) {
      const photo = await anon().request(`/photo/${fakeId}/${size}`);
      check(`visitor.fake-photo.${size}`, `沒登入時照片網址（${size}，隨機編號）回 401，沒有圖片資料`, photo.status === 401 && photo.buffer.length < 64 && !(photo.headers.get('content-type') || '').includes('image'), `HTTP ${photo.status}`);
    }
    const forgedCookie = `__Host-room-session=${randomBytes(32).toString('base64url')}; loggedIn=true; admin=1`;
    const forged = await anon().request('/', { cookieHeader: forgedCookie });
    check('visitor.forged-home', '偽造的登入 cookie 沒有用', forged.status === 200 && isGate(forged));
    const reply = await anon().request('/reply', { form: { csrf: 'x', nonce: 'a'.repeat(32), body: 'check' } });
    check('visitor.reply-anon', '沒登入時不能送出回覆', reply.status === 401 && isGate(reply), `HTTP ${reply.status}`);
    const noOrigin = await anon().request('/login', { form: { csrf: 'x', password: 'x' }, headers: { Origin: '' } });
    check('visitor.login-no-origin', '沒有 Origin 的登入請求不受理', noOrigin.status === 403, `HTTP ${noOrigin.status}`);
    const cross = await anon().request('/login', { form: { csrf: 'x', password: 'x' }, headers: { Origin: 'https://example.com' } });
    check('visitor.login-cross', '來自別的網站的登入請求不受理', cross.status === 403, `HTTP ${cross.status}`);
    const noCsrf = await anon().request('/login', { form: { csrf: 'x', password: 'x' } });
    check('visitor.login-no-csrf', '沒有防偽造編號的登入請求不受理', noCsrf.status === 403, `HTTP ${noCsrf.status}`);
    for (const path of ['/replies', '/inbox', '/export.json', '/admin', '/access', '/photos', '/.dev.vars', '/wrangler.jsonc']) {
      const r = await anon().request(path);
      check(`visitor.no-route${path}`, `訪客端沒有 ${path} 這個網址`, r.status === 404, `HTTP ${r.status}`);
    }
    const explorer = await anon().request('/cdn-cgi/local/explorer/api/d1/database');
    record('visitor.no-explorer', '沒有開發工具的檢視網址（那只會出現在本機的 wrangler dev）', judgeNoExplorer({ status: explorer.status, text: explorer.text }));
    return true;
  });

  if (!options.local) {
    let outcome;
    try {
      const plain = await fetch(visitor.replace(/^https:/, 'http:') + '/', { redirect: 'manual', signal: AbortSignal.timeout(15000) });
      const body = Buffer.from(await plain.arrayBuffer()).toString('utf8');
      outcome = { status: plain.status, location: plain.headers.get('location') || '', gate: body.includes('action="/login"') };
    } catch (err) {
      outcome = { error: (err.cause && err.cause.code) || err.name || 'error' };
    }
    record('visitor.plain-http', '用 http:// 連線會被轉到 https://', judgePlainHttp(outcome, visitor));
  }

  /* ----- 測試圖：同一個網址在各種登入狀態下 ----- */
  let signedIn = null;        // 最後一個還有效的登入（給「回覆」的檢查用）
  let signedInPassword = null;   // 那一次登入用的密碼（只留在記憶體裡，「重新登入之後再送」的檢查要用；不會被印出來或寫進報告）
  if (options.photoId) {
    section = '測試圖';
    log(`\n測試圖（合成的範例圖，編號 ${options.photoId.slice(0, 6)}…）`);
    const id = options.photoId;
    const paths = { full: `/photo/${id}/full`, thumb: `/photo/${id}/thumb` };
    const denied = (r) => r.status === 401 && !isJpeg(r) && !(r.headers.get('content-type') || '').includes('image');
    const describe = (r) => `HTTP ${r.status}${isJpeg(r) ? '，回應是圖片' : ''}`;
    /** 沒有帶任何 cookie、或帶著指定 cookie 的人，拿這張圖的兩個網址 */
    const fetchBoth = async (cookieHeader) => {
      const out = {};
      for (const size of ['thumb', 'full']) { out[size] = await anon().request(paths[size], { cookieHeader: cookieHeader || '' }); }
      return out;
    };
    const bothDenied = (id2, label, got) => check(id2, label, denied(got.thumb) && denied(got.full), `縮圖 ${describe(got.thumb)}、原圖 ${describe(got.full)}`);

    await guarded('photo.flow', '測試圖的檢查', async () => {
      // 1. 沒登入、偽造的 cookie
      bothDenied('photo.anon', '沒登入：這張圖的縮圖與原圖都拿不到', await fetchBoth(''));
      bothDenied('photo.forged', '偽造的登入 cookie：拿不到', await fetchBoth(`__Host-room-session=${randomBytes(32).toString('base64url')}`));

      if (!options.password) {
        record('photo.signed-in', '登入後拿得到這張圖', unknown('沒有提供測試密碼（環境變數 ROOM_TEST_PASSWORD），後面需要登入的項目都無法判定'));
        return true;
      }
      // 2. 登入後拿得到，而且是乾淨的 JPEG、標明不可快取
      const firstTry = await signIn(options.password);
      const first = firstTry.session;
      if (!first) { record('photo.signed-in', '登入後拿得到這張圖', fail(`用測試密碼登入沒有成功（HTTP ${firstTry.status}：密碼不對、或這個 IP 被限速）`)); return true; }
      const firstCookie = first.cookieHeader();
      const seen = { thumb: await first.request(paths.thumb), full: await first.request(paths.full) };
      const exists = seen.full.status === 200 && seen.thumb.status === 200 && isJpeg(seen.full) && isJpeg(seen.thumb);
      check('photo.signed-in', '登入後拿得到這張圖（縮圖與原圖）', exists, `縮圖 ${describe(seen.thumb)}、原圖 ${describe(seen.full)}${seen.full.status === 404 ? '：這個編號的照片不存在，請確認 --photo-id' : ''}`);
      if (!exists) { return true; }
      const cacheHeaders = (r) => r.headers.get('cache-control') === 'private, no-store' && !r.headers.get('age') && !/^(HIT|REVALIDATED|UPDATING|STALE)$/i.test(r.headers.get('cf-cache-status') || '');
      check('photo.no-store', '圖片的回應標明不可快取，也不是從快取送出來的', cacheHeaders(seen.full) && cacheHeaders(seen.thumb),
        `Cache-Control: ${seen.full.headers.get('cache-control') || '沒有'}；CF-Cache-Status: ${seen.full.headers.get('cf-cache-status') || '沒有'}`);
      const meta = [inspectJpeg(seen.full.buffer), inspectJpeg(seen.thumb.buffer)];
      check('photo.clean', '存下來的檔案只有影像本身（沒有 Exif、GPS、縮圖等附加資料）', meta.every((m) => m.ok && m.meta.length === 0), meta.map((m) => (m.ok ? (m.meta.join('、') || '乾淨') : m.reason)).join('；'));

      // 3. 登入的人剛讀過之後，沒登入的人用同一個網址（以及幾種變化）來拿：仍然拒絕
      const variations = [];
      for (let round = 0; round < 3; round++) {
        for (const size of ['thumb', 'full']) {
          variations.push(await anon().request(paths[size]));
          variations.push(await anon().request(`${paths[size]}?v=${round}`));
          variations.push(await anon().request(paths[size], { headers: { Range: 'bytes=0-1023' } }));
          variations.push(await anon().request(paths[size], { method: 'HEAD' }));
        }
        await first.request(paths.full);       // 中間再讓登入的人讀一次
      }
      const leaked = variations.filter((r) => !(r.status === 401 && !isJpeg(r)));
      check('photo.after-signed-in-read', '登入的人讀過之後，沒登入的人用同一個網址仍然拿不到（沒有被共用的快取記住）', leaked.length === 0,
        leaked.length ? `${leaked.length}／${variations.length} 個請求沒有被拒絕（例如 HTTP ${leaked[0].status}）` : `${variations.length} 個請求都是 401`);

      // 4. 登出後，原本的 cookie 沒有用
      const roomPage = await first.request('/');
      const out = await first.request('/logout', { form: { csrf: field(roomPage.text, 'csrf') } });
      const afterLogout = await fetchBoth(firstCookie);
      const homeAfterLogout = await anon().request('/', { cookieHeader: firstCookie });
      check('photo.after-logout', '登出後，把原本的登入 cookie 原封不動送回來也拿不到', out.status === 303 && denied(afterLogout.thumb) && denied(afterLogout.full) && isGate(homeAfterLogout),
        `登出 HTTP ${out.status}；縮圖 ${describe(afterLogout.thumb)}、原圖 ${describe(afterLogout.full)}`);

      // 5. 撤銷所有登入（要到管理頁按按鈕）
      const second = (await signIn(options.password)).session;
      if (!second) { record('photo.after-revoke', '撤銷所有登入後拿不到', fail('重新登入沒有成功')); return true; }
      const secondCookie = second.cookieHeader();
      if (await act('revoke', '請到管理頁「密碼與登入」按「撤銷所有訪客的登入（不換密碼）」。')) {
        const afterRevoke = await fetchBoth(secondCookie);
        const homeAfterRevoke = await anon().request('/', { cookieHeader: secondCookie });
        bothDenied('photo.after-revoke', '站主撤銷所有登入後，原本登入中的人拿不到', afterRevoke);
        check('photo.after-revoke.page', '撤銷後，原本登入中的人看到的是登入頁', isGate(homeAfterRevoke), `HTTP ${homeAfterRevoke.status}`);
      } else {
        record('photo.after-revoke', '站主撤銷所有登入後，原本登入中的人拿不到', unknown('需要到管理頁操作，這一次沒有做'));
      }

      // 6. 換密碼（要到管理頁按按鈕）
      const third = (await signIn(options.password)).session;
      if (!third) { record('photo.after-rotate', '換密碼後拿不到', fail('撤銷之後用原本的密碼重新登入沒有成功（撤銷不應該改到密碼）')); return true; }
      check('photo.relogin-after-revoke', '撤銷不影響密碼：用同一組密碼可以重新登入並看到照片', (await third.request(paths.full)).status === 200);
      signedIn = third;
      signedInPassword = options.password;
      const thirdCookie = third.cookieHeader();
      if (await act('rotate', '請到管理頁「密碼與登入」按「產生一組新的密碼」，並把新的密碼記下來（這一組測試密碼從此失效）。')) {
        signedIn = null;
        signedInPassword = null;
        const afterRotate = await fetchBoth(thirdCookie);
        bothDenied('photo.after-rotate', '換密碼後，用舊密碼登入的人拿不到', afterRotate);
        const oldAgain = await signIn(options.password);
        record('photo.old-password', '舊密碼不能再登入', judgeOldPassword({ status: oldAgain.status, signedIn: !!oldAgain.session }));
        const fresh = io.newPassword ? await io.newPassword() : null;
        if (fresh) {
          const fourth = (await signIn(fresh)).session;
          const ok = !!fourth && (await fourth.request(paths.full)).status === 200;
          check('photo.new-password', '新密碼可以登入並看到照片', ok);
          if (ok) { signedIn = fourth; signedInPassword = fresh; }
        } else {
          record('photo.new-password', '新密碼可以登入並看到照片', unknown('沒有輸入新密碼'));
        }
      } else {
        record('photo.after-rotate', '換密碼後，用舊密碼登入的人拿不到', unknown('需要到管理頁操作，這一次沒有做'));
      }
      return true;
    });
  }

  /* ----- 回覆：入庫與管理頁讀取 ----- */
  if (options.reply) {
    section = '回覆';
    log('\n回覆（留言入庫與管理頁讀取）');
    await guarded('reply.flow', '送出測試回覆', async () => {
      if (!signedIn && options.password) {
        signedIn = (await signIn(options.password)).session;
        if (signedIn) { signedInPassword = options.password; }
      }
      if (!signedIn) { record('reply.stored', '送出的回覆存進資料庫', unknown('沒有可用的登入（缺少測試密碼，或密碼已經換掉而沒有輸入新的）')); return true; }
      const page = await signedIn.request('/');
      const marker = `check-${randomBytes(4).toString('hex')}`;
      const body = `【テスト】check_deployed ${new Date().toISOString()} ${marker}（確認後は削除してください）`;
      // nonce 是這一則回覆的送出編號：下面三次送的是「同一則」，資料庫裡應該只有一筆
      const nonce = field(page.text, 'nonce');
      const sent = await signedIn.request('/reply', { form: { csrf: field(page.text, 'csrf'), nonce, body }, headers: { Accept: 'application/json' } });
      let data = null;
      try { data = JSON.parse(sent.text); } catch (err) { /* 不是 JSON */ }
      check('reply.stored', '送出測試回覆，伺服器回報已經存好', sent.status === 200 && !!data && data.ok === true, `HTTP ${sent.status}`);
      const again = await signedIn.request('/reply', { form: { csrf: field(page.text, 'csrf'), nonce, body }, headers: { Accept: 'application/json' } });
      check('reply.dedupe', '同一則重送（同一次登入），不會被拒絕', again.status === 200, `HTTP ${again.status}`);
      // 重新登入（新的登入、新的防偽造編號）之後再送同一則：一樣要認得出是同一次送出
      if (signedInPassword) {
        const relogin = await signIn(signedInPassword);
        if (relogin.session) {
          const fresh = await relogin.session.request('/');
          const third = await relogin.session.request('/reply', { form: { csrf: field(fresh.text, 'csrf'), nonce, body }, headers: { Accept: 'application/json' } });
          check('reply.dedupe-relogin', '同一則在重新登入之後再送，不會被拒絕', third.status === 200, `HTTP ${third.status}`);
        } else {
          record('reply.dedupe-relogin', '同一則在重新登入之後再送，不會被拒絕', unknown(`第二次登入沒有成功（HTTP ${relogin.status}）`));
        }
      } else {
        record('reply.dedupe-relogin', '同一則在重新登入之後再送，不會被拒絕', unknown('沒有目前有效的密碼，沒有做重新登入的那一次'));
      }
      const seen = await confirm(`請到管理頁的收件匣確認：有一則內容包含「${marker}」的回覆，而且只有一則（腳本把同一則送了好幾次，其中一次是重新登入之後送的；資料庫裡應該只有一筆）。確認後請把它刪掉。只有一則嗎？`);
      record('reply.inbox', `管理頁的收件匣讀得到這一則，而且只有一則（記號 ${marker}）`, seen === true ? pass('已由人確認') : (seen === false ? fail('管理頁上沒有看到，或不只一則') : unknown('需要到管理頁確認')));
      return true;
    });
  }

  /* ----- 限速 ----- */
  if (options.rate && home) {
    section = '限速';
    log('\n限速（會暫時擋住這個 IP 的登入，最多 10 分鐘）');
    await guarded('rate.login', '登入的限速', async () => {
      const session = anon();
      const page = await session.request('/');
      const statuses = [];
      for (let i = 0; i < 7; i++) {
        statuses.push((await session.request('/login', { form: { csrf: field(page.text, 'csrf'), password: `0000-0000-0000-0000-0000-0000-${fakeId.slice(0, 4)}-000${i}` } })).status);
      }
      record('rate.login', '錯太多次之後會被限速（429）', judgeLoginRate(statuses));
      log('  → 請到管理頁「密碼與登入」按「清除登入的限速紀錄」，否則這個 IP 要等到時間窗結束才能登入');
      return true;
    });
  }

  /* ----- 管理端 ----- */
  if (admin) {
    section = '管理端';
    log(`\n管理端：${admin}`);
    const adminSession = () => new Session(admin);
    /** 沒登入的請求被擋下來：轉到 Cloudflare Access 的網域（只看解析出來的主機名稱），或 401／403；而且回應裡沒有管理頁的內容 */
    const blocked = (r) => {
      const noContent = !r.text.includes('收件匣') && !r.text.includes('admin__');
      if ([401, 403].includes(r.status)) { return noContent; }
      const verdict = judgeAccessRedirect(r, admin, teamHost);
      return noContent && verdict.status !== 'fail';
    };
    const describe = (r) => {
      let host = '';
      try { host = r.location ? ' → ' + new URL(r.location, admin).hostname : ''; } catch (err) { host = ' → （不合法的網址）'; }
      return `HTTP ${r.status}${host}`;
    };
    await guarded('admin.flow', '管理端的檢查', async () => {
      for (const path of ['/', '/photos', '/content', '/access', '/export.json', '/admin.css', '/admin.js', `/photo/${options.photoId || fakeId}/full`]) {
        const r = await adminSession().request(path);
        check(`admin.blocked${path.replace(/[a-f0-9]{32}/, ':id')}`, `沒登入時 ${path.replace(/[a-f0-9]{32}/, '…')} 被擋下`, blocked(r), describe(r));
      }
      const token = 'eyJhbGciOiJub25lIn0.eyJlbWFpbCI6ImFAYi5jIn0.';
      const fake = await adminSession().request('/', { headers: { 'Cf-Access-Jwt-Assertion': token }, cookieHeader: `CF_Authorization=${token}` });
      check('admin.fake-token', '假的管理者憑證沒有用', blocked(fake), describe(fake));
      const post = await adminSession().request('/access/generate', { form: { csrf: 'x' } });
      check('admin.post-anon', '沒登入時不能產生新密碼', blocked(post), describe(post));
      if (options.photoId) {
        // 訪客的登入 cookie 在管理端沒有任何作用
        const withVisitorCookie = await adminSession().request(`/photo/${options.photoId}/full`, { cookieHeader: signedIn ? signedIn.cookieHeader() : `__Host-room-session=${randomBytes(32).toString('base64url')}` });
        check('admin.visitor-cookie', '訪客的登入 cookie 拿到管理端沒有用', blocked(withVisitorCookie) && !isJpeg(withVisitorCookie), describe(withVisitorCookie));
      }
      if (!options.local) {
        const first = await adminSession().request('/');
        const verdict = judgeAccessRedirect(first, admin, teamHost, options.aud || null);
        record('admin.access-host', '擋下請求的是 Cloudflare Access，而且是預期的團隊網域', verdict);
      }
      return true;
    });
  }

  /* ----- 其他入口：預覽網址、儲存桶的公開網址（有提供才檢查；沒提供的話要由人到後台確認） ----- */
  const extras = [...(options.previewUrls || []).map((url) => ['preview', url]), ...(options.bucketUrl ? [['bucket', options.bucketUrl]] : [])];
  if (extras.length) {
    section = '其他入口';
    log('\n其他入口');
    let n = 0;
    for (const [kind, url] of extras) {
      let outcome;
      try {
        const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
        const buffer = Buffer.from(await res.arrayBuffer());
        const headers = Object.fromEntries(['content-security-policy', 'x-robots-tag', 'permissions-policy'].map((name) => [name, res.headers.get(name) || '']));
        outcome = { status: res.status, location: res.headers.get('location') || '', text: buffer.toString('utf8'), headers, type: res.headers.get('content-type') || '', jpeg: buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 };
      } catch (err) {
        outcome = { error: (err.cause && err.cause.code) || err.name || 'error' };
      }
      const host = (() => { try { return new URL(url).host; } catch (err) { return url; } })();
      if (kind === 'preview') { n += 1; record(`preview.${n}`, `預覽網址沒有連到 Worker（${host}）`, judgePreviewUrl(outcome)); }
      else { record('bucket.public', `儲存桶的公開網址拿不到檔案（${host}）`, judgeBucketUrl(outcome)); }
    }
    if (!results.some((r) => r.section === '其他入口' && r.status === 'fail')) {
      log('  （這一類檢查只能抓到「開著」的情況；沒有抓到時仍然要到後台確認設定，見最後的人工項目）');
    }
  }

  const counts = { pass: 0, fail: 0, unknown: 0 };
  for (const entry of results) { counts[entry.status] += 1; }
  return { results, counts, manual: MANUAL_ITEMS.map(([title, how]) => ({ title, how })) };
}

/* ---------- 命令列 ---------- */

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (text) => { if (text.includes(question)) { rl.output.write(question); } };   // 輸入的字不顯示
    }
    rl.question(question, (answer) => { rl.close(); if (hidden) { process.stdout.write('\n'); } resolve(answer.trim()); });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const has = (name) => args.includes(name);
  const arg = (name) => { const i = args.indexOf(name); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; };
  const argAll = (name) => args.map((value, i) => (value === name ? args[i + 1] : null)).filter(Boolean);
  const local = has('--local');
  const urlOk = (u) => !!u && (/^https:\/\/[^/]+\/?$/.test(u) || (local && /^http:\/\/localhost:\d+\/?$/.test(u)));
  const usage = (message) => {
    console.error(`${message}\n用法：node scripts/check_deployed.mjs --visitor https://… [--admin https://…] [--team-domain 名稱.cloudflareaccess.com] [--photo-id …] [--reply] [--rate] [--aud …] [--preview-url https://…] [--r2-url https://…] [--report 檔名] [--no-prompt] [--local]`);
    process.exit(64);
  };
  for (const name of ['--password', '--pass', '-p']) { if (has(name)) { usage('密碼不可以寫在命令列（會留在指令紀錄裡）。請用環境變數 ROOM_TEST_PASSWORD，或執行時再輸入。'); } }
  if (!urlOk(arg('--visitor')) || (arg('--admin') && !urlOk(arg('--admin')))) { usage('請用 --visitor（與 --admin）指定網址：正式環境是 https://…，後面不要加路徑。'); }
  const photoId = arg('--photo-id');
  if (photoId && !/^[a-f0-9]{32}$/.test(photoId)) { usage('--photo-id 要是 32 個十六進位字（管理頁照片網址裡 /photo/ 後面那一段）。'); }
  if (arg('--team-domain') && !normalizeTeamDomain(arg('--team-domain'))) { usage('--team-domain 請寫成 <團隊名稱>.cloudflareaccess.com。'); }
  for (const url of [...argAll('--preview-url'), ...(arg('--r2-url') ? [arg('--r2-url')] : [])]) {
    if (!/^https:\/\/[^/]+/.test(url) && !(local && /^http:\/\/localhost:\d+/.test(url))) { usage('--preview-url 與 --r2-url 要是 https:// 開頭的完整網址。'); }
  }
  const interactive = !has('--no-prompt') && process.stdin.isTTY && process.stdout.isTTY;

  let password = process.env.ROOM_TEST_PASSWORD || '';
  if ((photoId || has('--reply')) && !password && interactive) { password = await ask('測試階段的訪客密碼（不會顯示）：', { hidden: true }); }

  const io = {
    log: (text) => console.log(text),
    act: async (kind, message) => {
      if (!interactive) { return false; }
      const answer = await ask(`\n  → ${message}\n    完成後按 Enter；要略過這一項請輸入 s 再按 Enter：`);
      return answer.toLowerCase() !== 's';
    },
    confirm: async (question) => {
      if (!interactive) { return null; }
      const answer = (await ask(`\n  → ${question}（y＝看到了／n＝沒有／Enter＝之後再確認）：`)).toLowerCase();
      return answer === 'y' ? true : (answer === 'n' ? false : null);
    },
    newPassword: async () => (interactive ? (await ask('    新的訪客密碼（不會顯示；直接按 Enter 略過）：', { hidden: true })) || null : null),
  };
  const options = { visitor: arg('--visitor'), admin: arg('--admin'), teamDomain: arg('--team-domain'), aud: arg('--aud'), local, rate: has('--rate'), reply: has('--reply'), photoId, password,
    previewUrls: argAll('--preview-url'), bucketUrl: arg('--r2-url') };
  const { results, counts, manual } = await runChecks(options, io);

  console.log(`\n結果：通過 ${counts.pass} 項、沒通過 ${counts.fail} 項、無法判定 ${counts.unknown} 項。`);
  if (counts.fail) { console.log('沒通過的：' + results.filter((r) => r.status === 'fail').map((r) => `\n  ✖ ${r.label}${r.detail ? `（${r.detail}）` : ''}`).join('')); }
  if (counts.unknown) { console.log('無法判定的（不算通過，請補做或用別的方式確認）：' + results.filter((r) => r.status === 'unknown').map((r) => `\n  ？ ${r.label}${r.detail ? `（${r.detail}）` : ''}`).join('')); }
  if (!photoId) { console.log('\n沒有指定 --photo-id：這一次沒有檢查「真的存在的圖片」在登入、登出、撤銷、換密碼前後的存取結果。'); }
  console.log('\n這個腳本檢查不到、仍然要由人確認的項目（請記在 ACCEPTANCE.md）：');
  manual.forEach((item, index) => console.log(`  ${index + 1}. ${item.title}：${item.how}`));

  if (arg('--report')) {
    const report = {
      checked_at: new Date().toISOString(), visitor: options.visitor, admin: options.admin || null, team_domain: normalizeTeamDomain(options.teamDomain),
      photo_checked: !!photoId, local, counts, results, manual,
    };
    writeFileSync(arg('--report'), JSON.stringify(report, null, 2) + '\n');
    console.log(`\n結果已寫到 ${arg('--report')}（不含密碼與 cookie）。`);
  }
  process.exit(counts.fail ? 1 : (counts.unknown ? 2 : 0));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error('檢查中斷：' + (err && err.message ? err.message : err)); process.exit(1); });
}
