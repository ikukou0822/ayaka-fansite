// 單元測試：不需要啟動任何服務。node --test tests/unit.spec.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  escapeHtml, cookie, parseCookies, sameOrigin, secretOk, safeEqual, sha256Hex, hmacHex, randomToken, randomHex,
  baseHeaders, readBody, readForm, HttpError, formatDate, formatTime, html, redirect, toHex,
} from '../shared/util.js';
import { normalizePassword, generatePassword, formatPassword, isInvitationPassword, hashPassword, pepperCheck, PASSWORD_BYTES } from '../shared/password.js';
import { walkJpeg, inspectJpeg, stripJpeg, JFIF_HEADER, adobeSegment } from '../shared/jpeg.js';
import { STRINGS, LANGS, tr } from '../shared/i18n.js';
import { requireAdmin, AccessError } from '../admin/src/access.js';
import { STATIC_FILES } from '../admin/src/static.generated.js';
import { parseEvents, operationOf, summarize, formatReport, validCpu, validLimit, UNREADABLE_URL, OTHER_EVENT, MAIN_OPERATIONS } from '../scripts/cpu_report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => new Uint8Array(readFileSync(path.join(ROOT, 'tests', 'fixtures', name)));
const source = (file) => readFileSync(path.join(ROOT, file), 'utf8');
const noComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

/* ---------- 文字輸出與 cookie ---------- */

