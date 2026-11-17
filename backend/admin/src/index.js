// 管理端 Worker：站主的收件匣、照片管理、標題與留言、訪客密碼與登入狀態。
//
// 原則：
// - 每一個請求（包含樣式與腳本）都先通過 requireAdmin：沒有通過 Cloudflare Access、或信箱不是站主，一律 403。
//   樣式、腳本與圖示包在程式裡（static.generated.js），不使用「靜態檔案」功能，所以沒有任何檔案會繞過這個檢查。
// - 訪客密碼在這裡完全沒有用：拿訪客的登入 cookie 來這裡，什麼都拿不到。
// - 訪客寫的回覆一律經過 escapeHtml 才放進頁面，只會被當成文字。
// - 會改資料的動作都是 POST，並檢查 Origin 與防偽造編號。

import {
  now, escapeHtml, randomHex, hmacHex, safeEqual, secretOk, html, json, text, redirect, sameOrigin,
  readForm, readBody, HttpError, baseHeaders, formatTime, logEvent,
} from '../../shared/util.js';
import { hashPassword, pepperCheck, generatePassword } from '../../shared/password.js';
import {
  loadAuthState, countActiveSessions, setSettingStatement, loadContent, listPhotos, getPhoto,
  listReplies, countReplies, auditStatement, listAudit, replacePassword,
} from '../../shared/store.js';
import { inspectJpeg, stripJpeg } from '../../shared/jpeg.js';
import { requireAdmin, AccessError } from './access.js';
import { STATIC_FILES } from './static.generated.js';

const PAGE_SIZE = 50;
const MAX_FULL_BYTES = 4 * 1024 * 1024;
const MAX_THUMB_BYTES = 600 * 1024;
const MAX_UPLOAD_BYTES = MAX_FULL_BYTES + MAX_THUMB_BYTES + 64 * 1024;   // 一次上傳（原圖＋縮圖＋說明文字）最多讀進這麼多
const AUDIT_TEXT = {
  password_generate: '產生新的訪客密碼', sessions_revoke: '撤銷所有訪客的登入', login_unlock: '清除登入的限速紀錄',
  photo_upload: '上傳照片', photo_update: '修改照片說明', photo_delete: '刪除照片', content_update: '修改標題與留言',
  reply_delete: '刪除回覆', export: '匯出回覆',
};
/* ---------- 防偽造編號（12 小時一換，接受前一個時段的） ---------- */
async function csrfTokens(env, email) {
  const slot = Math.floor(now() / 43200);
  return Promise.all([slot, slot - 1].map((s) => hmacHex(env.SESSION_SECRET, `admin-csrf:${email}:${s}`)));
}
async function checkCsrf(env, email, value) {
  const [current, previous] = await csrfTokens(env, email);
  const v = String(value || '');
  return !!v && ((await safeEqual(v, current)) || (await safeEqual(v, previous)));
}

