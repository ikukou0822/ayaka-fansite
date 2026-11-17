// 資料庫層的測試：直接呼叫 shared/store.js，對象是本機的 D1（和 wrangler dev 同一套實作）。
// node --test tests/store.spec.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from './helpers/d1.mjs';
import {
  loadAuthState, replacePassword, createSession, findValidSession, countActiveSessions, sweep, setSettingStatement, rateTake,
} from '../shared/store.js';

let database, db;
before(async () => { database = await openDatabase(); db = database.db; });
after(async () => { if (database) { await database.close(); } });

const count = async (table) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
const exists = async (idHash) => !!(await db.prepare('SELECT 1 AS x FROM sessions WHERE id_hash = ?').bind(idHash).first());
const changePassword = async (hash) => {
  const state = await loadAuthState(db);
  assert.equal(await replacePassword(db, { hash, pepperCheck: 'check', expected: String(state.passwordVersion), actor: 'test', action: 'password_generate' }), true);
  return loadAuthState(db);
};

test('舊的背景清理在換密碼之後才執行：不會刪掉用新密碼登入的人', async () => {
  // 1. 有人用第 1 版的密碼登入。登入當時讀到的狀態（第 1 版）留在那個請求手上，清理排在背景、還沒執行
  const atOldLogin = await changePassword('hash-v1');
  await createSession(db, 'session-old', 3600, atOldLogin);
  // 2. 站主換密碼（第 2 版）。舊的登入全部失效
  const current = await changePassword('hash-v2');
  assert.equal(current.passwordVersion, atOldLogin.passwordVersion + 1);
  assert.equal(await exists('session-old'), false);
  // 3. 另一個人用新密碼登入
  await createSession(db, 'session-new', 3600, current);
  // 4. 第 1 步排在背景的清理這時候才跑。它手上是第 1 版的舊狀態——就算像以前一樣把它傳進去，也不可以拿來判斷
  await sweep(db, atOldLogin);
  assert.equal(await exists('session-new'), true, '用新密碼登入的人不可以被清掉');
  assert.ok(await findValidSession(db, 'session-new', await loadAuthState(db)), '而且仍然是有效的登入');
  assert.equal(await countActiveSessions(db, await loadAuthState(db)), 1);
});

test('舊的背景清理在「撤銷所有登入」之後才執行：不會刪掉之後才登入的人', async () => {
  const before = await loadAuthState(db);
  await db.batch([setSettingStatement(db, 'session_epoch', before.epoch + 1), db.prepare('DELETE FROM sessions')]);
  const current = await loadAuthState(db);
  await createSession(db, 'session-after-revoke', 3600, current);
  await sweep(db, before);
  assert.ok(await findValidSession(db, 'session-after-revoke', await loadAuthState(db)));
});

test('清理會刪掉的：過期的、密碼版本或世代已經不是目前值的登入狀態，以及兩天前的限速計數', async () => {
  await db.prepare('DELETE FROM sessions').run();
  const current = await loadAuthState(db);
  const t = Math.floor(Date.now() / 1000);
  const insert = (id, expires, version, epoch) => db.prepare('INSERT INTO sessions (id_hash, created_at, expires_at, password_version, epoch) VALUES (?, ?, ?, ?, ?)').bind(id, t - 10, expires, version, epoch);
  await db.batch([
    insert('valid', t + 3600, current.passwordVersion, current.epoch),
    insert('expired', t - 1, current.passwordVersion, current.epoch),
    insert('expires-now', t, current.passwordVersion, current.epoch),
    insert('old-password', t + 3600, current.passwordVersion - 1, current.epoch),
    insert('old-epoch', t + 3600, current.passwordVersion, current.epoch - 1),
    db.prepare('INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 3), (?, ?, 3)').bind('stale', t - 3 * 86400, 'recent', t - 3600),
  ]);
  await sweep(db);
  assert.deepEqual((await db.prepare('SELECT id_hash FROM sessions ORDER BY id_hash').all()).results.map((row) => row.id_hash), ['valid']);
  assert.deepEqual((await db.prepare('SELECT bucket FROM rate_limits ORDER BY bucket').all()).results.map((row) => row.bucket), ['recent']);
});

test('還沒設定過密碼的資料庫：清理不會出錯，也不會刪掉版本 0 的登入狀態', async () => {
  const fresh = await openDatabase();
  try {
    const state = await loadAuthState(fresh.db);
    assert.deepEqual([state.passwordVersion, state.epoch, state.passwordHash], [0, 0, null]);
    await createSession(fresh.db, 'session-zero', 3600, state);
    await sweep(fresh.db);
    assert.equal((await fresh.db.prepare('SELECT COUNT(*) AS n FROM sessions').first()).n, 1);
  } finally { await fresh.close(); }
});

test('限速的計數：同時進來的請求不會少算', async () => {
  const takes = await Promise.all(Array.from({ length: 20 }, () => rateTake(db, [{ bucket: 'concurrent', window: 600 }])));
  assert.deepEqual(takes.map((take) => take.counts[0]).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal(await count('rate_limits') >= 1, true);
});