test('escapeHtml 會把 HTML 的特殊字元全部換掉', () => {
  assert.equal(escapeHtml('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  assert.equal(escapeHtml(`a & b ' c`), 'a &amp; b &#39; c');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(0), '0');
  assert.ok(!/[<>"']/.test(escapeHtml(`"><img src=x onerror=alert(1)>'`)));
});

test('cookie：一律 Secure、Path=/，預設 HttpOnly 與 SameSite=Lax', () => {
  const c = cookie('__Host-room-session', 'abc', { maxAge: 60 });
  for (const part of ['__Host-room-session=abc', 'Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax', 'Max-Age=60']) { assert.ok(c.split('; ').includes(part), part); }
  assert.ok(!/Domain=/i.test(c), '__Host- 開頭的 cookie 不可以有 Domain');
  assert.ok(!cookie('x', '1', { httpOnly: false }).includes('HttpOnly'));
  assert.ok(cookie('x', '1', { sameSite: 'Strict' }).includes('SameSite=Strict'));
});

test('parseCookies：同名的 cookie 只取第一個', () => {
  const parse = (header) => ({ ...parseCookies(header) });
  assert.deepEqual(parse('a=1; b=two; a=3'), { a: '1', b: 'two' });
  assert.deepEqual(parse(''), {});
  assert.deepEqual(parse(null), {});
  assert.deepEqual(parse('novalue; =x; c=d=e'), { c: 'd=e' });
  assert.deepEqual(parse('__proto__=1; toString=2; ok=3'), { ['__proto__']: '1', toString: '2', ok: '3' });
  assert.equal(parseCookies('x=1').constructor, undefined, '結果沒有繼承任何東西');
});

test('sameOrigin：沒有 Origin、或 Origin 不是本站，都不算', () => {
  const make = (origin) => new Request('https://room.example/login', { method: 'POST', headers: origin ? { Origin: origin } : {} });
  assert.equal(sameOrigin(make('https://room.example')), true);
  assert.equal(sameOrigin(make('https://evil.example')), false);
  assert.equal(sameOrigin(make('http://room.example')), false);
  assert.equal(sameOrigin(make('https://room.example.evil.example')), false);
  assert.equal(sameOrigin(make('null')), false);
  assert.equal(sameOrigin(make(null)), false);
  const withSite = (site) => new Request('https://room.example/login', { method: 'POST', headers: { Origin: 'https://room.example', 'Sec-Fetch-Site': site } });
  assert.equal(sameOrigin(withSite('same-origin')), true);
  for (const site of ['cross-site', 'same-site', 'none']) { assert.equal(sameOrigin(withSite(site)), false, site); }
});

test('secretOk：金鑰至少要 32 個字', () => {
  assert.equal(secretOk('x'.repeat(32)), true);
  assert.equal(secretOk('x'.repeat(31)), false);
  assert.equal(secretOk(undefined), false);
  assert.equal(secretOk(''), false);
});

test('safeEqual、雜湊與隨機值', async () => {
  assert.equal(await safeEqual('abc', 'abc'), true);
  assert.equal(await safeEqual('abc', 'abd'), false);
  assert.equal(await safeEqual('abc', 'abcd'), false);
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await hmacHex('key', 'The quick brown fox jumps over the lazy dog'), 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  assert.match(randomToken(32), /^[A-Za-z0-9_-]{43}$/);
  assert.match(randomHex(16), /^[a-f0-9]{32}$/);
  assert.equal(new Set(Array.from({ length: 200 }, () => randomToken(32))).size, 200);
});

test('每個回應都帶：不快取、內容安全政策、不給嵌入、不給收錄', () => {
  const h = baseHeaders();
  assert.equal(h['Cache-Control'], 'private, no-store');
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
  assert.equal(h['X-Frame-Options'], 'DENY');
  assert.equal(h['Referrer-Policy'], 'same-origin', '不能是 no-referrer：瀏覽器會把表單的 Origin 送成 null');
  assert.match(h['X-Robots-Tag'], /noindex/);
  const csp = h['Content-Security-Policy'];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /form-action 'self'/);
  assert.ok(!/unsafe-inline|unsafe-eval|\*|https?:|data:/.test(csp), 'CSP 不可以放寬');
  assert.ok(!/connect-src/.test(csp));
  assert.match(baseHeaders({ connect: true })['Content-Security-Policy'], /connect-src 'self'/);
  assert.equal(html('<p>x</p>').headers.get('cache-control'), 'private, no-store');
  assert.equal(redirect('/').status, 303);
});

test('readForm：只收一般表單，而且有大小上限', async () => {
  const make = (body, type = 'application/x-www-form-urlencoded') => new Request('https://room.example/reply', { method: 'POST', headers: { 'Content-Type': type }, body });
  assert.equal((await readForm(make('a=1&b=%E5%BD%A9'))).get('b'), '彩');
  await assert.rejects(readForm(make('{"a":1}', 'application/json')), (e) => e instanceof HttpError && e.status === 415);
  await assert.rejects(readForm(make('a=1', 'multipart/form-data; boundary=x')), (e) => e instanceof HttpError && e.status === 415);
  await assert.rejects(readForm(make('a=' + 'x'.repeat(5000)), 4096), (e) => e instanceof HttpError && e.status === 413);
});

/** 一塊一塊送出內容的串流，並記下被讀了幾塊、有沒有被取消（用來確認伺服器沒有把整個內容讀完） */
function countedStream(chunkBytes, chunks) {
  const seen = { pulled: 0, cancelled: false };
  const stream = new ReadableStream({
    pull(controller) {
      if (seen.pulled >= chunks) { controller.close(); return; }
      seen.pulled += 1;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x61));
    },
    cancel() { seen.cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, seen };
}
const streamed = (stream, headers = {}) => new Request('https://room.example/reply', { method: 'POST', body: stream, duplex: 'half', headers });
const tooLarge = (e) => e instanceof HttpError && e.status === 413;

test('readBody：沒有 Content-Length 的超額串流，讀到上限就停，不會把整個內容讀完', async () => {
  // 256 塊 × 16 KiB = 4 MiB 的內容，上限 32 KiB：讀到第 3 塊（48 KiB）就超過了
  const { stream, seen } = countedStream(16 * 1024, 256);
  const request = streamed(stream);
  assert.equal(request.headers.get('content-length'), null, '這個請求沒有 Content-Length');
  await assert.rejects(readBody(request, 32 * 1024), tooLarge);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(seen.pulled >= 3 && seen.pulled <= 6, `只讀了 ${seen.pulled} 塊（全部有 256 塊）`);
  assert.equal(seen.cancelled, true, '剩下的內容被取消，不再讀取');
});

test('readBody：Content-Length 只用來提早拒絕；寫得比實際小也騙不過去', async () => {
  // 宣告的長度已經超過上限：一塊都不讀
  const declared = countedStream(1024, 4);
  await assert.rejects(readBody(streamed(declared.stream, { 'Content-Length': String(10 * 1024 * 1024) }), 4096), tooLarge);
  assert.equal(declared.seen.pulled, 0);
  // 宣告 10 個位元組，實際送 64 KiB：照實際讀到的量判斷
  const lying = countedStream(8 * 1024, 8);
  await assert.rejects(readBody(streamed(lying.stream, { 'Content-Length': '10' }), 16 * 1024), tooLarge);
  assert.ok(lying.seen.pulled <= 5, `只讀了 ${lying.seen.pulled} 塊`);
});

test('readBody：剛好在上限以內的內容完整讀出', async () => {
  const exact = await readBody(streamed(countedStream(1000, 4).stream), 4000);
  assert.ok(exact instanceof Uint8Array);
  assert.equal(exact.byteLength, 4000);
  assert.ok(exact.every((b) => b === 0x61));
  await assert.rejects(readBody(streamed(countedStream(1000, 4).stream), 3999), tooLarge);
  assert.equal((await readBody(new Request('https://room.example/x', { method: 'POST' }), 10)).byteLength, 0, '沒有內容');
  assert.equal(new TextDecoder().decode(await readBody(new Request('https://room.example/x', { method: 'POST', body: 'a=1' }), 10)), 'a=1');
});

test('日期與時間的寫法', () => {
  assert.equal(formatDate('2026-11-14', 'ja'), '2026年11月14日');
  assert.equal(formatDate('2026-11-14', 'zh'), '2026 年 11 月 14 日');
  assert.equal(formatDate('', 'ja'), '');
  assert.equal(formatTime(Date.UTC(2026, 10, 14, 15, 5) / 1000), '2026-11-15 00:05');   // 日本時間 = UTC+9
});

/* ---------- 訪客密碼 ---------- */

const SAMPLE_PW = '0f3a-9c7e-51d2-b846-e0a7-3f19-c25d-8b64';          // 測試用的固定值，不是任何正式密碼
const SAMPLE_PW_PLAIN = SAMPLE_PW.replace(/-/g, '');

test('密碼的正規化：大小寫、空白、連字號、全形都算同一組', () => {
  assert.equal(normalizePassword(SAMPLE_PW), SAMPLE_PW_PLAIN);
  const fullWidth = SAMPLE_PW.replace(/[0-9a-f]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).replace(/-/g, String.fromCharCode(0xff0d));
  assert.notEqual(fullWidth, SAMPLE_PW);
  for (const variant of [SAMPLE_PW.toUpperCase(), ' ' + SAMPLE_PW.replace(/-/g, ' ') + ' ', SAMPLE_PW_PLAIN + '\n', SAMPLE_PW.replace(/-/g, '・'), SAMPLE_PW.replace(/-/g, '—'), SAMPLE_PW.replace(/-/g, '‐'), fullWidth]) {
    assert.equal(normalizePassword(variant), SAMPLE_PW_PLAIN, JSON.stringify(variant));
  }
  // 從訊息裡複製時連引號、括號、句號一起選到
  for (const variant of [`「${SAMPLE_PW}」`, `"${SAMPLE_PW}"`, `${SAMPLE_PW}。`, `（${SAMPLE_PW}）`, `『${SAMPLE_PW.replace(/-/g, ' ')}』！`, `'${SAMPLE_PW}'.`]) {
    assert.equal(normalizePassword(variant), SAMPLE_PW_PLAIN, JSON.stringify(variant));
  }
  assert.notEqual(normalizePassword('合言葉：' + SAMPLE_PW), SAMPLE_PW_PLAIN, '前面多了別的字就不是同一組');
  assert.equal(normalizePassword(null), '');
  assert.equal(normalizePassword('   -  '), '');
  assert.equal(normalizePassword('「」。！'), '');
});

test('邀請密碼：16 個位元組直接取自系統亂數（128 bit），寫成 8 組十六進位字', () => {
  assert.equal(PASSWORD_BYTES, 16);
  const made = Array.from({ length: 300 }, () => generatePassword());
  for (const pw of made) { assert.match(pw, /^([0-9a-f]{4}-){7}[0-9a-f]{4}$/); }
  assert.equal(new Set(made).size, 300);
  // 16 種字都會出現，而且每一個位置都不是固定的
  assert.equal(new Set(made.join('').replace(/-/g, '')).size, 16);
  for (let i = 0; i < 39; i++) { if (made[0][i] !== '-') { assert.ok(new Set(made.map((pw) => pw[i])).size > 8, `第 ${i} 個字`); } }

  // 產生的過程：向 crypto.getRandomValues 要剛好 16 個位元組，原封不動地寫成十六進位（沒有取餘數、沒有查表、沒有丟掉位元）
  const original = crypto.getRandomValues;
  const calls = [];
  crypto.getRandomValues = (array) => { calls.push(array.length); for (let i = 0; i < array.length; i++) { array[i] = (i * 37 + 11) & 0xff; } return array; };
  try {
    assert.equal(generatePassword(), '0b30-557a-9fc4-e90e-3358-7da2-c7ec-1136');
  } finally { crypto.getRandomValues = original; }
  assert.deepEqual(calls, [16]);
  const code = noComments(source('shared/password.js'));
  assert.ok(!/Math\.random/.test(code), '不可以用 Math.random');
});

test('貼上時的整理不會減少隨機性：整理後的結果和那 16 個位元組一對一', () => {
  // 整理後 = 位元組的十六進位寫法。十六進位寫法和位元組本來就是一對一，所以 2^128 種密碼整理之後仍然是 2^128 種
  const samples = [new Uint8Array(16), new Uint8Array(16).fill(0xff), Uint8Array.from({ length: 16 }, (_, i) => i), Uint8Array.from({ length: 16 }, (_, i) => 0xf0 | i),
    Uint8Array.from({ length: 16 }, (_, i) => (i % 2 ? 0xaa : 0x0a)), ...Array.from({ length: 200 }, () => crypto.getRandomValues(new Uint8Array(16)))];
  for (const bytes of samples) {
    const pw = formatPassword(bytes);
    assert.equal(normalizePassword(pw), toHex(bytes));
    assert.equal(normalizePassword(pw).length, 32);
    assert.ok(isInvitationPassword(pw) && isInvitationPassword(pw.toUpperCase()) && isInvitationPassword(pw.replace(/-/g, ' ')));
  }
  // 只差一個位元的兩組密碼，整理之後仍然不同
  for (let bit = 0; bit < 128; bit++) {
    const a = new Uint8Array(16), b = new Uint8Array(16);
    b[bit >> 3] = 1 << (bit & 7);
    assert.notEqual(normalizePassword(formatPassword(a)), normalizePassword(formatPassword(b)), `第 ${bit} 個位元`);
  }
  assert.throws(() => formatPassword(new Uint8Array(15)));
  assert.throws(() => formatPassword(new Uint8Array(17)));
});

test('登入只受理邀請密碼的格式：一般的長句、舊格式、長度不對的都不算', () => {
  for (const other of ['welcomeeverybodyhere', 'kase-moni-tuha-rike-soya-nube', 'correct horse battery staple', 'ayaka-niziu-20030620-withu', '12345678901234567890',
    SAMPLE_PW_PLAIN.slice(0, 31), SAMPLE_PW_PLAIN + '0', SAMPLE_PW_PLAIN.slice(0, 31) + 'g', '', null, undefined]) {
    assert.equal(isInvitationPassword(other), false, String(other));
  }
  assert.equal(isInvitationPassword(SAMPLE_PW), true);
  // 沒有任何「自己取密碼」或「檢查密碼強度」的程式留下來
  const password = source('shared/password.js'), admin = source('admin/src/index.js');
  for (const gone of ['weaknesses', 'MIN_LENGTH', 'GUESSABLE']) { assert.ok(!password.includes(gone) && !admin.includes(gone), gone); }
  assert.ok(!admin.includes('/access/set'), '管理端沒有設定任意密碼的入口');
  assert.ok(!/name="password"/.test(admin), '管理頁沒有輸入密碼的欄位');
});

test('存進資料庫的是加了金鑰的雜湊：同樣的密碼、不同的金鑰，結果不同', async () => {
  const a = await hashPassword('p'.repeat(40), SAMPLE_PW);
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.equal(a, await hashPassword('p'.repeat(40), SAMPLE_PW.toUpperCase().replace(/-/g, ' ')));
  assert.notEqual(a, await hashPassword('q'.repeat(40), SAMPLE_PW));
  assert.notEqual(a, await hashPassword('p'.repeat(40), SAMPLE_PW.slice(0, -1) + '5'));
  assert.notEqual(a, await sha256Hex(SAMPLE_PW_PLAIN), '不是單純的 SHA-256');
  // 金鑰的檢查值：同一把金鑰結果相同、不同金鑰結果不同，而且和任何密碼的雜湊都不一樣
  assert.equal(await pepperCheck('p'.repeat(40)), await pepperCheck('p'.repeat(40)));
  assert.notEqual(await pepperCheck('p'.repeat(40)), await pepperCheck('q'.repeat(40)));
  assert.notEqual(await pepperCheck('p'.repeat(40)), await hashPassword('p'.repeat(40), 'pepper-check:v1'));
});

/* ---------- JPEG：只留下影像本身 ---------- */

const has = (bytes, textValue) => Buffer.from(bytes).includes(Buffer.from(textValue, 'latin1'));
const same = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const join = (...parts) => new Uint8Array(Buffer.concat(parts.map((part) => Buffer.from(part))));
/** 一個區段：FF、標記、長度（含長度欄位自己的 2 個位元組）、內容 */
const segment = (marker, payload) => {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'latin1') : Buffer.from(payload);
  return Buffer.concat([Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
};
/** JFIF 檔頭（可以帶縮圖與多餘的資料） */
const jfif = ({ version = [1, 1], units = 0, x = 1, y = 1, thumb = [0, 0], thumbData = null, extra = '' } = {}) => segment(0xe0, Buffer.concat([
  Buffer.from('JFIF\0', 'latin1'), Buffer.from([version[0], version[1], units, x >> 8, x & 0xff, y >> 8, y & 0xff, thumb[0], thumb[1]]),
  thumbData || Buffer.alloc(3 * thumb[0] * thumb[1], 0x5a), Buffer.from(extra, 'latin1'),
]));
const adobe = ({ transform = 1, version = 100, flags0 = 0, flags1 = 0, extra = '' } = {}) => segment(0xee, Buffer.concat([
  Buffer.from('Adobe', 'latin1'), Buffer.from([version >> 8, version & 0xff, flags0 >> 8, flags0 & 0xff, flags1 >> 8, flags1 & 0xff, transform]), Buffer.from(extra, 'latin1'),
]));
const HEADER_END = 2 + JFIF_HEADER.length;     // 範例圖的開頭是 SOI ＋ 固定的 JFIF 檔頭
/** 把範例圖原本的 JFIF 檔頭換成別的區段（不給就是拿掉檔頭） */
const withHeader = (base, ...segments) => join(base.subarray(0, 2), ...segments, base.subarray(HEADER_END));
const insertAt = (base, at, extra) => join(base.subarray(0, at), extra, base.subarray(at));
const pieceOf = (bytes, marker, nth = 0) => walkJpeg(bytes).pieces.filter((piece) => piece.marker === marker)[nth];

test('乾淨的範例圖：是 JPEG、尺寸正確、沒有要去掉的東西', () => {
  for (const [name, w, h] of [['sample-1-full.jpg', 1200, 1500], ['sample-1-thumb.jpg', 640, 800], ['sample-3-full.jpg', 1500, 1000], ['sample-3-thumb.jpg', 800, 533], ['gray.jpg', 96, 64]]) {
    const info = inspectJpeg(fixture(name));
    assert.deepEqual(info, { ok: true, width: w, height: h, meta: [] }, name);
    const stripped = stripJpeg(fixture(name));
    assert.ok(same(stripped.bytes, fixture(name)), '沒有東西可去掉時，內容不變');
    assert.ok(same(fixture(name).subarray(0, HEADER_END), join([0xff, 0xd8], JFIF_HEADER)), `${name} 的開頭是固定的 JFIF 檔頭`);
  }
});

test('塞滿中繼資料的圖：每一種都找得到，去掉之後影像資料不變', () => {
  const dirty = fixture('with-metadata.jpg');
  assert.ok(has(dirty, 'TestPhone 99') && has(dirty, 'Tokyo Tower') && has(dirty, 'private note in XMP') && has(dirty, 'TRAILER-DATA'), '測試檔本身要有這些資料');
  const info = inspectJpeg(dirty);
  assert.equal(info.ok, true);
  assert.deepEqual(info.meta, ['Exif', 'XMP', 'ICC', 'comment', 'trailing-data']);

  const clean = stripJpeg(dirty);
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.removed, ['Exif', 'XMP', 'ICC', 'comment', 'trailing-data']);
  assert.deepEqual([clean.width, clean.height], [600, 400]);
  assert.deepEqual(inspectJpeg(clean.bytes), { ok: true, width: 600, height: 400, meta: [] });
  for (const leak of ['Exif', 'TestPhone', 'Tokyo Tower', 'private note', 'ICC_PROFILE', 'TRAILER', 'xmpmeta', '2026:11:14']) {
    assert.ok(!has(clean.bytes, leak), `去掉之後不應該還有「${leak}」`);
  }
  assert.equal(clean.bytes[clean.bytes.length - 2], 0xff);
  assert.equal(clean.bytes[clean.bytes.length - 1], 0xd9);
  // 無損：剩下的位元組，就是原檔裡留下來的那幾段，一個位元組都沒有改
  const walked = walkJpeg(dirty);
  assert.ok(walked.pieces.every((piece) => !piece.bytes), '這個檔案的檔頭本來就是固定格式，沒有需要重寫的部分');
  assert.ok(same(clean.bytes, join(...walked.pieces.map((piece) => dirty.subarray(piece.start, piece.end)))));
  assert.deepEqual([...new Set(walked.pieces.map((piece) => piece.marker))].sort(), [0xc0, 0xc4, 0xd8, 0xd9, 0xda, 0xdb, 0xe0], '留下來的只有白名單上的區段');
});

test('手機照片（有 GPS 與方向）：座標會被去掉', () => {
  const clean = stripJpeg(fixture('phone-like.jpg'));
  assert.deepEqual(clean.removed, ['Exif']);
  assert.ok(!has(clean.bytes, 'Exif') && !has(clean.bytes, 'TestPhone'));
});

test('藏在比較少見位置的中繼資料也會被找到', () => {
  const base = fixture('sample-3-full.jpg');                // 漸進式 JPEG：有好幾段掃描資料
  const scans = walkJpeg(base).pieces.filter((piece) => piece.marker === 0xda);
  assert.ok(scans.length > 1, '這張測試圖要是漸進式的');

  // 兩段掃描資料之間
  const late = insertAt(base, scans[1].start, segment(0xe1, 'Exif\0\0hidden-between-scans'));
  assert.deepEqual(inspectJpeg(late).meta, ['Exif']);
  assert.ok(same(stripJpeg(late).bytes, base));
  // 其他種類：IPTC、多張圖、JFXX 縮圖、第二個 JFIF 檔頭、不認得的 APP、註解、JPGn
  for (const [extra, label] of [[segment(0xed, 'Photoshop 3.0\0iptc'), 'IPTC'], [segment(0xe2, 'MPF\0second-image'), 'MPF'], [segment(0xe0, 'JFXX\0\x13thumb'), 'APP0-extension'],
    [jfif({ thumb: [2, 2] }), 'APP0-extension'], [segment(0xe5, 'vendor-data'), 'APP5'], [segment(0xef, 'x'), 'APP15'], [segment(0xee, 'not-adobe-data'), 'APP14'],
    [segment(0xee, 'Adobe\0d'), 'APP14'], [segment(0xfe, 'note'), 'comment'], [segment(0xf7, 'jpg-extension'), 'JPG7'], [segment(0xfd, ''), 'JPG13']]) {
    for (const at of [scans[0].start, HEADER_END]) {
      const crafted = insertAt(base, at, extra);
      assert.deepEqual(inspectJpeg(crafted).meta, [label]);
      assert.ok(same(stripJpeg(crafted).bytes, base), label);
    }
  }
  // 掃描資料開始之後才出現的 JFIF 檔頭或 Adobe 標記不算數（解碼器也不會看），一樣去掉
  assert.deepEqual(inspectJpeg(insertAt(base, scans[1].start, adobe())).meta, ['APP14']);
  assert.ok(same(stripJpeg(insertAt(base, scans[1].start, adobe())).bytes, base));
  // 標記前面的填充位元組、掃描資料後面的填充位元組
  for (const at of [HEADER_END, scans[0].start, scans[1].start, base.length - 2]) {
    const padded = insertAt(base, at, [0xff, 0xff, 0xff]);
    assert.deepEqual(inspectJpeg(padded).meta, ['padding'], `填充在位置 ${at}`);
    assert.ok(same(stripJpeg(padded).bytes, base));
  }
  // 檔尾接了第二個檔案
  const doubled = join(base, fixture('with-metadata.jpg'));
  assert.deepEqual(inspectJpeg(doubled).meta, ['trailing-data']);
  assert.ok(same(stripJpeg(doubled).bytes, base));
});

test('JFIF 檔頭一律重寫成固定內容：內嵌的縮圖、多餘的資料、解析度欄位都不會留下來', () => {
  const base = fixture('sample-3-thumb.jpg');
  // 合法的內嵌縮圖：4×3 個像素、每個像素 3 個位元組（這裡用看得出來的字當作縮圖資料）
  const thumbData = Buffer.from('THUMBNAIL-PIXELS-OF-THE-ORIGINAL-PIC!', 'latin1').subarray(0, 36);
  const cases = [
    ['合法的內嵌縮圖', jfif({ thumb: [4, 3], thumbData }), ['JFIF-thumbnail'], 'THUMBNAIL-PIXELS'],
    ['檔頭後面多塞的資料', jfif({ extra: 'EXTRA-PAYLOAD-AFTER-HEADER' }), ['JFIF-extra-data'], 'EXTRA-PAYLOAD'],
    ['縮圖加上多塞的資料', jfif({ thumb: [4, 3], thumbData, extra: 'EXTRA-PAYLOAD-AFTER-THUMB' }), ['JFIF-thumbnail', 'JFIF-extra-data'], 'EXTRA-PAYLOAD'],
    ['宣告有縮圖但資料不夠長', jfif({ thumb: [200, 200], thumbData: Buffer.from('SHORT-THUMB', 'latin1') }), ['JFIF-thumbnail', 'JFIF-extra-data'], 'SHORT-THUMB'],
    ['解析度欄位（300 dpi）', jfif({ version: [1, 2], units: 1, x: 300, y: 300 }), ['JFIF-header'], null],
    ['解析度欄位被拿來放資料', jfif({ units: 2, x: 0x4849, y: 0x4445 }), ['JFIF-header'], null],
  ];
  for (const [name, header, expected, leak] of cases) {
    const crafted = withHeader(base, header);
    if (leak) { assert.ok(has(crafted, leak), `${name}：測試檔本身要有這段資料`); }
    const info = inspectJpeg(crafted);
    assert.deepEqual(info, { ok: true, width: 800, height: 533, meta: expected }, name);
    const clean = stripJpeg(crafted);
    assert.deepEqual(clean.removed, expected, name);
    assert.ok(same(clean.bytes, base), `${name}：清理後和乾淨的範例圖一模一樣`);
    assert.ok(same(clean.bytes.subarray(2, HEADER_END), JFIF_HEADER), `${name}：檔頭是固定的 18 個位元組`);
    if (leak) { assert.ok(!has(clean.bytes, leak), `${name}：清理後不應該還有「${leak}」`); }
    assert.deepEqual(inspectJpeg(clean.bytes).meta, [], name);
  }
  assert.deepEqual([...JFIF_HEADER], [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  // 來源檔沒有 JFIF 檔頭時不會自己加一個（加了反而可能改變顏色的解讀）
  const bare = withHeader(base);
  assert.deepEqual(inspectJpeg(bare).meta, []);
  assert.ok(same(stripJpeg(bare).bytes, bare));
  assert.ok(!has(stripJpeg(bare).bytes, 'JFIF'));
});

test('Adobe 色彩標記：只留「色彩轉換方式」，其餘重寫；內容不合理就整個檔案不收', () => {
  const base = fixture('sample-3-thumb.jpg');
  const canonical = adobeSegment(1);
  assert.deepEqual([...canonical], [0xff, 0xee, 0x00, 0x0e, 0x41, 0x64, 0x6f, 0x62, 0x65, 0x00, 0x64, 0x00, 0x00, 0x00, 0x00, 0x01]);
  const plain = withHeader(base, canonical);                      // 沒有 JFIF、只有固定格式的 Adobe 標記
  assert.deepEqual(inspectJpeg(plain).meta, []);
  assert.ok(same(stripJpeg(plain).bytes, plain));
  for (const [name, marker, expected, leak] of [
    ['後面多塞的資料', adobe({ extra: 'HIDDEN-IN-ADOBE-SEGMENT' }), ['Adobe-extra-data'], 'HIDDEN-IN-ADOBE'],
    ['旗標欄位被拿來放資料', adobe({ flags0: 0x4849, flags1: 0x4445 }), ['Adobe-header'], null],
    ['版本欄位不同', adobe({ version: 101 }), ['Adobe-header'], null],
  ]) {
    const crafted = withHeader(base, marker);
    assert.deepEqual(inspectJpeg(crafted).meta, expected, name);
    const clean = stripJpeg(crafted);
    assert.ok(same(clean.bytes, plain), `${name}：清理後只剩固定格式的標記`);
    if (leak) { assert.ok(has(crafted, leak) && !has(clean.bytes, leak), name); }
  }
  // 「不轉換」（RGB）的標記：值保留下來（拿掉會改變顏色的解讀）
  const rgb = withHeader(base, adobe({ transform: 0, extra: 'x' }));
  assert.deepEqual(inspectJpeg(rgb).meta, ['Adobe-extra-data']);
  assert.ok(same(stripJpeg(rgb).bytes, withHeader(base, adobeSegment(0))));
  // JFIF 與 Adobe（YCbCr）同時存在：兩個都留，各自是固定格式
  const both = insertAt(base, HEADER_END, adobe({ flags0: 0xc000 }));
  assert.deepEqual(inspectJpeg(both).meta, ['Adobe-header']);
  assert.ok(same(stripJpeg(both).bytes, insertAt(base, HEADER_END, canonical)));
  // 不合理的內容：沒有定義的轉換方式、四個色版用的 YCCK、和 JFIF 檔頭互相矛盾
  for (const [name, crafted] of [['轉換方式 2（YCCK）', withHeader(base, adobe({ transform: 2 }))], ['轉換方式 7', withHeader(base, adobe({ transform: 7 }))],
    ['轉換方式 255', withHeader(base, adobe({ transform: 255 }))], ['有 JFIF 又標示不轉換', insertAt(base, HEADER_END, adobe({ transform: 0 }))]]) {
    assert.deepEqual(inspectJpeg(crafted), { ok: false, reason: 'bad-adobe' }, name);
    assert.deepEqual(stripJpeg(crafted), { ok: false, reason: 'bad-adobe' }, name);
  }
  // 只有一個色版（灰階）時用不到這個標記：去掉
  const gray = fixture('gray.jpg');
  const grayAdobe = insertAt(gray, HEADER_END, adobe({ transform: 0 }));
  assert.deepEqual(inspectJpeg(grayAdobe).meta, ['Adobe']);
  assert.ok(same(stripJpeg(grayAdobe).bytes, gray));
});

test('瀏覽器不支援或不認得的格式，整個檔案不收', () => {
  assert.deepEqual(inspectJpeg(fixture('cmyk.jpg')), { ok: false, reason: 'unsupported' }, '四個色版（CMYK）');
  const base = fixture('sample-3-thumb.jpg');
  const frame = pieceOf(base, 0xc0), table = pieceOf(base, 0xdb), scan = pieceOf(base, 0xda);
  const patched = (at, value) => { const copy = new Uint8Array(base); copy[at] = value; return copy; };
  for (const [name, crafted, reason] of [
    ['無失真編碼（SOF3）', patched(frame.start + 1, 0xc3), 'unsupported'],
    ['算術編碼（SOF9）', patched(frame.start + 1, 0xc9), 'unsupported'],
    ['階層式（SOF5）', patched(frame.start + 1, 0xc5), 'unsupported'],
    ['12 bit', patched(frame.start + 4, 12), 'unsupported'],
    ['DNL 區段', insertAt(base, scan.start, segment(0xdc, [0x02, 0x15])), 'unsupported'],
    ['算術編碼的設定（DAC）', insertAt(base, scan.start, segment(0xcc, [0x00, 0x10])), 'unsupported'],
    ['保留的標記（02）', insertAt(base, table.start, [0xff, 0x02]), 'corrupt'],
    ['TEM', insertAt(base, table.start, [0xff, 0x01]), 'corrupt'],
    ['掃描資料以外的 RST', insertAt(base, table.start, [0xff, 0xd0]), 'corrupt'],
    ['第二個 SOI', insertAt(base, table.start, [0xff, 0xd8]), 'corrupt'],
    ['兩個影像格式（SOF）', insertAt(base, scan.start, base.subarray(frame.start, frame.end)), 'corrupt'],
    ['掃描資料前沒有影像格式', join(base.subarray(0, frame.start), base.subarray(frame.end)), 'corrupt'],
    ['寬度是 0', patched(frame.start + 7, 0) && (() => { const c = new Uint8Array(base); c[frame.start + 7] = 0; c[frame.start + 8] = 0; return c; })(), 'no-image'],
  ]) {
    assert.deepEqual(inspectJpeg(crafted), { ok: false, reason }, name);
    assert.equal(stripJpeg(crafted).ok, false, name);
  }
});

test('表格或區段的長度和內容對不上（後面多塞了資料），整個檔案不收', () => {
  const base = fixture('sample-3-thumb.jpg');
  /** 在某個區段的內容後面多塞幾個位元組，並把長度欄位改成新的長度 */
  const stuffed = (piece, extra, headerOnly = false) => {
    const length = (base[piece.start + 2] << 8) | base[piece.start + 3];
    const end = headerOnly ? piece.start + 2 + length : piece.end;
    const grown = length + extra.length;
    return join(base.subarray(0, piece.start + 2), [grown >> 8, grown & 0xff], base.subarray(piece.start + 4, end), extra, base.subarray(end));
  };
  const hidden = Buffer.from('HIDDEN', 'latin1'), zeros = [0, 0, 0];
  for (const [name, crafted] of [
    ['量化表後面多了資料', stuffed(pieceOf(base, 0xdb), hidden)], ['量化表後面多了幾個 0', stuffed(pieceOf(base, 0xdb, 1), zeros)],
    ['霍夫曼表後面多了資料', stuffed(pieceOf(base, 0xc4), hidden)], ['霍夫曼表後面多了幾個 0', stuffed(pieceOf(base, 0xc4, 2), zeros)],
    ['影像格式後面多了資料', stuffed(pieceOf(base, 0xc0), hidden)],
    ['掃描的開頭多了資料', stuffed(pieceOf(base, 0xda), hidden, true)],
    ['重新開始的間隔長度不對', insertAt(base, pieceOf(base, 0xda).start, segment(0xdd, [0, 8, 0x48, 0x49]))],
  ]) {
    assert.deepEqual(inspectJpeg(crafted), { ok: false, reason: 'corrupt' }, name);
  }
  // 長度正確的「重新開始的間隔」是影像的一部分，留著
  const withInterval = insertAt(base, pieceOf(base, 0xda).start, segment(0xdd, [0, 0]));
  assert.deepEqual(inspectJpeg(withInterval).meta, []);
  assert.ok(same(stripJpeg(withInterval).bytes, withInterval));
});

test('清理的結果是固定的：meta 是空的 ⟺ 一個位元組都不變；再清理一次也不會變', () => {
  const base = fixture('sample-3-thumb.jpg'), progressive = fixture('sample-3-full.jpg');
  const inputs = [base, progressive, fixture('gray.jpg'), fixture('with-metadata.jpg'), fixture('phone-like.jpg'), withHeader(base), withHeader(base, adobeSegment(1)),
    withHeader(base, jfif({ thumb: [3, 3] })), withHeader(base, jfif({ units: 1, x: 72, y: 72 })), withHeader(base, adobe({ extra: 'zz' })),
    insertAt(base, HEADER_END, segment(0xe1, 'Exif\0\0abc')), insertAt(base, 2, [0xff]), join(base, [0x00]), insertAt(progressive, HEADER_END, segment(0xfe, 'c')),
    insertAt(base, HEADER_END, adobe({ flags0: 1 }))];
  for (const [index, input] of inputs.entries()) {
    const info = inspectJpeg(input), clean = stripJpeg(input);
    assert.ok(info.ok && clean.ok, `第 ${index} 個輸入`);
    assert.equal(info.meta.length === 0, same(clean.bytes, input), `第 ${index} 個輸入：meta = ${JSON.stringify(info.meta)}`);
    const again = stripJpeg(clean.bytes);
    assert.deepEqual(again.removed, [], `第 ${index} 個輸入：清理後就沒有要去掉的東西`);
    assert.ok(same(again.bytes, clean.bytes));
    assert.deepEqual([info.width, info.height], [clean.width, clean.height]);
    // 留下來的區段只有：SOI、固定的 JFIF／Adobe、量化表、霍夫曼表、影像格式、間隔、掃描資料、EOI
    for (const piece of walkJpeg(clean.bytes).pieces) { assert.ok([0xd8, 0xe0, 0xee, 0xdb, 0xc4, 0xc0, 0xc1, 0xc2, 0xdd, 0xda, 0xd9].includes(piece.marker), piece.marker.toString(16)); }
  }
});

test('不是 JPEG、或檔案不完整，都不收', () => {
  assert.deepEqual(inspectJpeg(fixture('not-a-jpeg.png')), { ok: false, reason: 'not-jpeg' });
  assert.equal(inspectJpeg(new Uint8Array(0)).ok, false);
  assert.equal(inspectJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])).ok, false, '只有檔頭檔尾、沒有影像');
  const base = fixture('sample-3-thumb.jpg');
  assert.equal(stripJpeg(base.subarray(0, base.length - 2)).ok, false, '少了結尾');
  assert.equal(stripJpeg(base.subarray(0, 300)).ok, false, '被截斷');
  for (let cut = 3; cut < 700; cut += 7) { assert.equal(stripJpeg(base.subarray(0, cut)).ok, false, `截到第 ${cut} 個位元組`); }
  const broken = new Uint8Array(base); broken[2] = 0x00;
  assert.equal(stripJpeg(broken).ok, false);
  assert.equal(stripJpeg(new TextEncoder().encode('<html><script>alert(1)</script></html>')).ok, false);
});