/* ---------- 版面 ---------- */
function layout(env, admin, csrf, active, title, body) {
  const nav = [['/', '收件匣'], ['/photos', '照片'], ['/content', '標題與留言'], ['/access', '密碼與登入']]
    .map(([href, label]) => `<a class="admin__nav-link" href="${href}"${href === active ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  const visitor = env.VISITOR_URL ? `<a href="${escapeHtml(env.VISITOR_URL)}" rel="noopener noreferrer" target="_blank">打開訪客看到的頁面</a> · ` : '';
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}｜管理頁</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/room.css">
<link rel="stylesheet" href="/admin.css">
<script src="/admin.js" defer></script>
</head>
<body class="admin" data-csrf="${escapeHtml(csrf)}">
<header class="admin__header">
  <p class="admin__brand">合言葉のページ　管理頁</p>
  <nav class="admin__nav" aria-label="管理頁選單">${nav}</nav>
  <p class="admin__who">${visitor}${escapeHtml(admin.email)} · <a href="/cdn-cgi/access/logout">登出</a></p>
</header>
<main class="admin__main" id="main">
<h1 class="admin__title">${escapeHtml(title)}</h1>
${body}
</main>
</body>
</html>`;
}

const hidden = (csrf) => `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
const notice = (url) => {
  const map = { saved: '已儲存。', deleted: '已刪除。', uploaded: '照片已上傳。', revoked: '已撤銷所有訪客的登入。', unlocked: '已清除登入的限速紀錄。' };
  const key = url.searchParams.get('ok');
  return map[key] ? `<p class="admin__notice" role="status">${map[key]}</p>` : '';
};

/* ---------- 收件匣 ---------- */
async function inboxPage(env, admin, csrf, url) {
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const [total, replies] = await Promise.all([countReplies(env.DB), listReplies(env.DB, PAGE_SIZE, (page - 1) * PAGE_SIZE)]);
  const langName = { ja: '日文頁面', zh: '中文頁面' };
  const items = replies.map((r) => `<article class="admin__reply">
    <p class="admin__meta"><time datetime="${new Date(r.created_at * 1000).toISOString()}">${formatTime(r.created_at)}</time>（日本時間）· ${langName[r.lang] || escapeHtml(r.lang)} · 登入代號 ${escapeHtml(r.session_ref)}</p>
    <p class="admin__body">${escapeHtml(r.body)}</p>
    <form method="post" action="/replies/${escapeHtml(r.id)}/delete" data-confirm="確定要刪除這一則回覆嗎？刪除後無法復原。">${hidden(csrf)}<button class="admin__btn admin__btn--quiet" type="submit">刪除</button></form>
  </article>`).join('\n');
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pager = pages > 1 ? `<p class="admin__pager">${page > 1 ? `<a href="/?page=${page - 1}">較新的</a>` : ''} 第 ${page} / ${pages} 頁 ${page < pages ? `<a href="/?page=${page + 1}">較舊的</a>` : ''}</p>` : '';
  return layout(env, admin, csrf, '/', '收件匣', `${notice(url)}
<p class="admin__lead">共 ${total} 則。這些回覆來自<strong>持有訪客密碼的人</strong>；網站無法確認寫的人是誰，請不要把它當成已驗證身分的訊息。「登入代號」相同表示是同一次登入送出的。</p>
${total ? `<p class="admin__actions"><a class="admin__btn" href="/export.json">匯出全部（JSON）</a></p>` : ''}
<div class="admin__replies">${items || '<p class="admin__empty">還沒有回覆。</p>'}</div>
${pager}`);
}

/* ---------- 照片 ---------- */
const photoFields = (p = {}) => `
  <label class="admin__field"><span>照片內容的描述（日文，給螢幕閱讀器）</span><input name="alt_ja" maxlength="200" value="${escapeHtml(p.alt_ja || '')}" required></label>
  <label class="admin__field"><span>照片內容的描述（中文）</span><input name="alt_zh" maxlength="200" value="${escapeHtml(p.alt_zh || '')}" required></label>
  <label class="admin__field"><span>照片下方的一句話（日文，可留空）</span><input name="caption_ja" maxlength="300" value="${escapeHtml(p.caption_ja || '')}"></label>
  <label class="admin__field"><span>照片下方的一句話（中文，可留空）</span><input name="caption_zh" maxlength="300" value="${escapeHtml(p.caption_zh || '')}"></label>
  <label class="admin__field"><span>日期（可留空）</span><input name="taken_on" type="date" value="${escapeHtml(p.taken_on || '')}"></label>`;

async function photosPage(env, admin, csrf, url) {
  const photos = await listPhotos(env.DB);
  const items = photos.map((p) => `<article class="admin__photo">
    <img class="admin__thumb" src="/photo/${p.id}/thumb" width="${p.thumb_width}" height="${p.thumb_height}" alt="${escapeHtml(p.alt_zh || p.alt_ja)}" loading="lazy">
    <form class="admin__form" method="post" action="/photos/${p.id}">${hidden(csrf)}${photoFields(p)}
      <label class="admin__field"><span>順序（數字小的在前）</span><input name="position" type="number" min="0" max="999" value="${p.position}"></label>
      <button class="admin__btn" type="submit">儲存</button>
    </form>
    <form method="post" action="/photos/${p.id}/delete" data-confirm="確定要刪除這張照片嗎？原圖與縮圖都會從儲存空間移除。">${hidden(csrf)}<button class="admin__btn admin__btn--quiet" type="submit">刪除這張照片</button></form>
    <p class="admin__meta">${p.width}×${p.height}（縮圖 ${p.thumb_width}×${p.thumb_height}）· 編號 <span data-photo-id>${p.id}</span></p>
  </article>`).join('\n');
  return layout(env, admin, csrf, '/photos', '照片', `${notice(url)}
<section class="admin__section">
  <h2 class="admin__h2">上傳一張照片</h2>
  <p class="admin__lead">選好照片後，瀏覽器會先把它重新編碼（縮小、轉正）再上傳，原始檔不會離開這台裝置。伺服器收到後還會再處理一次：拍攝地點、裝置、時間等附加資料一律不寫進儲存空間。</p>
  <p class="admin__lead">第一次放<strong>真正的照片</strong>之前，請先用範例圖完成正式環境的驗收（管理端的第二因子、其他入口、CPU 用量、真實手機；清單在 repo 的 <code>backend/ACCEPTANCE.md</code>）。</p>
  <form class="admin__form" data-upload-form>
    <label class="admin__field"><span>照片檔案（JPEG、PNG、HEIC 等瀏覽器看得懂的格式）</span><input name="file" type="file" accept="image/*" required></label>
    ${photoFields()}
    <button class="admin__btn" type="submit">處理並上傳</button>
    <p class="admin__status" role="status" aria-live="polite" data-upload-status></p>
  </form>
  <noscript><p class="admin__lead">上傳照片需要 JavaScript（去掉照片裡的拍攝地點等資料是在瀏覽器裡做的）。</p></noscript>
</section>
<section class="admin__section">
  <h2 class="admin__h2">目前的照片（${photos.length} 張）</h2>
  <div class="admin__photos">${items || '<p class="admin__empty">還沒有照片。</p>'}</div>
</section>`);
}

function cleanText(value, max) {
  return String(value || '').replace(/\r\n?/g, '\n').trim().slice(0, max);
}
function photoMeta(form) {
  const date = String(form.get('taken_on') || '');
  return {
    alt_ja: cleanText(form.get('alt_ja'), 200), alt_zh: cleanText(form.get('alt_zh'), 200),
    caption_ja: cleanText(form.get('caption_ja'), 300), caption_zh: cleanText(form.get('caption_zh'), 300),
    taken_on: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
  };
}

async function uploadPhoto(request, env, admin) {
  const type = (request.headers.get('content-type') || '').toLowerCase();
  if (!type.startsWith('multipart/form-data')) { throw new HttpError(415, 'unsupported-type'); }
  // 先用有上限的方式把內容讀進來（超過上限就停止讀取、回 413），再解析表單；不直接用 request.formData()，
  // 因為那會把對方送來的內容全部讀完，不管有多大
  const raw = await readBody(request, MAX_UPLOAD_BYTES);
  let form;
  try {
    form = await new Response(raw, { headers: { 'Content-Type': request.headers.get('content-type') } }).formData();
  } catch (err) {
    return json({ ok: false, message: '上傳的資料格式不正確。' }, 400);
  }
  if (!(await checkCsrf(env, admin.email, form.get('csrf')))) { return json({ ok: false, message: '頁面開太久了，請重新整理後再試一次。' }, 403); }
  const full = form.get('full'), thumb = form.get('thumb');
  if (!(full instanceof File) || !(thumb instanceof File)) { return json({ ok: false, message: '缺少照片檔案。' }, 400); }
  if (full.size > MAX_FULL_BYTES || thumb.size > MAX_THUMB_BYTES) { return json({ ok: false, message: '照片檔案太大。' }, 413); }
  const [fullRaw, thumbRaw] = await Promise.all([full.arrayBuffer(), thumb.arrayBuffer()]);
  // 不論送來的檔案是誰產生的，寫進儲存空間的只有影像本身（見 shared/jpeg.js 的白名單）：Exif（拍攝地點、裝置、時間）、
  // XMP、ICC、IPTC、註解、JFIF 檔頭裡的縮圖與多塞的資料、內嵌的第二張圖、檔尾多出來的資料，都在這裡去掉
  const a = stripJpeg(fullRaw), b = stripJpeg(thumbRaw);
  if (!a.ok || !b.ok) {
    const reason = a.ok ? b.reason : a.reason;
    const message = reason === 'unsupported' || reason === 'bad-adobe'
      ? '這種 JPEG 不支援（只收一般的 8 bit 灰階或全彩 JPEG），沒有儲存。'
      : '檔案不是完整的 JPEG，沒有儲存。';
    return json({ ok: false, message }, 400);
  }
  // 再檢查一次處理後的檔案；還有任何要去掉的東西就不存（不應該發生，寧可拒收）
  const checkA = inspectJpeg(a.bytes), checkB = inspectJpeg(b.bytes);
  if (!checkA.ok || !checkB.ok || checkA.meta.length || checkB.meta.length) { return json({ ok: false, message: '照片處理失敗，沒有儲存。' }, 400); }
  if (Math.max(a.width, a.height) > 2400 || Math.max(b.width, b.height) > 1200) { return json({ ok: false, message: '照片尺寸超過上限（原圖長邊 2400、縮圖長邊 1200）。' }, 400); }
  const meta = photoMeta(form);
  if (!meta.alt_ja || !meta.alt_zh) { return json({ ok: false, message: '請填寫照片內容的描述（日文與中文）。' }, 400); }

  const id = randomHex(16);
  const put = (key, bytes) => env.PHOTOS.put(key, bytes, { httpMetadata: { contentType: 'image/jpeg' } });
  await Promise.all([put(`photos/${id}/full.jpg`, a.bytes), put(`photos/${id}/thumb.jpg`, b.bytes)]);
  const next = await env.DB.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM photos').first();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO photos (id, position, width, height, thumb_width, thumb_height, taken_on, alt_ja, alt_zh, caption_ja, caption_zh, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, next.n, a.width, a.height, b.width, b.height, meta.taken_on, meta.alt_ja, meta.alt_zh, meta.caption_ja, meta.caption_zh, now()),
    auditStatement(env.DB, admin.email, 'photo_upload', id),
  ]);
  return json({ ok: true, id, removed: [...new Set([...a.removed, ...b.removed])] });
}

async function updatePhoto(env, admin, id, form) {
  if (!(await getPhoto(env.DB, id))) { throw new HttpError(404, 'not-found'); }
  const meta = photoMeta(form);
  const position = Math.min(999, Math.max(0, Number(form.get('position')) || 0));
  await env.DB.batch([
    env.DB.prepare('UPDATE photos SET alt_ja = ?, alt_zh = ?, caption_ja = ?, caption_zh = ?, taken_on = ?, position = ? WHERE id = ?')
      .bind(meta.alt_ja, meta.alt_zh, meta.caption_ja, meta.caption_zh, meta.taken_on, position, id),
    auditStatement(env.DB, admin.email, 'photo_update', id),
  ]);
  return redirect('/photos?ok=saved');
}

async function deletePhoto(env, admin, id) {
  if (!(await getPhoto(env.DB, id))) { throw new HttpError(404, 'not-found'); }
  await env.PHOTOS.delete([`photos/${id}/full.jpg`, `photos/${id}/thumb.jpg`]);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(id),
    auditStatement(env.DB, admin.email, 'photo_delete', id),
  ]);
  return redirect('/photos?ok=deleted');
}

async function servePhoto(request, env, path) {
  const match = /^\/photo\/([a-f0-9]{32})\/(thumb|full)$/.exec(path);
  if (!match) { return text('Not found', 404); }
  const object = await env.PHOTOS.get(`photos/${match[1]}/${match[2]}.jpg`);
  if (!object) { return text('Not found', 404); }
  return new Response(object.body, { status: 200, headers: new Headers({ ...baseHeaders(), 'Content-Type': 'image/jpeg', 'Content-Length': String(object.size) }) });
}

/* ---------- 標題與留言 ---------- */
async function contentPage(env, admin, csrf, url) {
  const c = await loadContent(env.DB);
  const area = (name, label, value, rows) => `<label class="admin__field"><span>${label}</span><textarea name="${name}" rows="${rows}" maxlength="5000">${escapeHtml(value)}</textarea></label>`;
  return layout(env, admin, csrf, '/content', '標題與留言', `${notice(url)}
<p class="admin__lead">這些是訪客登入後才看得到的文字，只存在資料庫裡，不在公開的 repo。留言用空一行分段。</p>
<form class="admin__form" method="post" action="/content">${hidden(csrf)}
  <label class="admin__field"><span>標題（日文）</span><input name="title_ja" maxlength="200" value="${escapeHtml(c.title.ja)}"></label>
  <label class="admin__field"><span>標題（中文）</span><input name="title_zh" maxlength="200" value="${escapeHtml(c.title.zh)}"></label>
  ${area('message_ja', '留言（日文）', c.message.ja, 10)}
  ${area('message_zh', '留言（中文）', c.message.zh, 10)}
  <label class="admin__field"><span>署名（可留空）</span><input name="signature" maxlength="100" value="${escapeHtml(c.signature)}"></label>
  <button class="admin__btn" type="submit">儲存</button>
</form>`);
}

async function saveContent(env, admin, form) {
  const set = (key, max) => setSettingStatement(env.DB, key, cleanText(form.get(key), max));
  await env.DB.batch([set('title_ja', 200), set('title_zh', 200), set('message_ja', 5000), set('message_zh', 5000), set('signature', 100),
    auditStatement(env.DB, admin.email, 'content_update')]);
  return redirect('/content?ok=saved');
}

/* ---------- 訪客密碼與登入狀態 ---------- */
async function accessPage(env, admin, csrf, url, extra = '') {
  const state = await loadAuthState(env.DB);
  const [sessions, audit] = await Promise.all([countActiveSessions(env.DB, state), listAudit(env.DB, 30)]);
  // 換密碼的表單帶著「這一頁顯示時的密碼版本」：重新整理頁面（瀏覽器會把表單再送一次）或在舊分頁按下按鈕時，版本對不上就不會再換一次
  const versionField = `<input type="hidden" name="version" value="${state.passwordVersion}">`;
  const auditRows = audit.map((a) => `<li><time datetime="${new Date(a.at * 1000).toISOString()}">${formatTime(a.at)}</time>　${escapeHtml(AUDIT_TEXT[a.action] || a.action)}${a.detail ? `（${escapeHtml(a.detail)}）` : ''}</li>`).join('');
  return layout(env, admin, csrf, '/access', '密碼與登入', `${notice(url)}${extra}
<section class="admin__section">
  <h2 class="admin__h2">訪客密碼（合言葉）</h2>
  <p class="admin__lead">${state.passwordHash ? `已設定（第 ${state.passwordVersion} 版，${formatTime(state.passwordSetAt)} 日本時間）。` : '<strong>還沒有設定</strong>：現在沒有人能登入訪客頁。'}
  密碼一律由系統的亂數產生器產生（16 個位元組、128 bit，寫成 8 組十六進位字），沒有自己取密碼的地方。
  資料庫裡只存加了金鑰的雜湊，看不到密碼本身；換密碼之後，所有用舊密碼登入的人都要重新登入。</p>
  <form class="admin__form" method="post" action="/access/generate" data-confirm="產生新密碼之後，舊密碼會立刻失效，已登入的訪客也會被登出。確定嗎？">${hidden(csrf)}${versionField}
    <button class="admin__btn" type="submit">產生一組新的密碼</button>
  </form>
</section>
<section class="admin__section">
  <h2 class="admin__h2">登入狀態</h2>
  <p class="admin__lead">目前有效的訪客登入：${sessions} 個。</p>
  <form class="admin__form" method="post" action="/access/revoke" data-confirm="所有訪客都會被登出，需要重新輸入密碼。確定嗎？">${hidden(csrf)}
    <button class="admin__btn admin__btn--quiet" type="submit">撤銷所有訪客的登入（不換密碼）</button>
  </form>
  <form class="admin__form" method="post" action="/access/unlock">${hidden(csrf)}
    <button class="admin__btn admin__btn--quiet" type="submit">清除登入的限速紀錄（有人打錯太多次被擋住時用）</button>
  </form>
</section>
<section class="admin__section">
  <h2 class="admin__h2">最近的管理紀錄</h2>
  <p class="admin__lead">只記錄做了什麼動作與時間（日本時間），不記密碼、登入憑證或回覆的內容。</p>
  ${auditRows ? `<ul class="admin__audit">${auditRows}</ul>` : '<p class="admin__empty">還沒有紀錄。</p>'}
</section>`);
}

/** 換密碼。expected 是表單顯示時的密碼版本；已經被換過（同一份表單重送、或另一個分頁先換了）就不動，回傳 false */
async function storePassword(env, admin, password, action, expected) {
  return replacePassword(env.DB, {
    hash: await hashPassword(env.PEPPER, password), pepperCheck: await pepperCheck(env.PEPPER),
    expected, actor: admin.email, action,
  });
}

const STALE_FORM = '<p class="admin__notice admin__notice--error" role="alert">這一頁是舊的：合言葉在這之後已經換過了，所以這一次<strong>沒有</strong>再更換。目前有效的仍然是上一次設定的那一組。</p>';

/* ---------- 路由 ---------- */
async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  // 第一關：管理者身分。任何路徑、任何方法都要先過
  let admin;
  try {
    admin = await requireAdmin(request, env, ctx);
  } catch (err) {
    if (err instanceof AccessError) {
      logEvent('admin_denied_' + err.code);
      // 原因代碼給站主排查設定用（例如 not-configured、aud-mismatch、not-allowed）；不含任何私人內容
      return text(`Forbidden (${err.code})${err.detail ? '\n' + err.detail : ''}\n`, 403);
    }
    throw err;
  }
  if (!secretOk(env.PEPPER) || !secretOk(env.SESSION_SECRET)) { return text('Unavailable: secrets are not configured', 503); }

  const [csrf] = await csrfTokens(env, admin.email);

  if (request.method === 'GET' || request.method === 'HEAD') {
    if (path === '/') { return html(await inboxPage(env, admin, csrf, url)); }
    if (path === '/photos') { return html(await photosPage(env, admin, csrf, url), 200, [], { connect: true }); }
    if (path === '/content') { return html(await contentPage(env, admin, csrf, url)); }
    if (path === '/access') { return html(await accessPage(env, admin, csrf, url)); }
    if (path.startsWith('/photo/')) { return servePhoto(request, env, path); }
    if (path === '/export.json') {
      const replies = await listReplies(env.DB, 100000, 0);
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      await auditStatement(env.DB, admin.email, 'export', String(replies.length)).run();
      return json({ exported_at: new Date().toISOString(), note: '回覆來自持有訪客密碼的人，身分未經驗證。', replies: replies.map((r) => ({ id: r.id, created_at: new Date(r.created_at * 1000).toISOString(), lang: r.lang, session_ref: r.session_ref, body: r.body })) },
        200, [['Content-Disposition', `attachment; filename="replies-${stamp}.json"`]]);
    }
    if (Object.prototype.hasOwnProperty.call(STATIC_FILES, path)) {
      const file = STATIC_FILES[path];
      return new Response(request.method === 'HEAD' ? null : file.body, { status: 200, headers: new Headers({ ...baseHeaders(), 'Content-Type': file.type }) });
    }
    return text('Not found', 404);
  }

  if (request.method !== 'POST') { return text('Method not allowed', 405, [['Allow', 'GET, HEAD, POST']]); }
  if (!sameOrigin(request)) { return text('Forbidden', 403); }

  if (path === '/photos') { return uploadPhoto(request, env, admin); }

  const form = await readForm(request, 64 * 1024);
  if (!(await checkCsrf(env, admin.email, form.get('csrf')))) { return text('Forbidden: please reload the page and try again', 403); }

  let match;
  if ((match = /^\/replies\/([a-f0-9]{32})\/delete$/.exec(path))) {
    await env.DB.batch([env.DB.prepare('DELETE FROM replies WHERE id = ?').bind(match[1]), auditStatement(env.DB, admin.email, 'reply_delete', match[1])]);
    return redirect('/?ok=deleted');
  }
  if ((match = /^\/photos\/([a-f0-9]{32})$/.exec(path))) { return updatePhoto(env, admin, match[1], form); }
  if ((match = /^\/photos\/([a-f0-9]{32})\/delete$/.exec(path))) { return deletePhoto(env, admin, match[1]); }
  if (path === '/content') { return saveContent(env, admin, form); }
  if (path === '/access/generate') {
    const password = generatePassword();
    if (!(await storePassword(env, admin, password, 'password_generate', form.get('version')))) {
      return html(await accessPage(env, admin, csrf, url, STALE_FORM), 409);
    }
    // 新密碼只在這一次的回應裡顯示（不快取、不寫入紀錄）；資料庫裡只有雜湊
    return html(await accessPage(env, admin, csrf, url, `<div class="admin__secret" role="status">
  <p>新的訪客密碼（<strong>只顯示這一次</strong>，請現在複製）：</p>
  <p class="admin__secret-value" data-new-password>${escapeHtml(password)}</p>
  <p class="admin__meta">連字號可有可無、大小寫不分。舊密碼已經失效，已登入的訪客也已經被登出。離開或重新整理這一頁之後就看不到了（重新整理不會再換一次密碼）。</p>
</div>`));
  }
  if (path === '/access/revoke') {
    const state = await loadAuthState(env.DB);
    await env.DB.batch([setSettingStatement(env.DB, 'session_epoch', state.epoch + 1), env.DB.prepare('DELETE FROM sessions'), auditStatement(env.DB, admin.email, 'sessions_revoke')]);
    return redirect('/access?ok=revoked');
  }
  if (path === '/access/unlock') {
    await env.DB.batch([env.DB.prepare("DELETE FROM rate_limits WHERE bucket LIKE 'login:%'"), auditStatement(env.DB, admin.email, 'login_unlock')]);
    return redirect('/access?ok=unlocked');
  }
  return text('Not found', 404);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      if (err instanceof HttpError) { return text(err.code, err.status); }
      logEvent('admin_unhandled_error');
      return text('Error', 500);
    }
  },
};
