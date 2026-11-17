#!/usr/bin/env node
// 正式環境的 CPU 用量整理：把 wrangler tail 的輸出依「操作」分組，列出每一種操作用了多少 CPU 時間。
//
//   npx wrangler tail ayaka-room --format json | node scripts/cpu_report.mjs --expect visitor
//   npx wrangler tail ayaka-room-admin --format json | node scripts/cpu_report.mjs --expect admin
//   （開著它，同時在瀏覽器裡把登入、開頁面、看照片、送出回覆、上傳照片各做幾次，再按 Ctrl+C。）
//
//   --expect visitor｜admin   驗收時請加：要求那個 Worker 的每一種主要操作（MAIN_OPERATIONS）都至少有一筆有效的量測，
//                             有哪一種還沒量到，結果就是「無法判定」。不加的話，報告只涵蓋「這一次剛好量到的請求」
//   --limit <毫秒>            上限，預設 10（免費方案）
//
// 為什麼要看：Workers 免費方案每一次請求的 CPU 時間上限是 10 ms，超過的請求會直接失敗。
// 本機測不出正式環境的數字，所以正式照片匯入之前要在正式環境量一次（見 ACCEPTANCE.md）。
//
// 注意：
// - 這個腳本只印「方法＋路徑（編號換成 :id）」與統計數字，不印網址參數、標頭或記錄內容。
//   請直接用管線接過來，不要把 wrangler tail 的原始輸出存成檔案放進 repo。
// - 每一筆請求的 CPU 時間讀的是 cpuTime 欄位（毫秒），只接受有限、不是負數的數值。
//   沒有這個欄位、或值不是這樣的數字（null、字串、負數、無限大…）的那一筆，算「缺少有效的 CPU 數值」。
//   不會拿 wallTime（從開始到結束經過的時間，包含等待資料庫與網路）來代替：那不是 CPU 時間。
// - 只要有任何一筆收到的請求缺少有效的 CPU 數值，整份報告就是「無法判定」，不是通過：
//   缺的那一筆可能剛好超過上限，其他筆的數字不能替它擔保。這時請重新量一次，或改看 Cloudflare 後台該 Worker
//   的 Metrics 分頁裡的 CPU Time。
// - 有請求達到或超過上限、或被平台以「超過 CPU 上限」中止時，結果一律是沒通過（不管有沒有缺資料）。
// - 結果只代表量測當下那幾次請求。「開專區頁面」要在已經登入的狀態下量（沒登入時同一個網址只是登入表單，
//   這個腳本從紀錄裡分不出來）。
//
// 結束代碼：0 = 每一筆都有數值而且都在上限以內（加了 --expect 時：而且每一種主要操作都量到了）；
//           1 = 有請求達到或超過上限，或被平台以「超過 CPU 上限」中止；
//           2 = 無法判定（沒有收到請求、有請求缺少有效的 CPU 數值，或加了 --expect 而有主要操作還沒量到）；
//           64 = 參數不對。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 從一段文字裡取出所有的 JSON 物件（一行一個、或排版成多行的都可以）；夾在中間的其他文字會被略過 */
export function parseEvents(text) {
  const events = [];
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; } else if (ch === '\\') { escaped = true; } else if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"' && depth > 0) { inString = true; continue; }
    if (ch === '{') { if (depth === 0) { start = i; } depth += 1; continue; }
    if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        try { events.push(JSON.parse(text.slice(start, i + 1))); } catch (err) { /* 不是完整的 JSON，略過 */ }
        start = -1;
      }
    }
  }
  return events;
}

/** 讀不出路徑的請求歸在這個名稱底下（照樣算一筆收到的請求，不會被默默略過） */
export const UNREADABLE_URL = '（網址讀不出來）';
/** 不是 HTTP 請求、卻被平台以「超過 CPU 上限」中止的事件歸在這裡（不可以因為認不出是哪個操作就不算） */
export const OTHER_EVENT = '（不是 HTTP 請求的事件）';

