// letter-data.js（彩花への手紙）的資料檢查：node --test
// 確認信的每一段都有日文與中文、小節 id 不重複、連結是相對路徑、署名保留「YU HONG」。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
global.window = {};
require(path.join(ROOT, 'letter-data.js'));
require(path.join(ROOT, 'data.js'));
const LETTER = global.window.LETTER_DATA;
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

test('信的每段文字都同時有日文（ja）與中文（zh），而且不是空字串', () => {
  const pairs = collectPairs(LETTER, '', []);
  assert.ok(pairs.length > 20, '文字數量異常：' + pairs.length);
  const bad = pairs.filter(({ value }) => typeof value.ja !== 'string' || typeof value.zh !== 'string' || !value.ja.trim() || !value.zh.trim());
  assert.deepEqual(bad.map((m) => m.path), []);
});

test('每一節都有 id（不重複）、標題與至少一段文字', () => {
  const ids = LETTER.sections.map((s) => s.id);
  assert.ok(ids.length >= 3, '小節太少');
  assert.deepEqual(ids, [...new Set(ids)], '小節 id 重複');
  for (const section of LETTER.sections) {
    assert.match(section.id, /^[a-z0-9-]+$/, `id 只能用小寫英數與連字號：${section.id}`);
    assert.ok(section.heading && section.heading.ja && section.heading.zh, `${section.id} 缺少標題`);
    assert.ok(Array.isArray(section.paragraphs) && section.paragraphs.length > 0, `${section.id} 沒有段落`);
    if (section.words) {
      const okWord = (w) => (typeof w === 'string' && w.trim()) || (Array.isArray(w) && w.length > 0 && w.every((c) => typeof c === 'string' && c.trim()));
      assert.ok(Array.isArray(section.words) && section.words.every(okWord), `${section.id} 的 words 每一句要是非空字串，或非空字串的陣列`);
      assert.ok(Array.isArray(section.paragraphsAfter) && section.paragraphsAfter.length > 0, `${section.id} 有 words 時，後面要有說明段落`);
    }
    if (section.link) {
      assert.match(section.link.href, /^(index\.html|letter\.html)(#[a-z0-9-]+)?$/, `${section.id} 的連結要是站內相對路徑：${section.link.href}`);
      assert.ok(section.link.label && section.link.label.ja && section.link.label.zh, `${section.id} 的連結缺少文字`);
    }
  }
});

test('信連回首頁的錨點都存在於 index.html', () => {
  const html = require('node:fs').readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  for (const section of LETTER.sections) {
    if (!section.link) { continue; }
    const hash = (section.link.href.split('#')[1] || '');
    if (hash) { assert.ok(html.includes(`id="${hash}"`), `index.html 沒有 id="${hash}"`); }
  }
});

test('署名保留「YU HONG」，兩種語言都有', () => {
  assert.ok(LETTER.signature.ja.includes('YU HONG'));
  assert.ok(LETTER.signature.zh.includes('YU HONG'));
});

test('首頁入口小卡的文字（data.js 的 ui.letterEntryTitle / Text / Cta）都在', () => {
  // 「Letter」這個英文小標已拿掉（和標題意思重複；網站主人 2026-11-11 交由設計決定），所以不再要求 letterEntryEyebrow
  for (const key of ['letterEntryTitle', 'letterEntryText', 'letterEntryCta']) {
    assert.ok(DATA.ui[key] && DATA.ui[key].ja.trim() && DATA.ui[key].zh.trim(), `ui.${key} 缺少文字`);
  }
  assert.equal(DATA.ui.letterEntryTitle.ja, LETTER.heading.ja, '入口小卡的標題要和信頁的標題一樣');
  assert.equal(DATA.ui.letterEntryTitle.zh, LETTER.heading.zh, '入口小卡的標題要和信頁的標題一樣');
});

test('日文裡英文和日文之間不加半形空白（和 data.js 一致；署名「YU HONG より」除外）', () => {
  const bad = collectPairs(LETTER, '', [])
    .filter(({ path: p }) => p !== 'signature')
    .filter(({ value }) => /[A-Za-z] [぀-ヿ一-鿿]|[぀-ヿ一-鿿] [A-Za-z]/.test(value.ja))
    .map(({ path: p }) => p);
  assert.deepEqual(bad, []);
});

test('信裡的稱呼統一是「彩花ちゃん」（日文），中文用「彩花」與「妳」', () => {
  const pairs = collectPairs(LETTER, '', []).filter(({ path: p }) => !/^(title|description)$/.test(p));
  const ja = pairs.map(({ value }) => value.ja).join('\n').replace(/彩花ちゃん/g, '');
  assert.ok(!/彩花/.test(ja), '日文裡出現了沒有「ちゃん」的「彩花」');
  const zh = pairs.map(({ value }) => value.zh).join('\n');
  assert.ok(!/彩花ちゃん|彩花醬/.test(zh), '中文版不用「彩花ちゃん」');
});

test('信裡不出現「一生守る」這句容易被讀成承諾的話', () => {
  const text = collectPairs(LETTER, '', []).map(({ value }) => value.ja + value.zh).join('\n');
  assert.ok(!text.includes('一生守'), '信裡不應出現「一生守る」');
});

test('每段文字的日文和中文行數一樣（\\n 是段落裡的換行，兩種語言要對得上）', () => {
  const bad = collectPairs(LETTER, '', [])
    .filter(({ value }) => String(value.ja).split('\n').length !== String(value.zh).split('\n').length)
    .map(({ path: p }) => p);
  assert.deepEqual(bad, []);
});

test('換行前後沒有多餘的空白，也沒有連續兩個換行（要分段就拆成兩段）', () => {
  const bad = collectPairs(LETTER, '', [])
    .filter(({ value }) => [value.ja, value.zh].some((s) => /[ \t]\n|\n[ \t]|\n\n|^\n|\n$/.test(String(s))))
    .map(({ path: p }) => p);
  assert.deepEqual(bad, []);
});

test('視訊那天準備過的三句話，畫面上的字和原文一模一樣（拆成小塊只影響換行位置）', () => {
  const section = LETTER.sections.find((x) => x.id === 'video-call');
  const shown = section.words.map((w) => (Array.isArray(w) ? w.join('') : w));
  assert.deepEqual(shown, [
    'あやかがうれしいと、ぼくもうれしいよ。',
    'いま、じんせいでいちばんだいすきなのはアヤカ！',
    'ふゆのツアーいくね！またあおうね！'
  ]);
});
