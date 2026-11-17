// 訪客端 Worker：合言葉のページ。
//
// 原則：
// - 密碼只在這裡（伺服器）驗證。瀏覽器裡沒有任何「已登入」的旗標可以改；有沒有權限只看資料庫裡的登入狀態。
// - 每一次回應私人內容（頁面、縮圖、原圖、送出回覆）都重新檢查登入狀態。檢查不過、或檢查的過程出錯，一律不給。
// - 所有回應都是 private, no-store，不進任何共享快取。
// - 訪客只能看專區、送出回覆、登出。這個 Worker 裡沒有任何讀取回覆或管理用的路由（那些在另一個 Worker）。
//
// 回覆表單裡有兩個各自獨立的編號，用途不同、什麼時候換新也不同：
// - csrf：防偽造編號。和「這一次登入」綁在一起，重新登入就是新的。每一次寫入都先檢查登入狀態與它，兩項都通過才往下做。
// - nonce：送出編號（這一則回覆的操作識別碼）。只用來認出「同一次送出」，和登入無關：頁面顯示時發一個，
//   伺服器確認存好之後才換下一個。重新登入、防偽造編號更新、自動重送、沒有腳本時草稿跟著登入表單往返，它都不變。
//   所以「其實已經存進去、只是成功的回應沒有送到」的那一則，之後不管隔了幾次登入再送，資料庫裡都只有一筆。
//   它不是權限：知道編號不能做任何事，沒有通過登入與防偽造檢查的請求，連「是不是已經存過」都不會去查。

import {
  now, escapeHtml, randomToken, randomHex, sha256Hex, hmacHex, safeEqual, secretOk, parseCookies, cookie,
  html, json, text, redirect, sameOrigin, readForm, clientIp, logEvent, formatDate, HttpError, baseHeaders,
} from '../../shared/util.js';
import { normalizePassword, isInvitationPassword, hashPassword, pepperCheck } from '../../shared/password.js';
import {
  loadAuthState, createSession, findValidSession, deleteSession, sweep,
  rateTake, rateRefund, retryAfter, loadContent, listPhotos, getPhoto, insertReply, replyExists,
} from '../../shared/store.js';
import { LANGS, HTML_LANG, tr } from '../../shared/i18n.js';

const SESSION_COOKIE = '__Host-room-session';
const CSRF_COOKIE = '__Host-room-csrf';
const LANG_COOKIE = '__Host-room-lang';

const REPLY_MAX = 2000;
const ROOM_PAGE = { connect: true };   // 登入後的頁面：允許頁面上的腳本連回本站（送出回覆時不換頁）。其他頁面不需要，維持全部禁止
const LIMITS = {
  loginIp:      { window: 600,   max: 5 },     // 同一個 IP：10 分鐘內最多錯 5 次
  loginAll:     { window: 3600,  max: 200 },   // 全部加起來：1 小時內最多錯 200 次（擋分散式亂猜，也保護免費額度）
  replySession: { window: 600,   max: 5 },     // 同一次登入：10 分鐘內最多送 5 則
  replyDaily:   { window: 86400, max: 30 },    // 同一次登入：一天最多 30 則
  replyIp:      { window: 86400, max: 60 },    // 同一個 IP：一天最多 60 則
  replyAll:     { window: 86400, max: 200 },   // 所有人合計：一天最多 200 則（合言葉外流時，收件匣不會被灌爆；可用 REPLY_DAILY_CAP 調整）
};

function replyDailyCap(env) {
  const n = Number(env.REPLY_DAILY_CAP);
  return Number.isFinite(n) && n >= 1 && n <= 10000 ? Math.floor(n) : LIMITS.replyAll.max;
}

function ttlSeconds(env) {
  const n = Number(env.SESSION_TTL_SECONDS);
  return Number.isFinite(n) && n >= 1 && n <= 30 * 86400 ? Math.floor(n) : 7 * 86400;   // 預設 7 天，最長 30 天
}

