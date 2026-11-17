#!/usr/bin/env node
// 本機預覽：npm run dev
//
// 在這台電腦上把訪客端與管理端跑起來（wrangler dev），放進範例內容（範例文字、三張合成的範例圖），
// 並印出網址與這一次隨機產生的測試密碼。按 Ctrl+C 結束；結束後本機的測試資料會一起刪掉。
//
// - 這裡的金鑰、密碼、管理者身分都是測試用的隨機值，和正式環境無關。
// - 管理頁在正式環境由 Cloudflare Access 負責登入；本機用一個「模擬 Access」的轉送服務代替（自動以測試信箱登入）。
// - 請用 Chrome、Edge 或 Firefox 開。Safari 不接受 http://localhost 上的 Secure cookie，會登不進去（正式環境是 https，沒有這個問題）。
// - 預覽只開在這台電腦上（127.0.0.1）。不要用通道工具或 0.0.0.0 把它公開到網路上：wrangler dev 是開發工具，不是正式的服務。

import { seededStack } from '../tests/helpers/seed.mjs';

console.log('啟動中…（第一次大約 10–20 秒）');
const env = await seededStack();
console.log(`
本機預覽已啟動（按 Ctrl+C 結束）

  訪客看到的頁面   ${env.stack.visitorUrl}/
  管理頁           ${env.adminBrowserUrl}/      （本機模擬 Cloudflare Access，已自動登入）
  測試用的合言葉   ${env.password}

  這組合言葉只在這一次的本機預覽有效。
`);

let stopping = false;
async function stop() {
  if (stopping) { return; }
  stopping = true;
  console.log('\n結束中…');
  await env.stop();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);   // 保持執行，直到按 Ctrl+C
