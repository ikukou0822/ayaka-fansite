// 資料庫（D1）的讀寫。所有查詢都用參數綁定（prepare + bind），不把使用者的輸入接進 SQL 字串。

import { now } from './util.js';

/* ---------- 設定 ---------- */

export async function getSettings(db, keys) {
  const marks = keys.map(() => '?').join(', ');
  const { results } = await db.prepare(`SELECT key, value, updated_at FROM settings WHERE key IN (${marks})`).bind(...keys).all();
  const out = {};
  for (const row of results) { out[row.key] = row; }
  return out;
}

export function setSettingStatement(db, key, value) {
  return db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(key, String(value), now());
}

/** 登入要用到的狀態：密碼的雜湊與版本、世代編號。還沒設定密碼時 passwordHash 是 null（誰都登不進來） */
export async function loadAuthState(db) {
  const s = await getSettings(db, ['visitor_password_hash', 'visitor_password_version', 'session_epoch', 'pepper_check']);
  return {
    pepperCheck: s.pepper_check ? s.pepper_check.value : null,
    passwordHash: s.visitor_password_hash ? s.visitor_password_hash.value : null,
    passwordVersion: s.visitor_password_version ? Number(s.visitor_password_version.value) : 0,
    passwordSetAt: s.visitor_password_hash ? s.visitor_password_hash.updated_at : null,
    epoch: s.session_epoch ? Number(s.session_epoch.value) : 0,
  };
}

// 「目前的密碼版本等於某個值」的條件（還沒設定過密碼時版本是 0）
const VERSION_IS = "COALESCE((SELECT value FROM settings WHERE key = 'visitor_password_version'), '0') = ?";

/**
 * 換密碼。整個動作是一個交易，而且每一句都帶著「目前的版本必須等於 expected」的條件：
 * 同一份表單重送、或兩個請求同時進來時，只有第一個會生效，其餘什麼都不會改。回傳這一次有沒有生效。
 * 生效時：存新的雜湊與金鑰檢查值、刪掉所有登入狀態、記一筆管理紀錄、版本加一（版本最後才改，前面每一句看到的都是舊版本）。
 */