/** 送出編號（表單欄位 nonce）：32 個十六進位字。格式不對就當作沒有（回傳空字串），不會原樣放回頁面 */
function submissionId(value) {
  const id = String(value || '');
  return /^[a-f0-9]{32}$/.test(id) ? id : '';
}

function pickLang(request) {
  const saved = parseCookies(request.headers.get('cookie'))[LANG_COOKIE];
  return LANGS.includes(saved) ? saved : 'ja';
}

/* ---------- 版面 ---------- */

function layout(env, lang, bodyHtml, { title = null } = {}) {
  const t = (key, params) => escapeHtml(tr(key, lang, params));
  const site = escapeHtml(env.PUBLIC_SITE_URL || '/');
  const langLink = (code, key) => `<a class="lang-switch__btn" href="/lang/${code}" lang="${HTML_LANG[code]}"${code === lang ? ' aria-current="true"' : ''}>${t(key)}</a>`;
  return `<!DOCTYPE html>
<html lang="${HTML_LANG[lang]}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="same-origin">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title || tr('pageTitle', lang))}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/room.css">
<script src="/room.js" defer></script>
</head>
<body class="letter-page room-page">
<header class="site-header">
  <div class="site-header__inner">
    <a class="brand" href="${site}">
      <svg class="brand__mark" viewBox="0 0 64 64" width="22" height="22" aria-hidden="true" focusable="false"><path d="M12 46a20 20 0 0 1 40 0" fill="none" stroke="#f3b9c9" stroke-width="4" stroke-linecap="round"/><g fill="#f1a8bc"><circle cx="32" cy="22" r="6.5"/><circle cx="41.5" cy="29" r="6.5"/><circle cx="37.9" cy="40.2" r="6.5"/><circle cx="26.1" cy="40.2" r="6.5"/><circle cx="22.5" cy="29" r="6.5"/></g><circle cx="32" cy="32" r="5" fill="#fff6e3"/></svg>
      <span class="brand__name">${t('siteName')}</span>
      <span class="brand__sub">${t('siteSub')}</span>
    </a>
    <div class="lang-switch" role="group" aria-label="${t('langLabel')}">${langLink('ja', 'langJa')}${langLink('zh', 'langZh')}</div>
  </div>
</header>
<main id="main">
<div class="room">
${bodyHtml}
<p class="room__back"><a class="link-arrow link-arrow--back" href="${site}">${t('backToSite')}</a></p>
</div>
</main>
<footer class="site-footer">
  <div class="site-footer__inner">
    <p class="site-footer__brand">${t('siteName')}</p>
    <p class="site-footer__line">${t('footer')}</p>
  </div>
</footer>
</body>
</html>`;
}

/** 登入前的頁面：只有說明與輸入欄，沒有任何私人內容 */
function gatePage(env, lang, csrf, { error = null, notice = null, params = null, draft = '', nonce = '' } = {}) {
  const t = (key, p) => escapeHtml(tr(key, lang, p));
  const message = error ? t(error, params) : (notice ? t(notice) : '');
  return layout(env, lang, `<section class="room__gate" aria-labelledby="room-heading">
  <h1 class="room__title" id="room-heading">${t('gateHeading')}</h1>
  <p class="room__lead">${t('gateLead')}</p>
  <form class="room__form" method="post" action="/login" autocomplete="off">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <label class="room__label" for="room-pass">${t('passwordLabel')}</label>
    <input class="room__input" id="room-pass" name="password" type="password" required maxlength="200" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="go" aria-describedby="room-status"${error && error !== 'errUnavailable' ? ' aria-invalid="true"' : ''}>
    <label class="room__show" hidden data-show-toggle="room-pass"><input type="checkbox"><span>${t('passwordShow')}</span></label>
    <button class="room__btn" type="submit">${t('open')}</button>
    <p class="room__status${error ? ' room__status--error' : ''}" id="room-status" role="status" aria-live="polite">${message}</p>
    ${draft && nonce ? `<input type="hidden" name="nonce" value="${escapeHtml(nonce)}">` : ''}
    ${draft ? `<label class="room__label" for="room-draft">${t('draftLabel')}</label>
    <textarea class="reply__input reply__input--draft" id="room-draft" name="draft" rows="6" readonly>${escapeHtml(draft)}</textarea>` : ''}
  </form>
</section>`);
}

