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
    lightboxCounter: ['{current}', '{total}'], lightboxAnnounce: ['{current}', '{total}', '{caption}'],
    footerUpdated: ['{date}'], photoCaptionDate: ['{date}'],
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
    for (const suffix of ['-480.webp', '-800.webp', '-1024.webp', '-full.webp']) {
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
  // 留言可以是空的：範例文字拿掉之後，留言區只放「給彩花的信」的入口小卡（之後要放自己的短句，最多 5 則）
  assert.ok(Array.isArray(DATA.messages) && DATA.messages.length <= 5, '應援留言最多 5 則（可以是空的）');
  for (const msg of DATA.messages) {
    assert.ok(msg && typeof msg.ja === 'string' && msg.ja.trim() && typeof msg.zh === 'string' && msg.zh.trim(), '每則留言都要有日文與中文');
  }
  assert.ok(DATA.profile.some((row) => row.showAge), '生日欄位要有 showAge');
});

/* ---------- 出處、個人資料、作品、訪談、年表（2026-11-14 內容補充） ---------- */

const DATE_RE = /^\d{4}(-\d{2}){0,2}$/;

/** 每一筆公開資料用到的出處代號：[{ where, id }] */
function sourceRefs() {
  const refs = [];
  const add = (where, ids) => (ids || []).forEach((id) => refs.push({ where, id }));
  DATA.profile.forEach((row) => add(`profile「${row.label.ja}」`, row.sources));
  add('hobbies', DATA.hobbies.sources);
  DATA.timeline.forEach((item) => add(`timeline ${item.date}`, item.sources));
  DATA.works.forEach((work) => { add(`works.${work.id}`, work.sources); add(`works.${work.id}.official`, [work.official]); });
  DATA.interviews.forEach((item) => add(`interviews「${item.title.ja}」`, item.sources));
  DATA.links.forEach((link) => add(`links ${link.url}`, link.sources));
  return refs;
}

test('出處清單：每一筆都有名稱、https 網址、刊登日期（或 null）與查證日期', () => {
  const entries = Object.entries(DATA.sources);
  assert.ok(entries.length >= 20, '出處數量異常：' + entries.length);
  for (const [id, src] of entries) {
    assert.match(id, /^[a-z0-9-]+$/, `出處代號只能用小寫英數與連字號：${id}`);
    const name = typeof src.name === 'string' ? { ja: src.name, zh: src.name } : src.name;
    assert.ok(name && name.ja && name.zh, `${id} 缺少名稱`);
    assert.match(src.url, /^https:\/\/[^\s]+$/, `${id} 的網址要是 https://`);
    assert.ok(src.published === null || DATE_RE.test(src.published), `${id} 的 published 要是 YYYY、YYYY-MM、YYYY-MM-DD 或 null`);
    assert.match(src.checked, /^\d{4}-\d{2}-\d{2}$/, `${id} 的 checked 要是 YYYY-MM-DD`);
    if (src.published && src.published.length === 10) { assert.ok(src.published <= src.checked, `${id} 的刊登日期晚於查證日期`); }
  }
});

test('每個出處代號都找得到，清單裡也沒有用不到的出處', () => {
  const refs = sourceRefs();
  assert.deepEqual(refs.filter((r) => !DATA.sources[r.id]).map((r) => `${r.where} → ${r.id}`), []);
  const used = new Set(refs.map((r) => r.id));
  assert.deepEqual(Object.keys(DATA.sources).filter((id) => !used.has(id)), []);
});

test('個人資料：有內容的每一列都有出處；還沒確認的欄位保持 null（不顯示），沒有暱稱欄', () => {
  for (const row of DATA.profile) {
    assert.ok(row.label && row.label.ja && row.label.zh, '個人資料缺少欄位名稱');
    if (row.value === null) { continue; }
    assert.ok(row.value.ja && row.value.zh, `「${row.label.ja}」缺少內容`);
    assert.ok(Array.isArray(row.sources) && row.sources.length, `「${row.label.ja}」沒有出處`);
  }
  const byLabel = (ja) => DATA.profile.find((row) => row.label.ja === ja);
  assert.equal(byLabel('身長').value, null, '身高還沒有可靠來源，要保持 null');
  assert.equal(byLabel('ニックネーム'), undefined, '暱稱欄已改成「自己紹介フレーズ」');
  assert.equal(byLabel('血液型').value.ja, 'A型');
  assert.equal(byLabel('出身地').value.ja, '東京都');
  assert.equal(byLabel('自己紹介フレーズ').value.ja, 'NiziUのふわふわビューティー');
  assert.match(byLabel('デビュー').value.ja, /2020年12月2日/);
  assert.match(byLabel('デビュー').value.zh, /2020 年 12 月 2 日/);
  assert.match(byLabel('NIZOOキャラクター').value.ja, /ANO（アノ）.*ナマケモノ/);
});