/** 驗收時每一種都要量到的操作（ACCEPTANCE.md 的 B-4）。用 --expect visitor／admin 指定要核對哪一組 */
export const MAIN_OPERATIONS = {
  visitor: ['POST /login', 'GET /', 'GET /photo/:id/thumb', 'GET /photo/:id/full', 'POST /reply'],
  admin: ['GET /', 'POST /photos', 'POST /access/generate'],
};

/**
 * 把一筆事件整理成「操作」的名稱：方法＋路徑，路徑裡的編號換成 :id，不含網址參數。
 * 不是 HTTP 請求的事件（排程、佇列…）回傳 null；是請求但網址讀不出來的，歸在 UNREADABLE_URL。
 */
export function operationOf(event) {
  const request = event && event.event && event.event.request;
  if (!request || typeof request !== 'object') { return null; }
  const method = String(request.method || 'GET').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 10) || 'GET';
  let pathname;
  try { pathname = new URL(request.url).pathname; } catch (err) { return `${method} ${UNREADABLE_URL}`; }
  return `${method} ${pathname.replace(/[a-f0-9]{32}/g, ':id')}`;
}

/** CPU 數值只接受有限、不是負數的數字。null、字串、布林、NaN、無限大、負數都不算 */
export function validCpu(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** 上限要是大於 0 的有限數字；不然每一個比較都會落空，結果會變成「通過」 */
export function validLimit(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * 依操作分組統計。
 * options.limitMs：上限（毫秒）；options.expect：一定要量到的操作名稱（陣列，例如 MAIN_OPERATIONS.visitor）
 * 回傳 { rows, verdict, total, measured, missing, uncovered }：
 * - rows：[{ operation, count（收到的請求數）, measured（有有效 CPU 數值的筆數）, missing（缺的筆數）,
 *           min, median, max（只用有效的數值算；一筆都沒有就是 null）, outcomes, over, expected, status }]
 *   status：'fail'（達到或超過上限，或有 exceededCpu）→ 'unknown'（有缺值；或是一定要量到的操作卻一筆有效的都沒有）→ 'pass'
 * - uncovered：一定要量到、卻一筆有效量測都沒有的操作
 * - verdict：有任何一列 fail → 'fail'；否則沒有收到請求、有任何一筆缺值、或有還沒量到的操作 → 'unknown'；否則 'pass'
 */
export function summarize(events, { limitMs = 10, expect = [] } = {}) {
  if (!validLimit(limitMs)) { throw new RangeError('limitMs must be a finite number greater than 0'); }
  const groups = new Map();
  const groupOf = (operation) => {
    if (!groups.has(operation)) { groups.set(operation, { operation, count: 0, cpu: [], outcomes: {} }); }
    return groups.get(operation);
  };
  for (const event of events) {
    const outcome = event && typeof event.outcome === 'string' && /^[A-Za-z]{1,40}$/.test(event.outcome) ? event.outcome : 'unknown';
    let operation = operationOf(event);
    if (!operation) {
      // 不是 HTTP 請求的事件不列入；但被平台以「超過 CPU 上限」中止的，不管是什麼事件都要算
      if (outcome !== 'exceededCpu') { continue; }
      operation = OTHER_EVENT;
    }
    const group = groupOf(operation);
    group.count += 1;
    group.outcomes[outcome] = (group.outcomes[outcome] || 0) + 1;
    if (validCpu(event.cpuTime)) { group.cpu.push(event.cpuTime); }
  }
  for (const operation of expect) { groupOf(operation); }       // 還沒量到的操作也列出來（0 筆）
  const rows = [...groups.values()].sort((a, b) => a.operation.localeCompare(b.operation)).map((group) => {
    const sorted = [...group.cpu].sort((a, b) => a - b);
    const max = sorted.length ? sorted[sorted.length - 1] : null;
    const missing = group.count - sorted.length;
    const over = (max !== null && max >= limitMs) || !!group.outcomes.exceededCpu;
    const expected = expect.includes(group.operation);
    return {
      operation: group.operation, count: group.count, measured: sorted.length, missing,
      min: sorted.length ? sorted[0] : null, median: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null, max,
      outcomes: group.outcomes, over, expected,
      status: over ? 'fail' : (missing > 0 || (expected && sorted.length === 0) ? 'unknown' : 'pass'),
    };
  });
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const measured = rows.reduce((sum, row) => sum + row.measured, 0);
  const missing = total - measured;
  const uncovered = rows.filter((row) => row.expected && row.measured === 0).map((row) => row.operation);
  const verdict = rows.some((row) => row.status === 'fail') ? 'fail' : (total === 0 || missing > 0 || uncovered.length > 0 ? 'unknown' : 'pass');
  return { rows, verdict, total, measured, missing, uncovered };
}

/** 文字在終端機上佔幾格（中日文與全形符號算兩格），排版對齊用 */
function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) { width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1; }
  return width;
}