function messagePage(env, lang, key) {
  return layout(env, lang, `<section class="room__gate"><h1 class="room__title">${escapeHtml(tr('gateHeading', lang))}</h1><p class="room__lead" role="status">${escapeHtml(tr(key, lang))}</p></section>`);
}

/** 登入後的頁面：標題、留言、照片、回覆表單、登出 */
function roomPage(env, lang, { content, photos, csrf, nonce, reply = {} }) {
  const t = (key, p) => escapeHtml(tr(key, lang, p));
  const pick = (pair) => pair[lang] || pair.ja || '';
  const paragraphs = pick(content.message).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const photoItems = photos.map((photo, index) => {
    const alt = (lang === 'zh' ? photo.alt_zh : photo.alt_ja) || photo.alt_ja || '';
    const caption = (lang === 'zh' ? photo.caption_zh : photo.caption_ja) || '';
    const date = photo.taken_on ? `<time class="room__caption-date" datetime="${escapeHtml(photo.taken_on)}">${escapeHtml(formatDate(photo.taken_on, lang))}</time>` : '';
    return `<li class="room__photo"><figure class="room__figure">
      <a class="room__photo-link" href="/photo/${photo.id}/full" data-photo aria-label="${t('photoOpen')}">
        <img class="room__img" src="/photo/${photo.id}/thumb" width="${photo.thumb_width}" height="${photo.thumb_height}" alt="${escapeHtml(alt)}"${index ? ' loading="lazy"' : ''} decoding="async">
      </a>
      ${caption || date ? `<figcaption class="room__caption">${caption ? `<span class="room__caption-text">${escapeHtml(caption)}</span>` : ''}${date}</figcaption>` : ''}
    </figure></li>`;
  }).join('\n');
  const status = reply.error ? t(reply.error, { max: REPLY_MAX }) : (reply.sent ? `${t('replySent')} ${t('replyAgain')}` : (reply.notice ? t(reply.notice) : ''));
  return layout(env, lang, `<article class="room__open" aria-labelledby="room-content-title">
  <h1 class="room__title" id="room-content-title">${escapeHtml(pick(content.title))}</h1>
  ${paragraphs.length ? `<div class="room__message">${paragraphs.map((p) => `<p class="room__p">${escapeHtml(p)}</p>`).join('')}</div>` : ''}
  ${content.signature ? `<p class="room__signature">${escapeHtml(content.signature)}</p>` : ''}
  ${photos.length ? `<h2 class="visually-hidden">${t('photosHeading')}</h2>
  <ul class="room__photos" role="list" data-photos data-close="${t('photoClose')}" data-prev="${t('photoPrev')}" data-next="${t('photoNext')}"
      data-loading="${t('photoLoading')}" data-failed="${t('photoFailed')}" data-retry="${t('photoRetry')}" data-session="${t('photoSession')}" data-signin="${t('relogin')}" data-gone="${t('photoGone')}">
${photoItems}
  </ul>` : ''}
  <section class="reply" id="reply" aria-labelledby="reply-title">
    <h2 class="reply__title" id="reply-title">${t('replyHeading')}</h2>
    <p class="reply__lead">${t('replyLead')}</p>
    <form class="reply__form" method="post" action="/reply" data-reply-form data-sending="${t('replySending')}" data-failed="${t('replyFailed')}" data-sent-kept="${t('replySentKept')}" data-session="${t('replySession')}">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="nonce" value="${escapeHtml(nonce)}">
      <label class="room__label" for="reply-body">${t('replyLabel')}</label>
      <textarea class="reply__input" id="reply-body" name="body" rows="6" maxlength="${REPLY_MAX}" required aria-describedby="reply-status"${reply.error ? ' aria-invalid="true"' : ''}>${escapeHtml(reply.body || '')}</textarea>
      <p class="reply__count" data-count data-template="${t('replyCount')}" data-max="${REPLY_MAX}"></p>
      <button class="room__btn" type="submit">${t('replySend')}</button>
      <p class="room__status${reply.error ? ' room__status--error' : ''}" id="reply-status" role="status" aria-live="polite">${status}</p>
    </form>
    <div class="relogin" id="relogin" hidden tabindex="-1" role="group" aria-labelledby="relogin-lead"
        data-lead-reply="${t('reloginLeadReply')}" data-lead-photo="${t('reloginLeadPhoto')}" data-busy="${t('reloginBusy')}" data-done="${t('reloginDone')}"
        data-done-reply="${t('draftRestored')}" data-failed="${t('reloginFailed')}" data-empty="${t('errEmpty')}" data-copied="${t('copied')}" data-copy-failed="${t('copyFailed')}">
      <p class="relogin__lead" id="relogin-lead"></p>
      <div class="relogin__copy" data-copy>
        <button class="room__btn room__btn--small" type="button" data-copy-button>${t('copyDraft')}</button>
        <p class="room__status" role="status" aria-live="polite" data-copy-status></p>
      </div>
      <form class="relogin__form" method="post" action="/login" autocomplete="off" data-relogin-form>
        <input type="hidden" name="csrf" value="">
        <label class="room__label" for="relogin-pass">${t('passwordLabel')}</label>
        <input class="room__input" id="relogin-pass" name="password" type="password" required maxlength="200" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="go" aria-describedby="relogin-status">
        <label class="room__show" hidden data-show-toggle="relogin-pass"><input type="checkbox"><span>${t('passwordShow')}</span></label>
        <button class="room__btn" type="submit">${t('relogin')}</button>
        <p class="room__status" id="relogin-status" role="status" aria-live="polite"></p>
      </form>
    </div>
  </section>
  <form class="room__logout" method="post" action="/logout">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <button class="room__lock-btn" type="submit">${t('logout')}</button>
  </form>
</article>`, { title: pick(content.title) ? `${pick(content.title)}｜AYAKA` : null });
}