test('興趣：每一項都有名稱與說明，整塊有出處，說明裡標明年月、不用「最近」', () => {
  assert.ok(DATA.hobbies.items.length >= 1 && DATA.hobbies.sources.length >= 1);
  for (const item of DATA.hobbies.items) {
    assert.ok(item.label.ja && item.label.zh && item.text.ja && item.text.zh);
    assert.doesNotMatch(item.text.ja + item.text.zh, /最近/, '興趣的說明不要用「最近」（要交代年月）');
  }
  assert.match(DATA.ui.hobbiesLead.ja, /\d{4}年\d{1,2}月/);
  assert.match(DATA.ui.hobbiesLead.zh, /\d{4} 年 \d{1,2} 月/);
});

test('作品：代號不重複、有官方作品頁與出處；作詞寫「參與／共同」，不寫作曲', () => {
  const ids = DATA.works.map((work) => work.id);
  assert.equal(new Set(ids).size, ids.length, '作品代號重複');
  for (const work of DATA.works) {
    assert.match(work.id, /^[a-z0-9-]+$/);
    assert.ok(work.title && work.members.ja && work.members.zh && work.release.ja && work.release.zh && work.text.ja && work.text.zh, `${work.id} 資料不完整`);
    assert.ok(DATA.sources[work.official], `${work.id} 缺少官方作品頁`);
    assert.ok(work.sources.length >= 1, `${work.id} 缺少訪談出處`);
    assert.match(work.text.ja, /作詞に参加/, `${work.id}：日文請寫「作詞に参加」`);
    assert.match(work.text.zh, /參與演唱與作詞|共同作詞/, `${work.id}：中文請寫「參與作詞／共同作詞」`);
    assert.doesNotMatch(work.text.ja + work.text.zh, /作曲/, `${work.id}：不要寫成作曲`);
  }
  // 中文的成員名：真子、彩花、梨久、未光
  assert.doesNotMatch(JSON.stringify(DATA.works.map((w) => [w.members.zh, w.text.zh])), /MIIHI|MAKO|RIKU/, '中文請用「真子、梨久、未光」');
});

test('訪談摘錄：每一則都有標題、摘要與出處（有刊登日期）', () => {
  assert.ok(DATA.interviews.length >= 1);
  for (const item of DATA.interviews) {
    assert.ok(item.title.ja && item.title.zh && item.text.ja && item.text.zh);
    assert.ok(item.sources.length >= 1 && item.sources.every((id) => DATA.sources[id] && DATA.sources[id].published), `「${item.title.ja}」的出處要有刊登日期`);
  }
});

test('年表：日期由早到晚、同一天不重複；每一筆都有出處（網站主人自己的經歷標 own）', () => {
  const items = DATA.timeline.filter((item) => !item.placeholder);
  const dates = items.map((item) => item.date);
  assert.deepEqual(dates, [...dates].sort(), '年表沒有照日期排列');
  assert.equal(new Set(dates).size, dates.length, '年表有重複的日期');
  assert.ok(items.length >= 18, '年表筆數變少了：' + items.length);
  for (const item of items) {
    if (item.own) { assert.equal(item.sources, undefined, `${item.date}：自己的經歷不用寫出處`); continue; }
    assert.ok(Array.isArray(item.sources) && item.sources.length, `${item.date} 沒有出處`);
    if (item.link) { assert.ok(DATA.works.some((work) => work.id === item.link), `${item.date} 的 link 找不到作品：${item.link}`); }
  }
  for (const date of ['2020-06-26', '2020-06-30', '2020-12-02', '2023-10-30']) { assert.ok(dates.includes(date), `年表缺少 ${date}`); }
  // 寫到「作詞」的項目：官方作品頁只說明收錄在哪一張專輯，談到作詞的那一篇訪談或節目也要列為出處（和作品區用同一個出處）
  for (const item of items.filter((entry) => entry.link)) {
    const work = DATA.works.find((entry) => entry.id === item.link);
    assert.match(item.note.ja, /作詞/, `${item.date} 連到作品，文字要提到作詞`);
    for (const id of work.sources) { assert.ok(item.sources.includes(id), `${item.date}（${work.title}）的出處要包含 ${id}`); }
    assert.ok(item.sources.includes(work.official), `${item.date}（${work.title}）的出處要包含官方作品頁`);
  }
  const lyricSources = Object.fromEntries(items.filter((entry) => entry.link).map((entry) => [entry.link, entry.sources]));
  assert.ok(lyricSources['love-yourself'].includes('thefirsttimes-2023-08-01'));
  assert.ok(lyricSources['fairy-magic'].includes('tfm-2025-12-11'));
});