export async function replacePassword(db, { hash, pepperCheck, expected, actor, action }) {
  if (!/^\d{1,9}$/.test(String(expected))) { return false; }
  const current = String(expected), next = String(Number(expected) + 1), t = now();
  const guardedSet = (key, value) => db
    .prepare(`INSERT INTO settings (key, value, updated_at) SELECT ?, ?, ? WHERE ${VERSION_IS} ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(key, value, t, current);
  const results = await db.batch([
    guardedSet('visitor_password_hash', hash),
    guardedSet('pepper_check', pepperCheck),
    db.prepare(`DELETE FROM sessions WHERE ${VERSION_IS}`).bind(current),
    db.prepare(`INSERT INTO audit (at, actor, action, detail) SELECT ?, ?, ?, ? WHERE ${VERSION_IS}`).bind(t, actor, action, `第 ${next} 版`, current),
    guardedSet('visitor_password_version', next),
  ]);
  const last = results[results.length - 1];
  return !!(last && last.meta && last.meta.changes === 1);
}

/* ---------- 登入狀態 ---------- */

export async function createSession(db, idHash, ttlSeconds, state) {
  const t = now();
  await db.prepare('INSERT INTO sessions (id_hash, created_at, expires_at, password_version, epoch) VALUES (?, ?, ?, ?, ?)')
    .bind(idHash, t, t + ttlSeconds, state.passwordVersion, state.epoch).run();
}

/** 找出還有效的登入狀態：沒過期、密碼沒換過、沒被撤銷。任何一項不符都回傳 null */
export async function findValidSession(db, idHash, state) {
  const row = await db.prepare('SELECT id_hash, created_at, expires_at, password_version, epoch FROM sessions WHERE id_hash = ?').bind(idHash).first();
  if (!row) { return null; }
  if (row.expires_at <= now()) { return null; }
  if (row.password_version !== state.passwordVersion || row.epoch !== state.epoch) { return null; }
  return row;
}

export async function deleteSession(db, idHash) {
  await db.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(idHash).run();
}

export async function countActiveSessions(db, state) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ? AND password_version = ? AND epoch = ?')
    .bind(now(), state.passwordVersion, state.epoch).first();
  return row ? row.n : 0;
}

// 「目前的」密碼版本與世代編號，在同一句 SQL 裡現讀（不是呼叫的人先前讀到的值）
const CURRENT_VERSION = "CAST(COALESCE((SELECT value FROM settings WHERE key = 'visitor_password_version'), '0') AS INTEGER)";
const CURRENT_EPOCH = "CAST(COALESCE((SELECT value FROM settings WHERE key = 'session_epoch'), '0') AS INTEGER)";

/**
 * 清掉過期或已失效的登入狀態與舊的限速計數（順手做，不影響正確性）。
 *
 * 判斷「已失效」用的是刪除那一刻資料庫裡的設定，在同一句 SQL 裡讀；不接受呼叫的人先前讀到的版本或世代。
 * 這個函式通常在登入之後才在背景執行：如果拿登入當時讀到的值來比，中間剛好換過密碼的話，
 * 會把「用新密碼登入的人」當成失效而刪掉。版本與世代只會往上加，所以和目前的值不同的登入狀態一定是舊的。
 */
export async function sweep(db) {
  const t = now();
  await db.batch([
    db.prepare(`DELETE FROM sessions WHERE expires_at <= ? OR password_version <> ${CURRENT_VERSION} OR epoch <> ${CURRENT_EPOCH}`).bind(t),
    db.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(t - 2 * 86400),
  ]);
}

/* ---------- 限速（固定時間窗，全域一致） ---------- */
// 做法是「先累計、再判斷」：每一次嘗試都先在資料庫裡把計數加一（一個 SQL 指令，不會被同時進來的請求插隊），
// 再看加完之後有沒有超過上限。這樣就算同時送出很多個請求，能通過的次數也不會超過上限。

function windowStart(windowSeconds) { return Math.floor(now() / windowSeconds) * windowSeconds; }

/**
 * 一次累計幾個計數（同一個交易）。items: [{ bucket, window }]
 * 回傳 { counts: [累計後的次數…], keys: [{ bucket, start }…] }；keys 交給 rateRefund 可以把這一次退回去
 */
export async function rateTake(db, items) {
  const keys = items.map((item) => ({ bucket: item.bucket, start: windowStart(item.window) }));
  const results = await db.batch(keys.map((key) => db
    .prepare('INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1) ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1 RETURNING count')
    .bind(key.bucket, key.start)));
  const counts = results.map((result) => {
    const row = result && result.results ? result.results[0] : null;
    if (!row || typeof row.count !== 'number') { throw new Error('rate-limit-unavailable'); }   // 讀不到計數就當作失敗（不放行）
    return row.count;
  });
  return { counts, keys };
}

/** 把剛剛累計的那一次退回去（登入成功、或這次嘗試根本沒有被受理時） */
export async function rateRefund(db, keys) {
  if (!keys.length) { return; }
  await db.batch(keys.map((key) => db
    .prepare('UPDATE rate_limits SET count = MAX(count - 1, 0) WHERE bucket = ? AND window_start = ?')
    .bind(key.bucket, key.start)));
}

/** 這個時間窗還剩幾秒（給 Retry-After 用） */
export function retryAfter(windowSeconds) { return windowStart(windowSeconds) + windowSeconds - now(); }

/* ---------- 內容：標題、留言、照片 ---------- */

export async function loadContent(db) {
  const s = await getSettings(db, ['title_ja', 'title_zh', 'message_ja', 'message_zh', 'signature']);
  const v = (key) => (s[key] ? s[key].value : '');
  return { title: { ja: v('title_ja'), zh: v('title_zh') }, message: { ja: v('message_ja'), zh: v('message_zh') }, signature: v('signature') };
}

export async function listPhotos(db) {
  const { results } = await db.prepare('SELECT * FROM photos ORDER BY position ASC, created_at ASC').all();
  return results;
}

export async function getPhoto(db, id) {
  return db.prepare('SELECT * FROM photos WHERE id = ?').bind(id).first();
}

/* ---------- 回覆 ---------- */

/** 這一則是不是已經存過了。dedupeKey 由「送出編號＋內容」算出，和登入無關（見訪客端的 handleReply） */
export async function replyExists(db, dedupeKey) {
  return !!(await db.prepare('SELECT id FROM replies WHERE dedupe_key = ?').bind(dedupeKey).first());
}

/**
 * 存一則回覆。回傳 { saved: true, duplicate } ；寫不進去就丟出錯誤（呼叫的人不可以顯示「送出成功」）。
 * dedupeKey 相同的重送不會多存一筆（資料表的唯一條件保證，同時送進來的兩個請求也只會存下一筆）。
 * session_ref 只記錄「第一次存下來時是哪一次登入」，不參與去重。
 */
export async function insertReply(db, reply) {
  const result = await db.prepare('INSERT INTO replies (id, created_at, session_ref, lang, body, dedupe_key) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING')
    .bind(reply.id, now(), reply.sessionRef, reply.lang, reply.body, reply.dedupeKey).run();
  const changes = result && result.meta ? result.meta.changes : 0;
  if (changes === 1) { return { saved: true, duplicate: false }; }
  if (await replyExists(db, reply.dedupeKey)) { return { saved: true, duplicate: true }; }
  throw new Error('reply-not-saved');
}

export async function listReplies(db, limit, offset) {
  const { results } = await db.prepare('SELECT id, created_at, session_ref, lang, body FROM replies ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?').bind(limit, offset).all();
  return results;
}

export async function countReplies(db) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM replies').first();
  return row ? row.n : 0;
}

/* ---------- 管理紀錄 ---------- */

export async function listAudit(db, limit) {
  const { results } = await db.prepare('SELECT at, actor, action, detail FROM audit ORDER BY id DESC LIMIT ?').bind(limit).all();
  return results;
}

export function auditStatement(db, actor, action, detail = '') {
  return db.prepare('INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)').bind(now(), actor, action, String(detail).slice(0, 200));
}