/* ---------- 登入狀態 ---------- */

/** 從 cookie 找出有效的登入狀態。沒有 cookie、格式不對、資料庫裡沒有、過期、密碼換過、被撤銷 → null */
async function currentSession(request, env) {
  const token = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) { return null; }
  const idHash = await sha256Hex(token);
  const state = await loadAuthState(env.DB);
  const row = await findValidSession(env.DB, idHash, state);
  if (!row) { return null; }
  return { idHash, csrf: await hmacHex(env.SESSION_SECRET, 'csrf:' + idHash), ref: (await hmacHex(env.SESSION_SECRET, 'ref:' + idHash)).slice(0, 12) };
}

function clearSessionCookie() { return ['Set-Cookie', cookie(SESSION_COOKIE, '', { maxAge: 0 })]; }

/** 登入表單用的防偽造編號（雙重送出）：cookie 和表單隱藏欄位要一致 */
function loginCsrf(request) {
  const existing = parseCookies(request.headers.get('cookie'))[CSRF_COOKIE];
  if (existing && /^[a-f0-9]{32}$/.test(existing)) { return { value: existing, headers: [] }; }
  const value = randomHex(16);
  return { value, headers: [['Set-Cookie', cookie(CSRF_COOKIE, value, { maxAge: 86400, sameSite: 'Strict' })]] };
}

async function ipBucket(env, prefix, request) {
  return prefix + (await hmacHex(env.SESSION_SECRET, 'ip:' + clientIp(request))).slice(0, 32);
}

/* ---------- 路由 ---------- */

async function showPage(request, env, lang, url) {
  const session = await currentSession(request, env);
  if (!session) {
    const csrf = loginCsrf(request);
    const notice = url.searchParams.get('out') === '1' ? 'loggedOut' : null;
    return html(gatePage(env, lang, csrf.value, { notice }), 200, csrf.headers);
  }
  const [content, photos] = await Promise.all([loadContent(env.DB), listPhotos(env.DB)]);
  return html(roomPage(env, lang, { content, photos, csrf: session.csrf, nonce: randomHex(16), reply: { sent: url.searchParams.get('sent') === '1' } }), 200, [], ROOM_PAGE);
}