test('官方連結：都是 https 網址，文字有日文與中文', () => {
  assert.ok(DATA.links.length >= 2);
  for (const link of DATA.links) {
    assert.match(link.url, /^https:\/\//);
    assert.ok(link.label.ja && link.label.zh);
  }
});

test('網站網址：data.js、canonical、Open Graph、Twitter Card 都是目前的網址，沒有舊帳號的網址', () => {
  const url = DATA.site.url;
  assert.equal(url, 'https://ikukou0822.github.io/ayaka-fansite/');
  const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const letter = fs.readFileSync(path.join(ROOT, 'letter.html'), 'utf8');
  const attr = (html, re) => { const m = html.match(re); assert.ok(m, '找不到 ' + re); return m[1]; };
  assert.equal(attr(index, /<link rel="canonical" href="([^"]*)">/), url);
  assert.equal(attr(index, /<meta property="og:url" content="([^"]*)">/), url);
  assert.equal(attr(index, /<meta property="og:image" content="([^"]*)">/), url + 'photos/og.jpg');
  assert.equal(attr(index, /<meta name="twitter:image" content="([^"]*)">/), url + 'photos/og.jpg');
  assert.equal(attr(letter, /<link rel="canonical" href="([^"]*)">/), url + 'letter.html');
  assert.equal(attr(letter, /<meta property="og:url" content="([^"]*)">/), url + 'letter.html');
  assert.equal(attr(letter, /<meta property="og:image" content="([^"]*)">/), url + 'photos/og.jpg');
  assert.ok(fs.existsSync(path.join(ROOT, 'photos', 'og.jpg')), '找不到分享預覽圖 photos/og.jpg');
  for (const file of ['index.html', 'letter.html', '404.html', 'data.js', 'letter-data.js', 'app.js', 'letter.js', 'share.js', 'manifest.webmanifest']) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(!text.includes('dc9408222000'), `${file} 還有舊帳號的網址`);
  }
});

test('合言葉のページ的入口：網址還沒填時不顯示；填了一定是 https；首頁只放連結，不放任何私人內容', () => {
  const url = DATA.site.roomUrl;
  assert.ok(url === null || /^https:\/\/[a-z0-9.-]+\/?$/.test(url), 'site.roomUrl 只能是 null 或 https 網址（不含路徑與參數）');
  assert.equal(typeof DATA.ui.roomEntry.ja, 'string');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /<p class="room-entry" id="room-entry" hidden><a rel="nofollow" data-ui="roomEntry"><\/a><\/p>/, '入口預設隱藏，連結由 app.js 依 site.roomUrl 填上');
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.match(app, /parsed\.protocol === 'https:'/, 'app.js 只接受 https 網址');
  // 公開網站的檔案裡不可以有私密區的內容或金鑰：那些只存在部署平台（見 backend/README.md）
  for (const file of ['index.html', 'app.js', 'data.js', 'letter.html', 'letter-data.js', 'styles.css']) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const banned of ['PEPPER', 'SESSION_SECRET', 'visitor_password', 'cf-access-jwt']) {
      assert.ok(!text.includes(banned), `${file} 不應該出現 ${banned}`);
    }
  }
});

test('backend/（私密區的程式）裡沒有金鑰檔、資料庫檔或照片以外的圖片', () => {
  const dir = path.join(ROOT, 'backend');
  if (!fs.existsSync(dir)) { return; }
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', '.wrangler', '.local'].includes(entry.name)) { return []; }
    const full = path.join(d, entry.name);
    return entry.isDirectory() ? walk(full) : [path.relative(dir, full)];
  });
  const files = walk(dir);
  const bad = files.filter((f) => /(^|\/)\.dev\.vars|(^|\/)\.env|\.sqlite|\.db$|\.pem$|\.key$/.test(f));
  assert.deepEqual(bad, []);
  const images = files.filter((f) => /\.(jpe?g|png|webp|heic)$/i.test(f));
  assert.ok(images.every((f) => f.startsWith('tests/fixtures/')), '圖片只能是 tests/fixtures/ 裡的合成範例圖：' + images.join(', '));
});
