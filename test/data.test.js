// data.js 的資料檢查：node --test
// 確認每段文字都有日文與中文、照片（活動照片與視訊回憶）檔案存在且尺寸正確、日期格式正確、{佔位符} 沒有漏掉。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
global.window = {};
require(path.join(ROOT, 'data.js'));
const DATA = global.window.SITE_DATA;

/** 走訪整個資料物件，收集所有 { ja, zh } 文字物件 */
function collectPairs(value, p, out) {
  if (!value || typeof value !== 'object') { return out; }
  if (Object.prototype.hasOwnProperty.call(value, 'ja') || Object.prototype.hasOwnProperty.call(value, 'zh')) {
    out.push({ path: p, value });
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    collectPairs(v, p ? `${p}.${k}` : k, out);
  }
  return out;
}

const EMPTY_ALLOWED = [/^hero\.sloganNote$/, /^timeline\.\d+\.note$/, /^ui\.messageFrom$/];

test('每段文字都同時有日文（ja）與中文（zh）', () => {
  const pairs = collectPairs(DATA, '', []);
  assert.ok(pairs.length > 40, '文字數量異常：' + pairs.length);
  const missing = pairs.filter(({ value }) => typeof value.ja !== 'string' || typeof value.zh !== 'string');
  assert.deepEqual(missing.map((m) => m.path), []);
});

test('除了允許留白的欄位，文字不可以是空字串', () => {
  const pairs = collectPairs(DATA, '', []);
  const empty = pairs
    .filter(({ path: p }) => !EMPTY_ALLOWED.some((re) => re.test(p)))
    .filter(({ value }) => !value.ja.trim() || !value.zh.trim());
  assert.deepEqual(empty.map((m) => m.path), []);
});

test('介面文字的 {佔位符} 都在', () => {
  const need = {
    birthdayUntil: ['{age}'], birthdayTodayLead: ['{age}'],
    lightboxCounter: ['{current}', '{total}'], footerUpdated: ['{date}'], photoCaptionDate: ['{date}'],
  };
  for (const [key, tokens] of Object.entries(need)) {
    for (const lang of ['ja', 'zh']) {
      for (const token of tokens) {
        assert.ok(DATA.ui[key][lang].includes(token), `ui.${key}.${lang} 缺少 ${token}`);
      }
    }
  }
});

/** 讀 JPEG 的 SOF 標頭取得實際尺寸（不需要任何套件） */
function jpegSize(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.readUInt16BE(0), 0xffd8, `${file} 不是 JPEG`);
  let pos = 2;
  while (pos < buf.length) {
    assert.equal(buf[pos], 0xff, `${file} JPEG 標頭損壞`);
    const marker = buf[pos + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { pos += 2; continue; }
    const len = buf.readUInt16BE(pos + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(pos + 5), width: buf.readUInt16BE(pos + 7) };
    }
    pos += 2 + len;
  }
  assert.fail(`${file} 找不到 SOF 標頭`);
}

/** 所有相簿照片：主視覺、活動照片、視訊回憶（每張都附上所屬組別的共用日期） */
function allPhotos() {
  const call = DATA.callPhotos || { items: [] };
  return [
    { photo: DATA.hero.photo, group: 'hero' },
    ...DATA.photos.map((photo) => ({ photo, group: 'photos' })),
    ...call.items.map((photo) => ({ photo: { date: call.date, ...photo }, group: 'callPhotos' })),
  ];
}