async function handleLogin(request, env, ctx, lang) {
  // 兩種用法共用同一套檢查（防偽造編號、限速、密碼比對）：
  // - 一般的表單（登入頁）。登入過期時還沒確認送出的回覆會放在這個表單的 draft 欄位裡，登入成功後直接帶回回覆的輸入欄
  // - 頁面上的腳本（Accept: application/json）：登入過期後不離開頁面重新登入，回應是 JSON
  const wantsJson = (request.headers.get('accept') || '').includes('application/json');
  const form = await readForm(request, 32 * 1024);
  const draft = Array.from(cleanReply(form.get('draft'))).slice(0, REPLY_MAX).join('');
  // 草稿的送出編號跟著草稿一起往返：登入之後再送出時，用的還是原本那一則的編號
  const draftNonce = draft ? submissionId(form.get('nonce')) : '';
  const csrf = loginCsrf(request);
  const respond = (status, error, { params = null, extra = [] } = {}) => {
    if (wantsJson) { return json({ ok: false, code: error, message: tr(error, lang, params) }, status, [...csrf.headers, ...extra]); }
    return html(gatePage(env, lang, csrf.value, { error, params, draft, nonce: draftNonce }), status, [...csrf.headers, ...extra]);
  };
  const sent = String(form.get('csrf') || '');
  if (!sent || !(await safeEqual(sent, csrf.value)) || csrf.headers.length) { return respond(403, 'errExpired'); }
  const password = String(form.get('password') || '');
  if (!normalizePassword(password)) { return respond(400, 'errEmpty'); }

  // 限速：先把這一次算進去，再決定要不要受理。超過上限的嘗試不會被拿去比對密碼
  const limited = (windowSeconds) => {
    const wait = retryAfter(windowSeconds);
    logEvent('login_rate_limited');
    return respond(429, 'errLimited', { params: { minutes: Math.max(1, Math.ceil(wait / 60)) }, extra: [['Retry-After', String(wait)]] });
  };
  const ipTake = await rateTake(env.DB, [{ bucket: await ipBucket(env, 'login:ip:', request), window: LIMITS.loginIp.window }]);
  if (ipTake.counts[0] > LIMITS.loginIp.max) { return limited(LIMITS.loginIp.window); }
  const allTake = await rateTake(env.DB, [{ bucket: 'login:all', window: LIMITS.loginAll.window }]);
  if (allTake.counts[0] > LIMITS.loginAll.max) {
    await rateRefund(env.DB, ipTake.keys);          // 這一次沒有被受理，不算在這個 IP 頭上
    return limited(LIMITS.loginAll.window);
  }

  const state = await loadAuthState(env.DB);
  if (state.pepperCheck && !(await safeEqual(state.pepperCheck, await pepperCheck(env.PEPPER)))) {
    // 訪客端與管理端的 PEPPER 不一樣（部署設定的問題）：密碼不可能比對成功。不當成對方打錯，也不算進限速
    await rateRefund(env.DB, [...ipTake.keys, ...allTake.keys]);
    logEvent('config_pepper_mismatch');
    if (wantsJson) { return json({ ok: false, code: 'errUnavailable', message: tr('errUnavailable', lang) }, 503); }
    return html(messagePage(env, lang, 'errUnavailable'), 503);
  }
  // 只受理邀請密碼的格式（整理之後是 32 個十六進位字）。其他寫法一律當作不對，連比對都不做：
  // 資料庫裡就算有別種密碼的雜湊，也不會被拿來比對
  let ok = false;
  if (state.passwordHash && password.length <= 200 && isInvitationPassword(password)) {
    ok = await safeEqual(await hashPassword(env.PEPPER, password), state.passwordHash);
  }
  if (!ok) {
    logEvent('login_failed');                        // 錯的那一次留在計數裡
    return respond(401, 'errWrong');
  }
  await rateRefund(env.DB, [...ipTake.keys, ...allTake.keys]);   // 上限算的是「錯了幾次」，成功的不算
  const token = randomToken(32);
  const ttl = ttlSeconds(env);
  const idHash = await sha256Hex(token);
  await createSession(env.DB, idHash, ttl, state);
  ctx.waitUntil(sweep(env.DB).catch(() => {}));   // 清理時不帶這裡讀到的 state：那可能已經是舊的
  logEvent('login_ok');
  const sessionCookie = ['Set-Cookie', cookie(SESSION_COOKIE, token, { maxAge: ttl })];
  const replyCsrf = await hmacHex(env.SESSION_SECRET, 'csrf:' + idHash);
  if (wantsJson) {
    // 頁面還開著：只把新的防偽造編號交給頁面。送出編號不在這裡發——頁面上寫到一半（或送到一半）的那一則，
    // 要繼續用它原本的編號
    return json({ ok: true, csrf: replyCsrf, message: tr('reloginDone', lang) }, 200, [sessionCookie]);
  }
  if (draft) {
    // 沒有腳本時的路徑：登入過期前寫到一半的回覆跟著登入表單一起送回來，直接放回回覆的輸入欄（這一步不會送出；
    // 它之前有沒有存進去，這裡不知道，所以畫面上說的是「還無法確認」），
    // 連同它原本的送出編號（沒有帶、或格式不對時才發新的）
    const [content, photos] = await Promise.all([loadContent(env.DB), listPhotos(env.DB)]);
    return html(roomPage(env, lang, { content, photos, csrf: replyCsrf, nonce: draftNonce || randomHex(16), reply: { body: draft, notice: 'draftRestored' } }), 200, [sessionCookie], ROOM_PAGE);
  }
  return redirect('/', [sessionCookie]);
}

