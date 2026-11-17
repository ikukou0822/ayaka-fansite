// 啟動本機測試環境，並用管理頁的介面放進「範例內容」：範例文字、三張合成的範例圖、一組隨機的訪客密碼。
// 瀏覽器測試與截圖共用。這裡沒有任何真實的照片、留言或正式密碼。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { startStack, startAccessProxy, ROOT } from './stack.mjs';
import { adminClient, adminCsrf, generateVisitorPassword } from './client.mjs';

export const fixturePath = (name) => path.join(ROOT, 'tests', 'fixtures', name);
const fixture = (name) => readFileSync(fixturePath(name));

export const SAMPLE = {
  title_ja: 'サンプル：ここにタイトルが入ります',
  title_zh: '範例：這裡會放標題',
  message_ja: 'これは確認用のサンプルです。合言葉で開いたあと、このあたりにメッセージが表示されます。\n\n実際の文章と写真は、サイト管理人が用意したものに差し替えます。',
  message_zh: '這是確認用的範例。用通關密語打開之後，留言會顯示在這裡。\n\n實際的文字與照片，之後會換成網站主人準備的內容。',
  signature: '',
};

export async function uploadSample(admin, n, extra = {}) {
  const data = new FormData();
  data.append('csrf', await adminCsrf(admin, '/photos'));
  data.append('alt_ja', `サンプル画像${n}`);
  data.append('alt_zh', `範例圖片 ${n}`);
  data.append('caption_ja', `サンプルの写真 ${n}`);
  data.append('caption_zh', `範例照片 ${n}`);
  data.append('taken_on', extra.taken_on || '2026-11-14');
  data.append('full', new Blob([fixture(`sample-${n}-full.jpg`)], { type: 'image/jpeg' }), 'full.jpg');
  data.append('thumb', new Blob([fixture(`sample-${n}-thumb.jpg`)], { type: 'image/jpeg' }), 'thumb.jpg');
  const res = await admin.request('/photos', { method: 'POST', body: data, headers: { Accept: 'application/json' } });
  if (res.status !== 200) { throw new Error(`sample upload failed: HTTP ${res.status} ${res.text}`); }
  return JSON.parse(res.text).id;
}

export async function seededStack(options = {}) {
  const stack = await startStack(options);
  try {
    const admin = adminClient(stack, await stack.access.sign({ lifetime: 3600 }));
    const saved = await admin.post('/content', { csrf: await adminCsrf(admin, '/content'), ...SAMPLE });
    if (saved.status !== 303) { throw new Error(`content not saved: HTTP ${saved.status}`); }
    const photoIds = [];
    for (const n of [1, 2, 3]) { photoIds.push(await uploadSample(admin, n)); }
    const password = await generateVisitorPassword(admin);
    const proxy = await startAccessProxy(stack);     // 瀏覽器要開管理頁時走這裡（模擬 Cloudflare Access 加上憑證）
    return { stack, admin, password, photoIds, adminBrowserUrl: proxy.url, stop: async () => { await proxy.close(); await stack.stop(); } };
  } catch (err) {
    await stack.stop();
    throw err;
  }
}