test('相簿與主視覺的照片檔案都存在，且有 alt 與尺寸（尺寸和 JPEG 實際尺寸一致）', () => {
  for (const { photo, group } of allPhotos()) {
    const file = path.join(ROOT, photo.src);
    assert.ok(fs.existsSync(file), `找不到 ${photo.src}`);
    assert.ok(photo.alt_ja && photo.alt_zh, `${photo.src} 缺少 alt_ja / alt_zh`);
    assert.equal(typeof photo.width, 'number');
    assert.equal(typeof photo.height, 'number');
    assert.deepEqual(jpegSize(file), { width: photo.width, height: photo.height }, `${photo.src} 的尺寸和檔案不符`);
    assert.ok(Math.abs(photo.width / photo.height - 0.8) < 0.002, `${photo.src} 不是 4:5 直式`);
    if (group === 'callPhotos') {
      assert.match(photo.date || '', /^\d{4}-\d{2}(-\d{2})?$/, `視訊回憶的日期要是 YYYY-MM 或 YYYY-MM-DD（${photo.src}）`);
    } else {
      assert.match(photo.date || '', /^\d{4}-\d{2}-\d{2}$/);
    }
  }
  assert.equal(DATA.photos.length, 9);
  assert.equal(DATA.callPhotos.items.length, 9, '視訊回憶照片應有 9 張');
  assert.ok(DATA.callPhotos.items.every((p) => /^photos\/call-\d{2}\.jpg$/.test(p.src)), '視訊回憶檔名應為 photos/call-NN.jpg');
});

test('photos/call-photos.json 與 data.js 的 callPhotos 一致（形狀相同：{ date, items }）', () => {
  const json = JSON.parse(fs.readFileSync(path.join(ROOT, 'photos', 'call-photos.json'), 'utf8'));
  assert.deepEqual(json, DATA.callPhotos, 'call-photos.json 和 data.js 的 callPhotos 不同（兩邊都要改）');
});

test('相簿第二組的介面文字都在', () => {
  for (const key of ['galleryCallTitle', 'galleryCallLead', 'callPhotoCaptionDate']) {
    assert.ok(DATA.ui[key] && DATA.ui[key].ja && DATA.ui[key].zh, `ui.${key} 缺少日文或中文`);
  }
  for (const lang of ['ja', 'zh']) {
    assert.ok(DATA.ui.callPhotoCaptionDate[lang].includes('{date}'), `ui.callPhotoCaptionDate.${lang} 缺少 {date}`);
    assert.ok(/ビデオ通話|視訊/.test(DATA.footer.photoNotice[lang]), `footer.photoNotice.${lang} 應提到視訊截圖`);
    assert.ok(DATA.about.paragraphs.some((p) => /ビデオ通話|視訊/.test(p[lang])), `about 應提到視訊截圖（${lang}）`);
    assert.ok(/ビデオ通話|視訊/.test(DATA.site.description[lang]), `site.description.${lang} 應提到視訊回憶（分享預覽與搜尋摘要）`);
  }
});

test('index.html 的 meta description 和 data.js 的日文 site.description 一致', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m = html.match(/<meta name="description" content="([^"]*)">/);
  assert.ok(m, 'index.html 找不到 meta description');
  assert.equal(m[1], DATA.site.description.ja);
});

test('site.webp 為 true 時，每張照片的 WebP 版本都存在（scripts/make_images.py）', { skip: !DATA.site.webp }, () => {
  const photos = allPhotos().map((x) => x.photo);
  for (const photo of photos) {
    const stem = photo.src.replace(/\.jpe?g$/i, '');
    for (const suffix of ['-480.webp', '-800.webp', '-full.webp']) {
      assert.ok(fs.existsSync(path.join(ROOT, stem + suffix)), `找不到 ${stem}${suffix}`);
    }
  }
});

test('年表日期格式為 YYYY、YYYY-MM、YYYY-MM-DD 或 null', () => {
  for (const item of DATA.timeline) {
    if (item.placeholder) { continue; }
    assert.ok(item.date === null || /^\d{4}(-\d{2}){0,2}$/.test(item.date), `日期格式錯誤：${item.date}`);
    assert.ok(item.title && item.title.ja && item.title.zh, '年表項目缺少標題');
  }
});

test('基本設定合理', () => {
  assert.ok(['ja', 'zh'].includes(DATA.site.defaultLang));
  assert.match(DATA.site.lastUpdated, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(Object.keys(DATA.site.birthday).sort(), ['day', 'month', 'year']);
  assert.ok(DATA.messages.length >= 3 && DATA.messages.length <= 5, '應援留言建議 3～5 則');
  assert.ok(DATA.profile.some((row) => row.showAge), '生日欄位要有 showAge');
});