/** 頁面上的腳本用：現在是不是登入中，以及登入表單要用的防偽造編號（登入過期後不離開頁面重新登入時用） */
async function sessionInfo(request, env) {
  const csrf = loginCsrf(request);
  const session = await currentSession(request, env);
  // reply：登入中的話，回覆表單目前該用的防偽造編號（和頁面 HTML 裡的是同一種值；這個回應只有本站自己的頁面讀得到）。
  // 頁面上的防偽造編號過期時（例如在另一個分頁重新登入過）用它換新的。這裡不發送出編號：換防偽造編號不等於換一則回覆
  return json({ signedIn: !!session, csrf: csrf.value, reply: session ? { csrf: session.csrf } : null }, 200, csrf.headers);
}

async function handleLogout(request, env) {
  const form = await readForm(request, 4096);
  const session = await currentSession(request, env);
  if (session) {
    if (!(await safeEqual(String(form.get('csrf') || ''), session.csrf))) { throw new HttpError(403, 'bad-csrf'); }
    await deleteSession(env.DB, session.idHash);
    logEvent('logout');
  }
  return redirect('/?out=1', [clearSessionCookie()]);
}

function cleanReply(raw) {
  // 換行統一成 \n，去掉換行與定位以外的控制字元，頭尾的空白不算
  const CONTROL = new RegExp('[' + '\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f' + ']', 'g');
  return String(raw || '').replace(/\r\n?/g, '\n').replace(CONTROL, '').trim();
}