/* ---------- 畫面文字 ---------- */

test('畫面上的每一句都有日文與中文', () => {
  for (const [key, entry] of Object.entries(STRINGS)) {
    for (const lang of LANGS) { assert.ok(typeof entry[lang] === 'string' && entry[lang].length > 0, `${key}.${lang}`); }
    const slots = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
    assert.equal(slots(entry.ja), slots(entry.zh), `${key} 的參數兩種語言要一樣`);
  }
  assert.equal(tr('replyTooLong', 'ja', { max: 2000 }), '2000文字以内で入力してください。');
  assert.equal(tr('no-such-key', 'ja'), 'no-such-key');
});

test('沒有收到「已經存好」的確認時，畫面上不把話說死：不說沒有送出，只說無法確認、內容留著、可以繼續送出', () => {
  // 這幾句出現的時候，那一則回覆有可能其實已經存好、只是成功的回應沒有送到（斷線、逾時、伺服器錯誤，
  // 或前一次是那樣、這一次才遇到登入過期或表單過期）
  const UNCONFIRMED = ['replyFailed', 'replyExpired', 'replySession', 'replySessionGate', 'draftLabel', 'draftRestored'];
  // 斷定「沒有送出」的說法（「有沒有送出」是在問，不算）
  const NOT_SENT = { ja: /送信できませんでした|送信されていません|送信されていない|送信に失敗|未送信/, zh: /(?<!有)沒有送出|還沒送出|尚未送出|未送出|送出失敗/ };
  const UNSURE = { ja: /確認でき(ませんでした|ていません|ていない)/, zh: /無法確認|還沒確認/ };
  const KEPT = { ja: /残っています/, zh: /留著|留在/ };
  const CONTINUE = { ja: /「送信する」を押|送信を続けられます/, zh: /再按一次「送出」|繼續送出/ };
  for (const key of UNCONFIRMED) {
    for (const lang of LANGS) {
      const text = STRINGS[key][lang];
      assert.doesNotMatch(text, NOT_SENT[lang], `${key}.${lang} 不可以斷定沒有送出`);
      assert.match(text, UNSURE[lang], `${key}.${lang} 要說明無法確認送出的結果`);
      if (key === 'draftLabel') { continue; }                  // 標籤只有一個名詞
      assert.match(text, KEPT[lang], `${key}.${lang} 要說明內容還留著`);
      assert.match(text, CONTINUE[lang], `${key}.${lang} 要說明可以繼續送出`);
    }
  }
  // 檢查用的規則本身要抓得到原本的寫法（修正前的四句）
  for (const old of ['送信できませんでした。入力した内容はそのまま残っています。', 'ログインの有効期限が切れたため、まだ送信されていません。', 'まだ送信されていないメッセージ', 'ログインし直しました。メッセージはまだ送信されていません。']) {
    assert.match(old, NOT_SENT.ja, old);
  }
  for (const old of ['沒有送出成功。剛剛寫的內容還留著', '登入已經過期，所以還沒有送出。', '還沒送出的留言', '已經重新登入。留言還沒有送出，請按「送出」。']) {
    assert.match(old, NOT_SENT.zh, old);
  }
  // 已經確認存好時的說法不變
  assert.deepEqual(STRINGS.replySent, { ja: '送信しました。ありがとうございます。', zh: '已經送出，謝謝。' });
  assert.deepEqual(STRINGS.replyAgain, { ja: 'もう一通送ることもできます。', zh: '也可以再寫一則。' });
  assert.match(STRINGS.replySentKept.ja, /^送信しました。/);
  assert.match(STRINGS.replySentKept.zh, /^已經送出。/);
  // 整份畫面文字裡，「沒有送出」的斷定只出現在一句：確認存好之後，輸入欄裡是另一份（和送出去的不一樣的）內容
  for (const [key, entry] of Object.entries(STRINGS)) {
    if (key === 'replySentKept') { continue; }
    for (const lang of LANGS) { assert.doesNotMatch(entry[lang], NOT_SENT[lang], `${key}.${lang}`); }
  }
  // 用到這幾句的地方
  const server = source('visitor/src/index.js');
  assert.match(server, /data-failed="\$\{t\('replyFailed'\)\}"/, '頁面腳本在斷線、逾時、回應讀不懂時顯示的那一句');
  assert.match(server, /data-session="\$\{t\('replySession'\)\}"/);
  assert.match(server, /data-done-reply="\$\{t\('draftRestored'\)\}"/, '不離開頁面重新登入之後的說明，和沒有腳本時是同一句');
  assert.match(server, /const say = error === 'errExpired' \? 'replyExpired' : error;/, '回覆的表單過期時，說明用回覆專用的那一句');
  assert.match(server, /code: error, message: tr\(say, lang/, '回應裡的 code 不變（頁面腳本靠它判斷要不要自動重送）');
  assert.equal(STRINGS.reloginDoneReply, undefined, '重新登入後的說明只有一句，不留第二種寫法');
});

test('登入前也看得到的固定文字裡，沒有只想給對方看的內容', () => {
  // 標題、留言、照片說明都存在資料庫（登入後才讀得到），不可以寫死在程式裡
  const all = JSON.stringify(STRINGS) + source('visitor/src/index.js') + source('visitor/public/room.js') + source('visitor/public/room.css');
  for (const word of ['ツーショット', '合照', 'チェキ', 'ビデオ通話', '視訊']) { assert.ok(!all.includes(word), word); }
});

/* ---------- 專案設定與原始碼的檢查 ---------- */

const jsonc = (file) => JSON.parse(source(file).replace(/^\s*\/\/.*$/gm, ''));

test('部署設定：預覽網址關閉、不開快取、沒有寫死的金鑰、管理端沒有不經驗證的靜態檔', () => {
  const visitor = jsonc('visitor/wrangler.jsonc'), admin = jsonc('admin/wrangler.jsonc');
  for (const config of [visitor, admin]) {
    assert.equal(config.preview_urls, false, '預覽網址要關閉');
    assert.equal(config.observability.enabled, false);
    assert.equal(config.cache, undefined, '不啟用 Workers Caching');
    assert.equal(config.access, undefined, '正式設定裡不可以有本機模擬 Access 的區塊（access.dev）');
    assert.equal(config.d1_databases[0].binding, 'DB');
    assert.equal(config.r2_buckets[0].binding, 'PHOTOS');
    for (const name of ['PEPPER', 'SESSION_SECRET']) { assert.ok(!(name in (config.vars || {})), `${name} 不可以寫在設定檔裡`); }
    assert.ok(!('ENVIRONMENT' in (config.vars || {})), '正式設定不可以有 ENVIRONMENT');
  }
  // 管理端：沒有「靜態檔案」設定（那些檔案會在 Worker 之前就被送出）；樣式與腳本包在程式裡，驗證身分後才送
  assert.equal(admin.assets, undefined);
  assert.equal(existsSync(path.join(ROOT, 'admin', 'public')), false);
  assert.deepEqual(Object.keys(STATIC_FILES).sort(), ['/admin.css', '/admin.js', '/favicon.svg', '/room.css']);
  assert.ok(STATIC_FILES['/admin.js'].body.includes('createImageBitmap') && STATIC_FILES['/admin.css'].body.includes('.admin__'));
  // Access 的設定值與站主的信箱不寫在設定檔裡（repo 是公開的），用 secret 設定；沒設定時管理端會拒絕所有請求
  for (const name of ['TEAM_DOMAIN', 'POLICY_AUD', 'ADMIN_EMAILS']) { assert.ok(!(name in admin.vars), `${name} 不寫在設定檔裡`); }
  assert.ok(!/@[a-z0-9-]+\.[a-z]/i.test(source('admin/wrangler.jsonc')) && !/@[a-z0-9-]+\.[a-z]/i.test(source('visitor/wrangler.jsonc')), '設定檔裡沒有任何信箱');
  // 訪客端：公開的靜態檔只有樣式、腳本與圖示（沒有任何私人內容），其餘都由 Worker 處理
  assert.ok(!visitor.assets.run_worker_first);
  assert.deepEqual(readdirSync(path.join(ROOT, 'visitor', 'public')).sort(), ['_headers', 'favicon.svg', 'room.css', 'room.js']);
  assert.notEqual(visitor.name, admin.name);
  assert.equal(visitor.d1_databases[0].database_name, admin.d1_databases[0].database_name);
  assert.equal(visitor.r2_buckets[0].bucket_name, admin.r2_buckets[0].bucket_name);
});

/* ---------- 管理者身分（Cloudflare Access） ---------- */

const accessEnv = { POLICY_AUD: 'aud-0123456789', ADMIN_EMAILS: 'Owner@Example.test, second@example.test', TEAM_DOMAIN: 'https://team.cloudflareaccess.com' };
const noJwt = () => new Request('https://admin.example/');
const ctxWith = (aud, identity) => ({ access: { aud, getIdentity: async () => identity } });
const denied = (code) => (err) => err instanceof AccessError && err.code === code;

test('管理者身分：Access 掛在 Worker 上時（ctx.access），還要確認對象（AUD）與信箱', async () => {
  assert.deepEqual(await requireAdmin(noJwt(), accessEnv, ctxWith('aud-0123456789', { email: 'owner@example.test' })), { email: 'owner@example.test', via: 'ctx' });
  assert.equal((await requireAdmin(noJwt(), accessEnv, ctxWith('aud-0123456789', { email: 'SECOND@example.test' }))).email, 'second@example.test', '信箱不分大小寫');
  await assert.rejects(requireAdmin(noJwt(), accessEnv, ctxWith('another-application', { email: 'owner@example.test' })), denied('aud-mismatch'));
  await assert.rejects(requireAdmin(noJwt(), accessEnv, ctxWith('aud-0123456789', { email: 'stranger@example.test' })), denied('not-allowed'));
  await assert.rejects(requireAdmin(noJwt(), accessEnv, ctxWith('aud-0123456789', { email: 'owner@example.test.evil.test' })), denied('not-allowed'));
  await assert.rejects(requireAdmin(noJwt(), accessEnv, ctxWith('aud-0123456789', {})), denied('no-email'));
  await assert.rejects(requireAdmin(noJwt(), accessEnv, ctxWith('aud-0123456789', null)), denied('no-email'));
  await assert.rejects(requireAdmin(noJwt(), accessEnv, { access: { aud: 'aud-0123456789', getIdentity: async () => { throw new Error('boom'); } } }), denied('identity-unavailable'));
  // 說明文字只在已經通過 Access 的情況下出現，方便站主修正設定
  await assert.rejects(requireAdmin(noJwt(), accessEnv, ctxWith('another-application', { email: 'owner@example.test' })), (err) => err.detail.includes('another-application'));
});

test('管理者身分：沒有通過 Access（沒有 ctx.access、也沒有憑證）或設定沒填好，一律拒絕', async () => {
  for (const ctx of [undefined, null, {}, { access: undefined }, { access: null }]) {
    await assert.rejects(requireAdmin(noJwt(), accessEnv, ctx), denied('missing-token'));
  }
  // 請求的人自己加的標頭不算數（身分只認 ctx.access 或簽章過的憑證）
  const spoof = new Request('https://admin.example/', { headers: { 'Cf-Access-Authenticated-User-Email': 'owner@example.test', 'X-Access-Aud': 'aud-0123456789' } });
  await assert.rejects(requireAdmin(spoof, accessEnv, {}), denied('missing-token'));
  const good = ctxWith('aud-0123456789', { email: 'owner@example.test' });
  for (const broken of [
    { ...accessEnv, POLICY_AUD: '' }, { ...accessEnv, POLICY_AUD: undefined }, { ...accessEnv, POLICY_AUD: 'REPLACE-WITH-ACCESS-APPLICATION-AUD' },
    { ...accessEnv, ADMIN_EMAILS: '' }, { ...accessEnv, ADMIN_EMAILS: 'not-an-email' }, { ...accessEnv, ADMIN_EMAILS: 'REPLACE-WITH-YOUR-EMAIL' }, {},
  ]) {
    await assert.rejects(requireAdmin(noJwt(), broken, good), denied('not-configured'));
  }
  // 有憑證但團隊網域沒填好（或不是 cloudflareaccess.com）：不會去別的地方抓公鑰
  const withJwt = new Request('https://admin.example/', { headers: { 'Cf-Access-Jwt-Assertion': 'a.b.c' } });
  for (const team of ['', 'https://REPLACE-ME.cloudflareaccess.com.evil.example', 'http://team.cloudflareaccess.com', 'https://evil.example', 'http://127.0.0.1:8080']) {
    await assert.rejects(requireAdmin(withJwt, { ...accessEnv, TEAM_DOMAIN: team }, {}), denied('not-configured'), team);
  }
});

test('沒有把金鑰檔或本機狀態放進版本控制', () => {
  const ignore = readFileSync(path.join(ROOT, '..', '.gitignore'), 'utf8');
  for (const rule of ['.dev.vars', '.wrangler/', 'backend/.local/']) { assert.ok(ignore.includes(rule), `.gitignore 要有 ${rule}`); }
  for (const dir of ['visitor', 'admin', '.']) {
    const file = path.join(ROOT, dir, '.dev.vars');
    if (existsSync(file)) {
      const tracked = execFileSync('git', ['ls-files', '--', file], { cwd: ROOT, encoding: 'utf8' }).trim();
      assert.equal(tracked, '', `${file} 不可以被 git 追蹤`);
    }
  }
});

test('瀏覽器端的腳本沒有任何「登入狀態」可以改，也不把內容當成 HTML 插入', () => {
  for (const file of ['visitor/public/room.js', 'admin/client/admin.js']) {
    const code = noComments(source(file));
    for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'localStorage', 'sessionStorage', 'document.cookie']) {
      assert.ok(!code.includes(banned), `${file} 不應該用到 ${banned}`);
    }
  }
});

