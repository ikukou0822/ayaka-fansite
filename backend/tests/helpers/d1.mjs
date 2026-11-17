// 測試用：開一個空的本機 D1 資料庫（和 wrangler dev 用的是同一套本機實作），套用 migrations 裡的資料表，
// 讓測試可以直接呼叫 shared/store.js 的函式。用來測「兩個動作交錯執行」這類從 HTTP 很難準確安排的情況。

import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getPlatformProxy } from 'wrangler';
import { ROOT, WRANGLER_ENV } from './stack.mjs';

export async function openDatabase() {
  for (const name of ['WRANGLER_SEND_METRICS', 'CI', 'NO_COLOR', 'X_LOCAL_EXPLORER', 'X_LOCAL_OBSERVABILITY']) { process.env[name] = WRANGLER_ENV[name]; }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ayaka-room-store-'));
  const proxy = await getPlatformProxy({ configPath: path.join(ROOT, 'tests', 'helpers', 'd1.wrangler.jsonc'), persist: { path: dir } });
  const db = proxy.env.DB;
  const migrations = path.join(ROOT, 'migrations');
  for (const file of readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()) {
    const sql = readFileSync(path.join(migrations, file), 'utf8').split('\n').map((line) => line.replace(/--.*$/, '')).join('\n');
    await db.batch(sql.split(';').map((statement) => statement.trim()).filter(Boolean).map((statement) => db.prepare(statement)));
  }
  return { db, close: async () => { await proxy.dispose(); await rm(dir, { recursive: true, force: true }); } };
}