async function handleReply(request, env, lang) {
  const wantsJson = (request.headers.get('accept') || '').includes('application/json');
  const form = await readForm(request, 32 * 1024);
  const body = cleanReply(form.get('body'));
  const nonce = submissionId(form.get('nonce'));      // 這一則回覆的送出編號（格式不對就是空字串）
  const session = await currentSession(request, env);
  if (!session) {
    // 登入已失效：這一次不儲存，也不再顯示任何私人內容。
    // 這一則有可能在前一次嘗試時已經存好（成功的回應沒送到），所以說明用「無法確認有沒有送出」，不說「還沒送出」
    // 頁面上的腳本會把內容留在輸入欄，並顯示「複製」與「重新登入」（不離開頁面）；送出編號留在頁面的表單裡不動
    if (wantsJson) { return json({ ok: false, code: 'session', message: tr('replySession', lang) }, 401, [clearSessionCookie()]); }
    const csrf = loginCsrf(request);
    // 沒有腳本時：這段內容是訪客自己剛剛打的字，放回登入表單裡（唯讀、經過 escapeHtml），旁邊帶著它的送出編號；
    // 登入成功後兩者一起回到回覆的表單。內容只在請求與回應之間傳遞，伺服器不會存下來
    return html(gatePage(env, lang, csrf.value, { error: 'replySessionGate', draft: Array.from(body).slice(0, REPLY_MAX).join(''), nonce }), 401, [clearSessionCookie(), ...csrf.headers]);
  }
  const fail = async (status, error, extra = []) => {
    // 畫面上的說明：表單過期時用回覆專用的那一句（無法確認結果、內容留著、可以再送）。
    // 回應裡的 code 不變——頁面上的腳本靠 errExpired 判斷要不要換防偽造編號後自動重送
    const say = error === 'errExpired' ? 'replyExpired' : error;
    if (wantsJson) { return json({ ok: false, code: error, message: tr(say, lang, { max: REPLY_MAX }) }, status, extra); }
    const [content, photos] = await Promise.all([loadContent(env.DB), listPhotos(env.DB)]);
    // 失敗時把剛剛寫的內容放回輸入欄（經過 escapeHtml），沿用同一個送出編號，重送也不會存成兩筆；
    // 防偽造編號則換成目前這次登入的
    return html(roomPage(env, lang, { content, photos, csrf: session.csrf, nonce: nonce || randomHex(16), reply: { error: say, body } }), status, extra, ROOM_PAGE);
  };
  // 先確認權限：登入有效（上面）、防偽造編號是目前這次登入的。這兩項沒過，後面的去重與寫入都不會做
  if (!(await safeEqual(String(form.get('csrf') || ''), session.csrf))) { return fail(403, 'errExpired'); }
  if (!nonce) { return fail(400, 'errExpired'); }
  if (!body) { return fail(400, 'replyEmpty'); }
  if (Array.from(body).length > REPLY_MAX) { return fail(400, 'replyTooLong'); }

  // 去重：同一個送出編號、同樣的內容已經存過了（例如第一次其實有存進去，只是成功的回應沒有送到頁面）：
  // 不再存一筆，直接回報成功。
  // 這個識別只由「送出編號＋內容」決定，不含任何和登入有關的值：重新登入之後再送同一則，認得出是同一次送出。
  // 也不是只比內容：開始下一則時頁面會拿到新的送出編號，所以同樣的文字可以再送一則。
  const dedupeKey = await sha256Hex(`reply:${nonce}:${body}`);
  const done = () => {
    // 伺服器確認這一則已經存好，才把下一則要用的送出編號交給頁面
    if (wantsJson) { return json({ ok: true, message: `${tr('replySent', lang)} ${tr('replyAgain', lang)}`, nonce: randomHex(16) }); }
    return redirect('/?sent=1#reply');
  };
  if (await replyExists(env.DB, dedupeKey)) { return done(); }

  // 限速：先把這一次算進去，再決定要不要受理
  const take = await rateTake(env.DB, [
    { bucket: 'reply:session:' + session.ref, window: LIMITS.replySession.window },
    { bucket: 'reply:session:' + session.ref + ':day', window: LIMITS.replyDaily.window },
    { bucket: await ipBucket(env, 'reply:ip:', request), window: LIMITS.replyIp.window },
    { bucket: 'reply:all', window: LIMITS.replyAll.window },
  ]);
  const [recent, daily, ipDaily, allDaily] = take.counts;
  if (recent > LIMITS.replySession.max || daily > LIMITS.replyDaily.max || ipDaily > LIMITS.replyIp.max || allDaily > replyDailyCap(env)) {
    await rateRefund(env.DB, take.keys);            // 沒有受理的這一次不算
    logEvent('reply_rate_limited');
    const wait = recent > LIMITS.replySession.max ? retryAfter(LIMITS.replySession.window) : retryAfter(LIMITS.replyDaily.window);
    return fail(429, 'replyLimited', [['Retry-After', String(wait)]]);
  }

  try {
    const result = await insertReply(env.DB, { id: randomHex(16), sessionRef: session.ref, lang, body, dedupeKey });
    if (result.duplicate) { await rateRefund(env.DB, take.keys); }   // 同時送了兩次：只存一筆，也只算一次
    logEvent('reply_saved');
  } catch (err) {
    await rateRefund(env.DB, take.keys).catch(() => {});
    logEvent('reply_store_failed');
    return fail(500, 'replyFailed');
  }
  // 到這裡才算送出成功：資料庫已經寫入
  return done();
}

