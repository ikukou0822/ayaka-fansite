// 分享按鈕的純邏輯測試：node --test
// 決定分享網址（canonical 優先、否則去掉 query／hash）、分享方式的選擇、AbortError 判斷。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveShareUrl, stripQueryAndHash, toHttpUrl, shareMethod, canCopy, isAbortError, buildShareData } = require('../share.js');

const CANON = 'https://dc9408222000-hub.github.io/ayaka-fansite/';
const LOCAL = 'http://127.0.0.1:8000/?utm=1#gallery';

test('有 canonical 時一律用 canonical 的絕對網址', () => {
  assert.equal(resolveShareUrl(CANON, LOCAL), CANON);
  assert.equal(resolveShareUrl('  ' + CANON + '  ', LOCAL), CANON, '前後空白會去掉');
});

test('相對的 canonical 會以目前網址解析成絕對網址', () => {
  assert.equal(resolveShareUrl('/ayaka-fansite/', 'https://example.com/x/y?q=1#h'), 'https://example.com/ayaka-fansite/');
  assert.equal(resolveShareUrl('./', 'https://example.com/ayaka-fansite/index.html'), 'https://example.com/ayaka-fansite/');
});

test('沒有 canonical 時用目前網址去掉 query 和 hash', () => {
  assert.equal(resolveShareUrl(null, LOCAL), 'http://127.0.0.1:8000/');
  assert.equal(resolveShareUrl('', 'https://example.com/ayaka-fansite/?a=1&b=2'), 'https://example.com/ayaka-fansite/');
  assert.equal(resolveShareUrl(undefined, 'https://example.com/ayaka-fansite/#birthday-preview'), 'https://example.com/ayaka-fansite/');
  assert.equal(resolveShareUrl(null, 'https://example.com/ayaka-fansite/'), 'https://example.com/ayaka-fansite/', '本來就乾淨的網址不變');
});

test('canonical 不是 http(s) 時會被忽略', () => {
  assert.equal(resolveShareUrl('javascript:alert(1)', LOCAL), 'http://127.0.0.1:8000/');
  assert.equal(resolveShareUrl('data:text/html,hi', LOCAL), 'http://127.0.0.1:8000/');
  assert.equal(resolveShareUrl('mailto:a@b.c', LOCAL), 'http://127.0.0.1:8000/');
  assert.equal(toHttpUrl('ftp://example.com/'), null);
  assert.equal(toHttpUrl(123), null);
});

test('stripQueryAndHash 對壞掉的字串也不會丟例外', () => {
  assert.equal(stripQueryAndHash('not a url?x=1#y'), 'not a url');
  assert.equal(stripQueryAndHash(null), '');
});

test('分享方式：navigator.share → 剪貼簿 → 手動複製', () => {
  const share = () => Promise.resolve();
  const writeText = () => Promise.resolve();
  assert.equal(shareMethod({ share, clipboard: { writeText } }), 'share');
  assert.equal(shareMethod({ clipboard: { writeText } }), 'clipboard');
  assert.equal(shareMethod({ clipboard: {} }), 'manual');
  assert.equal(shareMethod({}), 'manual');
  assert.equal(shareMethod(null), 'manual');
  assert.equal(shareMethod({ share: 'not a function' }), 'manual');
  assert.equal(canCopy({ clipboard: { writeText } }), true);
  assert.equal(canCopy(undefined), false);
});

test('只有 AbortError（使用者取消）不算錯誤', () => {
  assert.equal(isAbortError({ name: 'AbortError' }), true);
  assert.equal(isAbortError({ name: 'X', code: 20 }), true);
  assert.equal(isAbortError({ name: 'NotAllowedError' }), false);
  assert.equal(isAbortError(new TypeError('bad data')), false);
  assert.equal(isAbortError(null), false);
  assert.equal(isAbortError(undefined), false);
});

test('分享資料只放有內容的欄位', () => {
  assert.deepEqual(buildShareData('標題', '說明', CANON), { title: '標題', text: '說明', url: CANON });
  assert.deepEqual(buildShareData('標題', '', CANON), { title: '標題', url: CANON });
  assert.deepEqual(buildShareData('  ', null, CANON), { url: CANON });
});

test('data.js 有分享按鈕用的日文與中文', () => {
  global.window = {};
  require('../data.js');
  const ui = global.window.SITE_DATA.ui;
  for (const key of ['shareLead', 'shareButton', 'shareText', 'shareCopied', 'shareCopyManual']) {
    assert.equal(typeof ui[key].ja, 'string', `ui.${key}.ja`);
    assert.equal(typeof ui[key].zh, 'string', `ui.${key}.zh`);
    assert.ok(ui[key].ja.trim() && ui[key].zh.trim(), `ui.${key} 不可留白`);
  }
  assert.ok(ui.shareText.ja.length <= 80 && ui.shareText.zh.length <= 80, '分享的說明要短');
});
