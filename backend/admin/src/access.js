// 管理者身分的驗證：Cloudflare Access。
//
// 管理端整個放在 Cloudflare Access 後面：登入與多因素驗證由 Cloudflare（和它接的登入方式）負責，
// 這個 Worker 不處理任何管理者密碼。Access 驗證過的身分會用下面兩種方式之一交給 Worker，兩種都接受：
//
//   1. ctx.access —— 把 Access 直接掛在 Worker 上時（2026 年 8 月之後的做法），平台會把驗證過的身分放在這裡；
//      沒通過 Access 的請求，ctx.access 是 undefined。這個值由平台提供，請求的人無法偽造。
//   2. Cf-Access-Jwt-Assertion 標頭 —— 以網址為單位的 Access 應用程式（例如 workers.dev 的一鍵啟用）會附上簽章過的憑證。
//      這裡用成熟的程式庫 jose 驗證：簽章、發行者（團隊網域）、期限、對象（AUD）。
//
// 不論哪一種，都還要再確認兩件事：對象（AUD）是這個應用程式、信箱是站主本人。
// 任何一項不符、或設定不完整，一律拒絕（預設拒絕）。

import { jwtVerify, createRemoteJWKSet } from 'jose';

export class AccessError extends Error {
  /** code：拒絕的原因（會寫進日誌）；detail：給站主排查設定用的說明（只在請求已經通過 Access 的驗證時才有） */
  constructor(code, detail = '') { super(code); this.code = code; this.detail = detail; }
}

const keySets = new Map();

const TEAM_PATTERN = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/;
// 本機測試用的模擬 Access 只能在這台電腦上（127.0.0.1／localhost）。部署到 Cloudflare 的 Worker 連不到這種位址，
// 所以就算正式環境誤設了 ENVIRONMENT=local，也沒辦法把驗證導向別人的金鑰
const LOOPBACK_PATTERN = /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/;

export async function requireAdmin(request, env, ctx) {
  const audience = String(env.POLICY_AUD || '').trim();
  const emails = String(env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@'));
  if (!audience || /REPLACE/i.test(audience) || !emails.length) { throw new AccessError('not-configured'); }

  const allow = (email, via) => {
    const address = String(email || '').toLowerCase();
    if (!address) { throw new AccessError('no-email'); }
    if (!emails.includes(address)) { throw new AccessError('not-allowed', `登入的信箱是 ${address}，不在 ADMIN_EMAILS 裡`); }
    return { email: address, via };
  };

  // 1. Access 掛在 Worker 上：身分在 ctx.access
  const access = ctx && ctx.access;
  if (access) {
    const aud = String(access.aud || '');
    if (aud !== audience) { throw new AccessError('aud-mismatch', `這個請求通過的 Access 應用程式的 AUD 是 ${aud}，和 POLICY_AUD 的設定不同`); }
    let identity = null;
    try { identity = await access.getIdentity(); } catch (err) { throw new AccessError('identity-unavailable'); }
    return allow(identity && identity.email, 'ctx');
  }

  // 2. 以網址為單位的 Access：驗證標頭裡的憑證
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) { throw new AccessError('missing-token'); }
  const team = String(env.TEAM_DOMAIN || '').trim().replace(/\/+$/, '');
  const local = env.ENVIRONMENT === 'local';   // 只有本機測試會設定；正式環境沒有這個變數
  if (!(TEAM_PATTERN.test(team) || (local && LOOPBACK_PATTERN.test(team)))) { throw new AccessError('not-configured'); }

  // 公鑰來源：固定是 Access 團隊網域的 /cdn-cgi/access/certs（本機測試時是模擬 Access 的同一個路徑）
  const certsUrl = team + '/cdn-cgi/access/certs';
  let keys = keySets.get(certsUrl);
  if (!keys) { keys = createRemoteJWKSet(new URL(certsUrl)); keySets.set(certsUrl, keys); }

  let payload;
  try {
    // 只接受 RS256（Access 用的演算法）；簽章、發行者、期限任何一項不對都會丟出錯誤
    ({ payload } = await jwtVerify(token, keys, { issuer: team, algorithms: ['RS256'] }));
  } catch (err) {
    throw new AccessError('invalid-token');
  }
  // 對象（AUD）：這張憑證必須是發給「這個」應用程式的。簽章已經驗過，所以不符時可以把憑證上的值告訴站主，方便修正設定
  const tokenAud = [].concat(payload.aud || []).map(String);
  if (!tokenAud.includes(audience)) { throw new AccessError('aud-mismatch', `憑證的 AUD 是 ${tokenAud.join(', ') || '（空的）'}，和 POLICY_AUD 的設定不同`); }
  return allow(payload.email, 'jwt');
}
