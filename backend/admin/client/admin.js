/* 管理頁的小動作：刪除前先確認、照片上傳前在瀏覽器裡重新編碼。
   能不能進管理頁由 Cloudflare Access 與伺服器決定，這裡沒有任何權限判斷。 */
(function () {
  'use strict';
  var doc = document;

  // 會刪除或讓舊密碼失效的表單：送出前先確認
  Array.prototype.forEach.call(doc.querySelectorAll('form[data-confirm]'), function (form) {
    form.addEventListener('submit', function (e) {
      if (!window.confirm(form.getAttribute('data-confirm'))) { e.preventDefault(); }
    });
  });

  var form = doc.querySelector('[data-upload-form]');
  if (!form) { return; }
  var status = form.querySelector('[data-upload-status]');
  var button = form.querySelector('button[type="submit"]');

  /** 把照片畫到畫布上再存成 JPEG：縮到指定的長邊（照片已經依拍攝方向轉正）。
      重新編碼後的檔案不帶原本的拍攝地點、裝置、時間等資料；伺服器收到後還會再清一次 */
  function encode(bitmap, maxEdge, quality) {
    var scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    var canvas = doc.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';                       // 透明的 PNG 轉成 JPEG 時用白底
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) { if (blob) { resolve(blob); } else { reject(new Error('這個瀏覽器無法處理這張照片')); } }, 'image/jpeg', quality);
    });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var file = form.elements.file.files[0];
    if (!file || button.disabled) { return; }
    button.disabled = true;
    status.textContent = '處理照片中…';
    window.createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bitmap) {
      return Promise.all([encode(bitmap, 2000, 0.88), encode(bitmap, 800, 0.82)]);
    }).then(function (blobs) {
      status.textContent = '上傳中…';
      var data = new FormData();
      data.append('csrf', doc.body.getAttribute('data-csrf'));
      ['alt_ja', 'alt_zh', 'caption_ja', 'caption_zh', 'taken_on'].forEach(function (name) { data.append(name, form.elements[name].value); });
      data.append('full', blobs[0], 'full.jpg');
      data.append('thumb', blobs[1], 'thumb.jpg');
      return window.fetch('/photos', { method: 'POST', body: data, headers: { 'Accept': 'application/json' }, credentials: 'same-origin' });
    }).then(function (res) {
      return res.json().then(function (body) { return { ok: res.ok && body && body.ok, message: body && body.message }; });
    }).then(function (result) {
      if (!result.ok) { throw new Error(result.message || '伺服器沒有接受這張照片'); }
      window.location.href = '/photos?ok=uploaded';
    }).catch(function (err) {
      button.disabled = false;
      status.textContent = '沒有上傳成功：' + (err && err.message ? err.message : '請再試一次');
    });
  });
}());
