/* =====================================================================
   share.js — 「このサイトをシェア／分享這個網站」按鈕的純邏輯。
   瀏覽器裡會掛在 window.AyakaShare；在 Node 裡可以 require() 來測試。
   不碰 DOM、不呼叫 navigator：決定「要分享哪個網址」「用哪種方式分享」，
   實際呼叫 navigator.share／clipboard 的程式在 app.js。
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AyakaShare = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 只接受 http(s) 的絕對網址；相對網址會以 base 解析。其他（javascript:、空字串、壞掉的）回傳 null。 */
  function toHttpUrl(href, base) {
    if (typeof href !== 'string' || !href.trim()) { return null; }
    try {
      var u = base ? new URL(href.trim(), base) : new URL(href.trim());
      if (u.protocol !== 'http:' && u.protocol !== 'https:') { return null; }
      return u.href;
    } catch (e) { return null; }
  }

  /** 去掉 query 與 hash：https://example.com/a/?x=1#top → https://example.com/a/ */
  function stripQueryAndHash(href) {
    if (typeof href !== 'string') { return ''; }
    try {
      var u = new URL(href);
      u.search = '';
      u.hash = '';
      return u.href;
    } catch (e) {
      return href.split('#')[0].split('?')[0];
    }
  }

  /**
   * 決定要分享的網址：優先用 <link rel="canonical"> 的絕對網址；
   * 沒有（或不是 http/https）時，用目前網址去掉 query 和 hash。
   * @param {string|null} canonicalHref  canonical 的 href（可為相對路徑，會以 currentHref 解析）
   * @param {string} currentHref         window.location.href
   */
  function resolveShareUrl(canonicalHref, currentHref) {
    var canonical = toHttpUrl(canonicalHref, typeof currentHref === 'string' ? currentHref : undefined);
    if (canonical) { return canonical; }
    return stripQueryAndHash(currentHref);
  }

  /**
   * 用哪種方式分享：'share'（系統分享選單）→ 'clipboard'（複製網址）→ 'manual'（顯示網址讓使用者自己複製）。
   * @param {object} nav  navigator（測試時可以傳假物件）
   */
  function shareMethod(nav) {
    if (nav && typeof nav.share === 'function') { return 'share'; }
    if (canCopy(nav)) { return 'clipboard'; }
    return 'manual';
  }

  function canCopy(nav) {
    return !!(nav && nav.clipboard && typeof nav.clipboard.writeText === 'function');
  }

  /** 使用者自己取消系統分享選單時，navigator.share 會以 AbortError 拒絕；這種情況不算錯誤。 */
  function isAbortError(err) {
    return !!err && (err.name === 'AbortError' || err.code === 20);
  }

  /** navigator.share 用的資料：空的欄位不放進去（全部為空時 share() 會拒絕）。 */
  function buildShareData(title, text, url) {
    var data = {};
    if (typeof title === 'string' && title.trim()) { data.title = title.trim(); }
    if (typeof text === 'string' && text.trim()) { data.text = text.trim(); }
    if (typeof url === 'string' && url) { data.url = url; }
    return data;
  }

  return {
    resolveShareUrl: resolveShareUrl,
    stripQueryAndHash: stripQueryAndHash,
    toHttpUrl: toHttpUrl,
    shareMethod: shareMethod,
    canCopy: canCopy,
    isAbortError: isAbortError,
    buildShareData: buildShareData
  };
}));