test('伺服器端：資料庫查詢都用參數綁定，記錄只寫事件名稱', () => {
  for (const file of ['shared/store.js', 'visitor/src/index.js', 'admin/src/index.js']) {
    const code = noComments(source(file));
    const prepared = code.match(/\.prepare\(\s*([`'"])[\s\S]*?\1\s*\)/g) || [];
    // 允許的只有幾個固定的片段：marks（一串問號）與寫死的條件 VERSION_IS、CURRENT_VERSION、CURRENT_EPOCH；使用者的輸入一律用 ? 綁定
    for (const call of prepared) { assert.ok(!/\$\{(?!marks\}|VERSION_IS\}|CURRENT_VERSION\}|CURRENT_EPOCH\})/.test(call), `${file} 的 SQL 不可以用字串插值：${call.slice(0, 80)}`); }
    assert.ok(!/\.exec\(\s*[`'"]/.test(code.replace(/\/[^/\n]+\/[a-z]*\.exec\(/g, '')), `${file} 不可以用 db.exec 執行拼出來的 SQL`);
  }
  for (const file of ['visitor/src/index.js', 'admin/src/index.js', 'admin/src/access.js', 'shared/store.js', 'shared/util.js']) {
    const code = noComments(source(file));
    for (const line of code.split('\n').filter((l) => l.includes('console.'))) {
      assert.equal(line.trim(), 'console.log(JSON.stringify({ event: String(name) }));', `${file}: ${line.trim()}`);
    }
    for (const call of code.match(/logEvent\(([^)]*)\)/g) || []) {
      assert.match(call, /^logEvent\((name|'[a-z_]+'|'admin_denied_' \+ err\.code)\)$/, `${file}: ${call}`);
    }
  }
});

test('訪客端沒有任何讀取回覆或管理用的程式', () => {
  const code = noComments(source('visitor/src/index.js'));
  for (const banned of ['listReplies', 'countReplies', 'DELETE FROM', 'UPDATE photos', 'setSettingStatement', 'auditStatement', 'PHOTOS.put', 'PHOTOS.delete', 'requireAdmin']) {
    assert.ok(!code.includes(banned), `訪客端不應該有 ${banned}`);
  }
});

test('兩個 Worker 都不使用 Cloudflare 的快取 API', () => {
  for (const file of ['visitor/src/index.js', 'admin/src/index.js', 'shared/util.js', 'shared/store.js']) {
    const code = noComments(source(file));
    assert.ok(!/\bcaches\.|cache\.put\(|cf:\s*\{[^}]*cache/i.test(code), `${file} 不應該用到快取 API`);
  }
});

test('回覆的去重識別只由「送出編號＋內容」算出，不含任何和登入有關的值；頁面只在伺服器確認存好之後才換送出編號', () => {
  const server = noComments(source('visitor/src/index.js'));
  const keyLines = server.split('\n').filter((line) => line.includes('dedupeKey ='));
  assert.equal(keyLines.length, 1);
  assert.match(keyLines[0], /const dedupeKey = await sha256Hex\(`reply:\$\{nonce\}:\$\{body\}`\);/);
  assert.ok(!/session|csrf|\bref\b|idHash/.test(keyLines[0]), '去重識別裡不可以有登入代號或防偽造編號');
  // 寫入之前的順序：登入狀態 → 防偽造編號 → 送出編號的格式 → 內容 → 去重 → 限速 → 寫入
  const order = ['const session = await currentSession(request, env);', "safeEqual(String(form.get('csrf') || ''), session.csrf)", 'const dedupeKey =', 'replyExists(env.DB, dedupeKey)', 'rateTake(env.DB', 'insertReply(env.DB']
    .map((marker) => server.indexOf(marker, server.indexOf('async function handleReply')));
  assert.ok(order.every((at) => at > 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order, '先驗證登入與防偽造編號，才去重與寫入');
  // 重新登入與 /session 的回應不發送出編號
  assert.match(server, /reply: session \? \{ csrf: session\.csrf \} : null/);
  assert.match(server, /json\(\{ ok: true, csrf: replyCsrf, message: tr\('reloginDone', lang\) \}/);

  const page = noComments(source('visitor/public/room.js'));
  assert.ok(!page.includes('adoptTokens'), '沒有「防偽造編號與送出編號一起換」的函式');
  const assignments = page.split('\n').filter((line) => /elements\.nonce\.value\s*=/.test(line));
  assert.equal(assignments.length, 1, '頁面上只有一個地方會換送出編號');
  assert.match(assignments[0], /if \(data\.nonce\) \{ replyForm\.elements\.nonce\.value = data\.nonce; \}/);
  const success = page.indexOf('if (result.ok && data && data.ok) {'), assigned = page.indexOf(assignments[0].trim()), sessionBranch = page.indexOf("data.code === 'session'");
  assert.ok(success > 0 && assigned > success && assigned < sessionBranch, '而且是在「伺服器確認存好」的那一段裡');
});

/* ---------- 正式環境 CPU 用量的整理工具 ---------- */

/** 模擬 wrangler tail --format json 的一筆事件。cpuTime 傳 undefined 表示「沒有這個欄位」；其他值原樣放進去 */
const tailEvent = (method, url, cpuTime, outcome = 'ok', extra = {}) => ({
  outcome, scriptName: 'ayaka-room', eventTimestamp: 1,
  event: { request: { method, url, headers: { cookie: 'REDACTED' } }, response: { status: 200 } },
  logs: [{ message: ['{"event":"login_ok"}'] }],
  ...(cpuTime === undefined ? {} : { cpuTime }), ...extra,
});
const SITE = 'https://ayaka-room.example.workers.dev';
const rowOf = (summary, operation) => summary.rows.find((row) => row.operation === operation);

test('cpu_report：依操作分組、編號換成 :id、不帶網址參數；每一筆都有數值而且在上限以內才是通過', () => {
  const id = 'ab'.repeat(16), other = 'cd'.repeat(16);
  const stream = [
    tailEvent('GET', `${SITE}/`, 2, 'ok', { wallTime: 40 }), tailEvent('GET', `${SITE}/?lang=zh&secret=should-not-appear`, 4),
    tailEvent('POST', `${SITE}/login`, 3), tailEvent('POST', `${SITE}/login`, 7),
    tailEvent('GET', `${SITE}/photo/${id}/full`, 1), tailEvent('GET', `${SITE}/photo/${other}/full`, 2), tailEvent('GET', `${SITE}/photo/${id}/thumb`, 0),
  ];
  // wrangler tail --format json 印出來的是排版成多行的 JSON，中間可能夾著別的文字
  const text = 'Successfully created tail\n' + stream.map((e) => JSON.stringify(e, null, 2)).join('\n') + '\n{ not json }\n' + JSON.stringify(tailEvent('POST', `${SITE}/reply`, 5)) + '\n';
  const events = parseEvents(text);
  assert.equal(events.length, 8);
  assert.equal(operationOf(events[4]), 'GET /photo/:id/full');
  assert.equal(operationOf({ event: { cron: '* * * * *' } }), null, '不是 HTTP 請求的事件不算');
  assert.equal(operationOf({}), null);
  const ok = summarize(events);
  assert.equal(ok.verdict, 'pass');
  assert.deepEqual([ok.total, ok.measured, ok.missing], [8, 8, 0]);
  assert.deepEqual(ok.rows.map((row) => [row.operation, row.count, row.measured, row.missing, row.min, row.median, row.max, row.status]), [
    ['GET /', 2, 2, 0, 2, 2, 4, 'pass'], ['GET /photo/:id/full', 2, 2, 0, 1, 1, 2, 'pass'], ['GET /photo/:id/thumb', 1, 1, 0, 0, 0, 0, 'pass'],
    ['POST /login', 2, 2, 0, 3, 3, 7, 'pass'], ['POST /reply', 1, 1, 0, 5, 5, 5, 'pass'],
  ]);
  const report = formatReport(ok);
  assert.match(report, /✔ 收到的 8 筆請求都有 CPU 數值，而且都低於 10 ms/);
  assert.match(report, /GET \/\s+2／2\s+2／2／4\s+✔/, '每一項操作顯示「有效量測數／總請求數」');
  assert.ok(!report.includes('？') && !report.includes('✖'));
  for (const leak of ['should-not-appear', 'lang=zh', 'REDACTED', 'login_ok', id, other, 'example.workers.dev']) { assert.ok(!report.includes(leak), `報告裡不應該有 ${leak}`); }

  // 有一次請求用到 10 ms 以上、或被平台以超過 CPU 上限中止：沒通過
  const slow = summarize([...events, tailEvent('POST', 'https://ayaka-room-admin.example.workers.dev/photos', 11)]);
  assert.equal(slow.verdict, 'fail');
  assert.deepEqual([rowOf(slow, 'POST /photos').over, rowOf(slow, 'POST /photos').status], [true, 'fail']);
  assert.match(formatReport(slow), /POST \/photos\s+1／1\s+11／11／11\s+✖ 達到或超過上限/);
  assert.equal(summarize([tailEvent('POST', 'https://x.example/photos', 10)]).verdict, 'fail', '剛好等於上限也算');
  assert.equal(summarize([tailEvent('POST', 'https://x.example/photos', 9, 'exceededCpu')]).verdict, 'fail');
  assert.equal(summarize(events, { limitMs: 5 }).verdict, 'fail');
  assert.equal(summarize(events, { limitMs: 7.5 }).verdict, 'pass');
  // 沒有任何請求：無法判定
  assert.equal(summarize([]).verdict, 'unknown');
  assert.equal(summarize(parseEvents('no json here')).verdict, 'unknown');
  assert.equal(summarize([{ event: { cron: '* * * * *' }, cpuTime: 1 }]).verdict, 'unknown', '只有排程事件，沒有請求');
  assert.match(formatReport(summarize([])), /？ 無法判定：沒有收到任何請求的紀錄/);
});

test('cpu_report：只要有一筆請求缺少有效的 CPU 數值，整體就是「無法判定」，不是通過（Codex 複核的案例）', () => {
  // 案例：GET / 有 cpuTime = 1，POST /photos 缺少 cpuTime —— 以前回 pass
  const reported = summarize([tailEvent('GET', 'https://x.example/', 1), tailEvent('POST', 'https://x.example/photos', undefined)]);
  assert.equal(reported.verdict, 'unknown');
  assert.deepEqual([reported.total, reported.measured, reported.missing], [2, 1, 1]);
  assert.deepEqual([rowOf(reported, 'GET /').status, rowOf(reported, 'POST /photos').status], ['pass', 'unknown']);

  // 同一操作部分缺值：三筆 GET /，其中一筆沒有數值
  const partial = summarize([tailEvent('GET', `${SITE}/`, 1), tailEvent('GET', `${SITE}/`, undefined), tailEvent('GET', `${SITE}/`, 3), tailEvent('POST', `${SITE}/login`, 4)]);
  assert.equal(partial.verdict, 'unknown');
  assert.deepEqual([rowOf(partial, 'GET /').count, rowOf(partial, 'GET /').measured, rowOf(partial, 'GET /').missing, rowOf(partial, 'GET /').status], [3, 2, 1, 'unknown']);
  assert.deepEqual([rowOf(partial, 'GET /').min, rowOf(partial, 'GET /').median, rowOf(partial, 'GET /').max], [1, 1, 3], '統計只用有數值的那幾筆');
  assert.equal(rowOf(partial, 'POST /login').status, 'pass');
  const partialReport = formatReport(partial);
  assert.match(partialReport, /GET \/\s+2／3\s+1／1／3\s+？ 無法判定　1 筆沒有有效的 CPU 數值/);
  assert.match(partialReport, /POST \/login\s+1／1\s+4／4／4\s+✔/);
  assert.match(partialReport, /？ 無法判定：收到 4 筆請求，其中 1 筆沒有有效的 CPU 數值.*：GET \/（2／3）。/);
  assert.match(partialReport, /有數值的 3 筆都低於 10 ms，但缺的那幾筆可能超過，不能當作通過/);
  assert.ok(!partialReport.includes('✔ 收到的'), '整體不可以說通過');

  // 另一主要操作整組缺值：開頁面、看照片都有數值，上傳照片的兩筆都沒有
  const id = 'ef'.repeat(16);
  const wholeGroup = summarize([
    tailEvent('GET', `${SITE}/`, 1), tailEvent('GET', `${SITE}/`, 2), tailEvent('GET', `${SITE}/photo/${id}/full`, 2),
    tailEvent('POST', 'https://ayaka-room-admin.example.workers.dev/photos', undefined), tailEvent('POST', 'https://ayaka-room-admin.example.workers.dev/photos', undefined),
  ]);
  assert.equal(wholeGroup.verdict, 'unknown');
  assert.deepEqual([rowOf(wholeGroup, 'POST /photos').count, rowOf(wholeGroup, 'POST /photos').measured, rowOf(wholeGroup, 'POST /photos').max, rowOf(wholeGroup, 'POST /photos').status], [2, 0, null, 'unknown']);
  assert.deepEqual(wholeGroup.rows.filter((row) => row.status === 'pass').map((row) => row.operation), ['GET /', 'GET /photo/:id/full']);
  const wholeReport = formatReport(wholeGroup);
  assert.match(wholeReport, /POST \/photos\s+0／2\s+—／—／—\s+？ 無法判定　2 筆都沒有有效的 CPU 數值/);
  assert.match(wholeReport, /其中 2 筆沒有有效的 CPU 數值.*：POST \/photos（0／2）。/);

  // 全部都沒有數值
  const blind = summarize([tailEvent('GET', 'https://x.example/', undefined), tailEvent('POST', 'https://x.example/login', undefined)]);
  assert.equal(blind.verdict, 'unknown');
  assert.match(formatReport(blind), /？ 無法判定：收到 2 筆請求，其中 2 筆沒有有效的 CPU 數值/);
  assert.match(formatReport(blind), /沒有任何一筆可以判斷/);

  // 明確超限或 exceededCpu 優先：有缺值時仍然是沒通過，而且報告同時指出缺的是哪些
  const overAndMissing = summarize([tailEvent('GET', `${SITE}/`, 12), tailEvent('POST', `${SITE}/photos`, undefined), tailEvent('POST', `${SITE}/login`, 3)]);
  assert.equal(overAndMissing.verdict, 'fail');
  assert.deepEqual(overAndMissing.rows.map((row) => [row.operation, row.status]), [['GET /', 'fail'], ['POST /login', 'pass'], ['POST /photos', 'unknown']]);
  assert.match(formatReport(overAndMissing), /✖ 有操作的 CPU 時間達到或超過 10 ms[\s\S]*另外有 1 筆請求沒有有效的 CPU 數值：POST \/photos（0／1）。/);
  const killed = summarize([tailEvent('GET', `${SITE}/`, 1), tailEvent('POST', `${SITE}/photos`, undefined, 'exceededCpu')]);
  assert.equal(killed.verdict, 'fail', '被平台以超過 CPU 上限中止的那一筆就算沒有數值，也是沒通過');
  assert.equal(rowOf(killed, 'POST /photos').status, 'fail');
  assert.match(formatReport(killed), /POST \/photos\s+0／1\s+—／—／—\s+✖ 被平台以「超過 CPU 上限」中止/);
  // 被平台中止的事件就算認不出是哪個請求（沒有 request），也不可以因此不算
  for (const stray of [{ outcome: 'exceededCpu', event: null }, { outcome: 'exceededCpu' }, { outcome: 'exceededCpu', event: { cron: '* * * * *' } }]) {
    const summary = summarize([tailEvent('GET', `${SITE}/`, 1), stray]);
    assert.equal(summary.verdict, 'fail', JSON.stringify(stray));
    assert.equal(rowOf(summary, OTHER_EVENT).status, 'fail');
  }
  assert.equal(summarize([tailEvent('GET', `${SITE}/`, 1), { outcome: 'ok', event: { cron: '* * * * *' } }]).verdict, 'pass', '其他不是請求的事件照舊不列入');
  const sameRow = summarize([tailEvent('POST', `${SITE}/photos`, 11), tailEvent('POST', `${SITE}/photos`, undefined)]);
  assert.deepEqual([sameRow.verdict, rowOf(sameRow, 'POST /photos').status, rowOf(sameRow, 'POST /photos').missing], ['fail', 'fail', 1]);
});

test('cpu_report：CPU 數值只接受有限、非負的數字；不拿 wallTime 代替；讀不出網址的請求照樣算一筆', () => {
  for (const good of [0, 1, 9.5, 123]) { assert.equal(validCpu(good), true, String(good)); }
  for (const bad of [undefined, null, '5', '', true, false, -1, -0.001, NaN, Infinity, -Infinity, [], {}, [5]]) { assert.equal(validCpu(bad), false, String(bad)); }
  // 每一種不合格的值都會讓那一筆變成「缺值」，整體無法判定
  for (const bad of [null, '5', true, -1, NaN, Infinity, { ms: 5 }, [5]]) {
    const summary = summarize([tailEvent('GET', `${SITE}/`, 1), tailEvent('GET', `${SITE}/`, bad)]);
    assert.deepEqual([summary.verdict, summary.measured, summary.missing], ['unknown', 1, 1], `cpuTime = ${JSON.stringify(bad)}`);
  }
  // JSON 裡寫得出來的「無限大」（1e999）也不算
  const huge = summarize(parseEvents(`{"outcome":"ok","event":{"request":{"method":"GET","url":"${SITE}/"}},"cpuTime":1e999}`));
  assert.deepEqual([huge.total, huge.measured, huge.verdict], [1, 0, 'unknown']);
  // 只有 wallTime、沒有 cpuTime：不會被當成 CPU 時間（就算 wallTime 很小）
  const wallOnly = summarize([tailEvent('GET', `${SITE}/`, undefined, 'ok', { wallTime: 3 }), tailEvent('POST', `${SITE}/reply`, undefined, 'ok', { wallTime: 250 })]);
  assert.equal(wallOnly.verdict, 'unknown');
  assert.deepEqual(wallOnly.rows.map((row) => [row.measured, row.min, row.median, row.max]), [[0, null, null, null], [0, null, null, null]]);
  assert.ok(!('wallMax' in wallOnly.rows[0]));
  // wallTime 很大但 cpuTime 在上限以內：通過（比的是 CPU，不是經過的時間）
  assert.equal(summarize([tailEvent('GET', `${SITE}/`, 2, 'ok', { wallTime: 900 })]).verdict, 'pass');
  const code = noComments(source('scripts/cpu_report.mjs'));
  assert.ok(!code.includes('wallTime'), '程式裡完全沒有讀 wallTime');

  // 是請求、但網址讀不出來：不會被默默略過。它沒有數值的話，一樣讓整體無法判定
  const noUrl = { outcome: 'ok', event: { request: { method: 'post' } } };
  assert.equal(operationOf(noUrl), `POST ${UNREADABLE_URL}`);
  assert.equal(operationOf({ event: { request: { method: 'GET', url: 'not a url' } } }), `GET ${UNREADABLE_URL}`);
  const withStray = summarize([tailEvent('GET', `${SITE}/`, 1), noUrl]);
  assert.deepEqual([withStray.verdict, withStray.total, withStray.missing], ['unknown', 2, 1]);
  assert.equal(summarize([tailEvent('GET', `${SITE}/`, 1), { ...noUrl, cpuTime: 2 }]).verdict, 'pass');
  assert.equal(summarize([tailEvent('GET', `${SITE}/`, 1), { ...noUrl, cpuTime: 20 }]).verdict, 'fail');
  // 方法欄位裡的怪東西不會被原樣印出來
  assert.equal(operationOf({ event: { request: { method: 'GET\n<script>', url: `${SITE}/` } } }), 'GETSCRIPT /');

  // 結束狀態欄位裡的怪東西不會被原樣印出來
  const oddOutcome = formatReport(summarize([{ ...tailEvent('GET', `${SITE}/`, 1), outcome: 'ok\n<b>INJECTED</b>' }, { ...tailEvent('GET', `${SITE}/`, 1), outcome: { a: 1 } }]));
  assert.ok(!oddOutcome.includes('INJECTED') && oddOutcome.includes('unknown×2'));

  // 結束狀態不是 ok 的請求：報告裡會提醒（數字只到中斷為止），判定仍然只看 CPU 數值
  const interrupted = summarize([tailEvent('GET', `${SITE}/`, 1), tailEvent('POST', `${SITE}/reply`, 2, 'exception'), tailEvent('GET', `${SITE}/photo/${'ab'.repeat(16)}/full`, 1, 'canceled')]);
  assert.equal(interrupted.verdict, 'pass');
  assert.match(formatReport(interrupted), /注意：有請求的結束狀態不是 ok（.*exception×1.*）/);
  assert.ok(!formatReport(summarize([tailEvent('GET', `${SITE}/`, 1)])).includes('注意'));
});

test('cpu_report --expect：驗收時要求每一種主要操作都至少有一筆有效的量測；還沒量到的不算通過', () => {
  const id = 'ab'.repeat(16);
  const visitorAll = [
    tailEvent('POST', `${SITE}/login`, 3), tailEvent('GET', `${SITE}/`, 2), tailEvent('GET', `${SITE}/photo/${id}/thumb`, 1),
    tailEvent('GET', `${SITE}/photo/${id}/full`, 1), tailEvent('POST', `${SITE}/reply`, 4),
  ];
  assert.deepEqual(MAIN_OPERATIONS.visitor, ['POST /login', 'GET /', 'GET /photo/:id/thumb', 'GET /photo/:id/full', 'POST /reply']);
  assert.deepEqual(MAIN_OPERATIONS.admin, ['GET /', 'POST /photos', 'POST /access/generate']);
  // ACCEPTANCE.md 的 B-4 表格裡列的操作，和這裡要求的是同一組
  const acceptance = source('ACCEPTANCE.md');
  for (const operation of [...MAIN_OPERATIONS.visitor, ...MAIN_OPERATIONS.admin]) { assert.ok(acceptance.includes(`\`${operation}\``), `ACCEPTANCE.md 的 B-4 要有 ${operation}`); }

  // 每一種都量到、都有數值、都在上限以內：通過
  const complete = summarize(visitorAll, { expect: MAIN_OPERATIONS.visitor });
  assert.deepEqual([complete.verdict, complete.uncovered], ['pass', []]);
  assert.match(formatReport(complete, 10, { expectLabel: '訪客端' }), /✔ 收到的 5 筆請求都有 CPU 數值，而且都低於 10 ms；訪客端的每一種主要操作都至少量到一筆/);
  // 多量到別的操作不影響
  assert.equal(summarize([...visitorAll, tailEvent('GET', `${SITE}/session`, 0)], { expect: MAIN_OPERATIONS.visitor }).verdict, 'pass');

  // 只量到開頁面：其他主要操作還沒量到 → 無法判定，表裡把沒量到的列出來
  const onlyHome = summarize([tailEvent('GET', `${SITE}/`, 1)], { expect: MAIN_OPERATIONS.visitor });
  assert.equal(onlyHome.verdict, 'unknown');
  assert.deepEqual(onlyHome.uncovered, ['GET /photo/:id/full', 'GET /photo/:id/thumb', 'POST /login', 'POST /reply']);
  assert.deepEqual([rowOf(onlyHome, 'POST /reply').count, rowOf(onlyHome, 'POST /reply').measured, rowOf(onlyHome, 'POST /reply').status], [0, 0, 'unknown']);
  const onlyHomeReport = formatReport(onlyHome, 10, { expectLabel: '訪客端' });
  assert.match(onlyHomeReport, /POST \/reply\s+0／0\s+—／—／—\s+？ 無法判定　還沒量到/);
  assert.match(onlyHomeReport, /？ 無法判定：量到的 1 筆都低於 10 ms，但一定要量的操作裡還有沒量到的：.*POST \/reply/);
  assert.ok(!onlyHomeReport.includes('✔ 收到的'));
  // 沒有指定 --expect 時，同樣的資料是通過，但報告會說明沒有核對涵蓋範圍
  const loose = summarize([tailEvent('GET', `${SITE}/`, 1)]);
  assert.equal(loose.verdict, 'pass');
  assert.match(formatReport(loose), /沒有核對是不是每一種主要操作都量過；驗收時請加 --expect visitor 或 --expect admin/);

  // 主要操作有請求、但整組沒有數值（Codex 複核的第二種案例，換成有 --expect 的情況）：無法判定
  const admin = 'https://ayaka-room-admin.example.workers.dev';
  const uploadBlind = summarize([tailEvent('GET', `${admin}/`, 2), tailEvent('POST', `${admin}/photos`, undefined), tailEvent('POST', `${admin}/access/generate`, 3)], { expect: MAIN_OPERATIONS.admin });
  assert.deepEqual([uploadBlind.verdict, uploadBlind.uncovered], ['unknown', ['POST /photos']]);
  // 超限優先：就算還有沒量到的，也是沒通過；報告同時列出沒量到的
  const overAndUncovered = summarize([tailEvent('GET', `${admin}/`, 2), tailEvent('POST', `${admin}/photos`, 14)], { expect: MAIN_OPERATIONS.admin });
  assert.equal(overAndUncovered.verdict, 'fail');
  assert.match(formatReport(overAndUncovered, 10, { expectLabel: '管理端' }), /✖ 有操作的 CPU 時間達到或超過 10 ms[\s\S]*還沒有有效量測的：POST \/access\/generate。/);
});

test('cpu_report：隨機組合的事件（有的缺數值、有的超限、有的被平台中止），判定都和「照規則逐筆算」的結果一致', () => {
  // 固定種子的亂數：每次執行產生同一批資料
  let seed = 20261115;
  const next = () => { seed = (seed + 0x6D2B79F5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const pick = (list) => list[Math.floor(next() * list.length)];
  const id = 'ab'.repeat(16);
  const urls = [`${SITE}/`, `${SITE}/login`, `${SITE}/reply`, `${SITE}/photo/${id}/thumb`, `${SITE}/photo/${id}/full`];
  const methods = { [`${SITE}/login`]: 'POST', [`${SITE}/reply`]: 'POST' };
  const cpuValues = [0, 1, 3, 9, 9.99, 10, 10.5, 25, undefined, undefined, null, -1, '5', NaN, Infinity, true];
  const outcomes = ['ok', 'ok', 'ok', 'ok', 'exception', 'canceled', 'exceededCpu'];
  const seen = { pass: 0, fail: 0, unknown: 0 };
  for (let round = 0; round < 3000; round++) {
    const limitMs = pick([10, 10, 5, 30]);
    const expect = pick([[], [], MAIN_OPERATIONS.visitor]);
    const events = [];
    for (let i = Math.floor(next() * 7); i > 0; i--) {
      if (next() < 0.08) { events.push({ outcome: pick(['ok', 'exceededCpu']), event: pick([null, { cron: '* * * * *' }]), cpuTime: pick(cpuValues) }); continue; }   // 不是 HTTP 請求的事件
      const url = pick(urls);
      // 偶爾產生一批「乾淨」的資料，不然幾乎抽不到通過的組合
      const clean = round % 3 === 0;
      events.push(tailEvent(methods[url] || 'GET', url, clean ? pick([0, 1, 3, 4]) : pick(cpuValues), clean ? 'ok' : pick(outcomes)));
    }
    // 照規則逐筆算
    const counted = events.filter((e) => operationOf(e) !== null || e.outcome === 'exceededCpu');
    const valid = (e) => typeof e.cpuTime === 'number' && Number.isFinite(e.cpuTime) && e.cpuTime >= 0;
    const over = counted.some((e) => e.outcome === 'exceededCpu' || (valid(e) && e.cpuTime >= limitMs));
    const missing = counted.filter((e) => !valid(e)).length;
    const uncovered = expect.filter((operation) => !counted.some((e) => operationOf(e) === operation && valid(e)));
    const expected = over ? 'fail' : (counted.length === 0 || missing > 0 || uncovered.length > 0 ? 'unknown' : 'pass');

    const summary = summarize(events, { limitMs, expect });
    const context = JSON.stringify({ round, limitMs, expect: expect.length, events: events.map((e) => [operationOf(e), e.cpuTime === undefined ? '缺' : String(e.cpuTime), e.outcome]) });
    assert.equal(summary.verdict, expected, context);
    assert.deepEqual([summary.total, summary.measured, summary.missing], [counted.length, counted.length - missing, missing], context);
    assert.deepEqual([...summary.uncovered].sort(), [...uncovered].sort(), context);
    // 每一列的「有效／總數」加起來要對得上；通過的那幾列一定沒有缺值、也沒有超限
    assert.equal(summary.rows.reduce((sum, row) => sum + row.count, 0), counted.length, context);
    for (const row of summary.rows) {
      assert.equal(row.measured + row.missing, row.count, context);
      if (row.status === 'pass') { assert.ok(row.missing === 0 && !row.over && row.measured > 0 && row.max < limitMs, context); }
    }
    const report = formatReport(summary, limitMs, { expectLabel: expect.length ? '訪客端' : '' });
    assert.equal(report.includes('✔ 收到的'), expected === 'pass', context);
    assert.equal(/^✖ 有操作的 CPU 時間/m.test(report), expected === 'fail', context);
    assert.equal(/^？ 無法判定/m.test(report), expected === 'unknown', context);
    seen[expected] += 1;
  }
  assert.ok(seen.pass >= 100 && seen.fail >= 300 && seen.unknown >= 300, JSON.stringify(seen));   // 三種結果都有測到
});

test('cpu_report：上限不是大於 0 的數字時不會開始統計（否則每一筆都會被算成沒超過）；命令列的結束代碼', () => {
  for (const good of [10, 0.5, 30000]) { assert.equal(validLimit(good), true); }
  for (const bad of [0, -1, NaN, Infinity, '10', null, undefined]) {
    assert.equal(validLimit(bad), false, String(bad));
    if (bad !== undefined) { assert.throws(() => summarize([tailEvent('GET', `${SITE}/`, 50)], { limitMs: bad }), RangeError, String(bad)); }
  }
  assert.equal(summarize([tailEvent('GET', `${SITE}/`, 50)]).verdict, 'fail', '沒有指定上限時用 10 ms');

  const dir = mkdtempSync(path.join(os.tmpdir(), 'cpu-report-'));
  try {
    const run = (events, args = []) => {
      const file = path.join(dir, `events-${Math.random().toString(16).slice(2)}.json`);
      writeFileSync(file, events.map((e) => JSON.stringify(e, null, 2)).join('\n'));
      const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'cpu_report.mjs'), file, ...args], { encoding: 'utf8' });
      return { code: result.status, out: result.stdout, err: result.stderr };
    };
    const good = [tailEvent('GET', `${SITE}/`, 1), tailEvent('POST', `${SITE}/photos`, 7)];
    assert.equal(run(good).code, 0);
    assert.match(run(good).out, /✔ 收到的 2 筆請求都有 CPU 數值/);
    assert.equal(run([...good, tailEvent('POST', `${SITE}/photos`, 12)]).code, 1);
    // Codex 複核的案例：一筆有數值、另一個操作沒有數值 → 結束代碼 2（無法判定），不是 0
    const missing = run([tailEvent('GET', `${SITE}/`, 1), tailEvent('POST', `${SITE}/photos`, undefined)]);
    assert.equal(missing.code, 2);
    assert.match(missing.out, /POST \/photos\s+0／1\s+—／—／—\s+？ 無法判定/);
    assert.equal(run([]).code, 2);
    assert.equal(run([tailEvent('GET', `${SITE}/`, 12), tailEvent('POST', `${SITE}/photos`, undefined)]).code, 1, '超限優先於缺值');
    assert.equal(run(good, ['--limit', '5']).code, 1);
    assert.equal(run(good, ['--limit', '8']).code, 0);
    // --expect：主要操作沒有全部量到 → 2；全部量到 → 0
    const id = 'ab'.repeat(16);
    const visitorAll = [tailEvent('POST', `${SITE}/login`, 3), tailEvent('GET', `${SITE}/`, 2), tailEvent('GET', `${SITE}/photo/${id}/thumb`, 1), tailEvent('GET', `${SITE}/photo/${id}/full`, 1), tailEvent('POST', `${SITE}/reply`, 4)];
    assert.equal(run(good, ['--expect', 'visitor']).code, 2, '只量到兩種操作');
    assert.match(run(good, ['--expect', 'visitor']).out, /還沒量到/);
    assert.equal(run(visitorAll, ['--expect', 'visitor']).code, 0);
    assert.equal(run(visitorAll, ['--expect', 'admin']).code, 2, '拿訪客端的紀錄去核對管理端的操作');
    assert.equal(run(visitorAll, ['--expect', 'visitor', '--limit', '4']).code, 1);
    for (const args of [['--limit', 'abc'], ['--limit'], ['--limit', '0'], ['--limit', '-3'], ['--limit', ''], ['--bogus'], ['--expect'], ['--expect', 'everything'], ['--expect', '__proto__']]) {
      const bad = run([tailEvent('GET', `${SITE}/`, 50)], args);
      assert.equal(bad.code, 64, args.join(' '));
      assert.match(bad.err, /用法/);
      assert.ok(!bad.out.includes('✔'), '參數不對時不會印出「通過」');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('產生的檔案是最新的（訪客端的 room.css、管理端包在程式裡的樣式與腳本）', () => {
  const out = execFileSync('python3', [path.join(ROOT, 'scripts', 'build_static.py'), '--check'], { encoding: 'utf-8' });
  assert.match(out, /up to date/);
});