async function servePhoto(request, env, path) {
  const match = /^\/photo\/([a-f0-9]{32})\/(thumb|full)$/.exec(path);
  if (!match) { return text('Not found', 404); }
  const session = await currentSession(request, env);
  if (!session) { return text('Unauthorized', 401); }
  const photo = await getPhoto(env.DB, match[1]);
  if (!photo) { return text('Not found', 404); }
  const object = await env.PHOTOS.get(`photos/${match[1]}/${match[2]}.jpg`);
  if (!object) { return text('Not found', 404); }
  const headers = new Headers({ ...baseHeaders(), 'Content-Type': 'image/jpeg', 'Content-Length': String(object.size), 'Content-Disposition': 'inline' });
  return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
}

function setLang(code) {
  if (!LANGS.includes(code)) { return text('Not found', 404); }
  return redirect('/', [['Set-Cookie', cookie(LANG_COOKIE, code, { maxAge: 365 * 86400 })]]);
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const lang = pickLang(request);
  const method = request.method;

  if (method === 'GET' || method === 'HEAD') {
    // 不擋爬蟲讀取：這樣搜尋引擎才看得到每個回應上的「noindex」，不會把網址列進搜尋結果（擋住反而可能只列出網址）。
    // 沒登入的爬蟲能讀到的只有登入表單
    if (path === '/robots.txt') { return text('User-agent: *\nDisallow:\n'); }
    if (path.startsWith('/lang/')) { return setLang(path.slice(6)); }
    if (path === '/' && LANGS.includes(url.searchParams.get('lang'))) { return setLang(url.searchParams.get('lang')); }
    // 金鑰沒設定好時，整個服務視為不可用：不驗證、不給任何內容
    if (!secretOk(env.PEPPER) || !secretOk(env.SESSION_SECRET)) {
      return path === '/' ? html(messagePage(env, lang, 'errUnavailable'), 503) : text('Unavailable', 503);
    }
    if (path === '/') { return showPage(request, env, lang, url); }
    if (path === '/session') { return sessionInfo(request, env); }
    if (path.startsWith('/photo/')) { return servePhoto(request, env, path); }
    return html(messagePage(env, lang, 'notFound'), 404);
  }

  if (method === 'POST') {
    if (!secretOk(env.PEPPER) || !secretOk(env.SESSION_SECRET)) { return html(messagePage(env, lang, 'errUnavailable'), 503); }
    if (!sameOrigin(request)) { return text('Forbidden', 403); }
    if (path === '/login') { return handleLogin(request, env, ctx, lang); }
    if (path === '/logout') { return handleLogout(request, env); }
    if (path === '/reply') { return handleReply(request, env, lang); }
    return text('Not found', 404);
  }

  return text('Method not allowed', 405, [['Allow', 'GET, HEAD, POST']]);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      if (err instanceof HttpError) { return text(err.code, err.status); }
      // 任何沒預期到的錯誤（包含資料庫或驗證出錯）：不給私人內容，只回一般的錯誤頁
      logEvent('unhandled_error');
      let lang = 'ja';
      try { lang = pickLang(request); } catch (e) { /* 用預設語言 */ }
      const wantsHtml = (request.headers.get('accept') || '').includes('text/html');
      return wantsHtml ? html(messagePage(env, lang, 'errGeneric'), 500) : text('Error', 500);
    }
  },
};