export function formatReport({ rows, verdict, total, measured, missing, uncovered = [] }, limitMs = 10, { expectLabel = '' } = {}) {
  const lines = [];
  const pad = (value, width) => String(value) + ' '.repeat(Math.max(0, width - displayWidth(value)));
  const ms = (value) => (value === null ? '—' : String(value));
  const width = Math.max(10, ...rows.map((row) => displayWidth(row.operation)));
  const mark = { pass: '✔', fail: '✖ 達到或超過上限', unknown: '？ 無法判定' };
  lines.push(`${pad('操作', width)}  ${pad('有效／總數', 10)}  ${pad('CPU 毫秒（最小／中位／最大）', 28)}  判定`);
  for (const row of rows) {
    const outcomes = Object.entries(row.outcomes).map(([name, n]) => `${name}×${n}`).join(' ');
    const notes = [];
    if (row.count === 0) { notes.push('還沒量到（這是一定要量的操作）'); }
    else if (row.missing > 0) { notes.push(row.measured === 0 ? `${row.count} 筆都沒有有效的 CPU 數值` : `${row.missing} 筆沒有有效的 CPU 數值`); }
    if (outcomes) { notes.push(outcomes); }
    const verdictText = row.status === 'fail' && row.outcomes.exceededCpu ? '✖ 被平台以「超過 CPU 上限」中止' : mark[row.status];
    lines.push(`${pad(row.operation, width)}  ${pad(`${row.measured}／${row.count}`, 10)}  ${pad(`${ms(row.min)}／${ms(row.median)}／${ms(row.max)}`, 28)}  ${verdictText}　${notes.join('　')}`);
  }
  lines.push('');
  const lacking = rows.filter((row) => row.missing > 0).map((row) => `${row.operation}（${row.measured}／${row.count}）`).join('、');
  const notMeasured = uncovered.join('、');
  if (verdict === 'fail') {
    lines.push(`✖ 有操作的 CPU 時間達到或超過 ${limitMs} ms，或被平台以「超過 CPU 上限」中止。免費方案不夠用：需要減少那個操作的運算，或改用付費方案。`);
    if (missing > 0) { lines.push(`  另外有 ${missing} 筆請求沒有有效的 CPU 數值：${lacking}。`); }
    if (uncovered.length) { lines.push(`  另外，一定要量的操作裡還沒有有效量測的：${notMeasured}。`); }
  } else if (verdict === 'unknown') {
    if (total === 0) {
      lines.push('？ 無法判定：沒有收到任何請求的紀錄。');
    } else if (missing > 0) {
      lines.push(`？ 無法判定：收到 ${total} 筆請求，其中 ${missing} 筆沒有有效的 CPU 數值（cpuTime 欄位不存在，或不是有限、非負的數字）：${lacking}。`);
      lines.push(measured > 0
        ? `  有數值的 ${measured} 筆都低於 ${limitMs} ms，但缺的那幾筆可能超過，不能當作通過。請重新量一次，或改看後台該 Worker 的 Metrics 分頁（CPU Time）。`
        : '  沒有任何一筆可以判斷。請改看後台該 Worker 的 Metrics 分頁（CPU Time）。');
      if (uncovered.length) { lines.push(`  另外，一定要量的操作裡還沒有有效量測的：${notMeasured}。`); }
    } else {
      lines.push(`？ 無法判定：量到的 ${measured} 筆都低於 ${limitMs} ms，但一定要量的操作裡還有沒量到的：${notMeasured}。請把這些操作各做一次再量。`);
    }
  } else if (expectLabel) {
    lines.push(`✔ 收到的 ${total} 筆請求都有 CPU 數值，而且都低於 ${limitMs} ms；${expectLabel}的每一種主要操作都至少量到一筆。（只代表這一次量到的請求。）`);
  } else {
    lines.push(`✔ 收到的 ${total} 筆請求都有 CPU 數值，而且都低於 ${limitMs} ms。（只代表這一次量到的請求，沒有核對是不是每一種主要操作都量過；驗收時請加 --expect visitor 或 --expect admin。）`);
  }
  const unusual = {};
  for (const row of rows) { for (const [name, n] of Object.entries(row.outcomes)) { if (name !== 'ok' && name !== 'exceededCpu') { unusual[name] = (unusual[name] || 0) + n; } } }
  if (Object.keys(unusual).length) {
    lines.push(`  注意：有請求的結束狀態不是 ok（${Object.entries(unusual).map(([name, n]) => `${name}×${n}`).join(' ')}）。那幾筆可能沒有跑完整個操作，CPU 數字只到中斷為止。`);
  }
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const usage = (message) => {
    console.error(`${message}\n用法：npx wrangler tail <Worker 名稱> --format json | node scripts/cpu_report.mjs [--expect visitor|admin] [--limit <毫秒>]\n　　　node scripts/cpu_report.mjs <檔名> [--expect visitor|admin] [--limit <毫秒>]`);
    process.exit(64);
  };
  const limitAt = args.indexOf('--limit');
  let limitMs = 10;
  if (limitAt >= 0) {
    const raw = args[limitAt + 1];
    limitMs = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
    if (!validLimit(limitMs)) { usage('--limit 要是大於 0 的數字（毫秒）。'); }
  }
  const expectAt = args.indexOf('--expect');
  let expect = [], expectLabel = '';
  if (expectAt >= 0) {
    const which = args[expectAt + 1];
    if (!Object.hasOwn(MAIN_OPERATIONS, which || '')) { usage('--expect 後面要寫 visitor（訪客端）或 admin（管理端）。'); }
    expect = MAIN_OPERATIONS[which];
    expectLabel = which === 'visitor' ? '訪客端' : '管理端';
  }
  const valueOf = new Set([limitAt, expectAt].filter((at) => at >= 0).map((at) => at + 1));     // 這些位置是參數的值，不是檔名
  const unknownFlag = args.find((value, i) => value.startsWith('--') && value !== '--limit' && value !== '--expect' && !valueOf.has(i));
  if (unknownFlag) { usage(`不認得的參數：${unknownFlag}`); }
  const file = args.find((value, i) => !value.startsWith('--') && !valueOf.has(i));
  let text = '';
  if (file) { text = readFileSync(file, 'utf8'); } else { for await (const chunk of process.stdin) { text += chunk; } }
  const summary = summarize(parseEvents(text), { limitMs, expect });
  console.log(formatReport(summary, limitMs, { expectLabel }));
  process.exit(summary.verdict === 'fail' ? 1 : (summary.verdict === 'unknown' ? 2 : 0));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // 按 Ctrl+C 結束 wrangler tail 時，這一邊也會收到中斷訊號：先不要結束，等輸入關閉後把報告印完
  process.on('SIGINT', () => {});
  main().catch((err) => { console.error(err && err.message ? err.message : err); process.exit(2); });
}
