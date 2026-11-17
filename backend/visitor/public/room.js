/* 訪客端頁面上的小動作。沒有這個檔案頁面也能用（登入、看照片、送出回覆、登出都是一般的表單與連結）；
   有的話多幾件事：
   - 可以顯示輸入中的合言葉
   - 照片可以在頁面上放大；載入中、沒載入成功、登入過期時各有一句說明與對應的按鈕
   - 回覆送出時不離開頁面；失敗時輸入的內容留著，重送也不會存成兩筆（同一則回覆從頭到尾用同一個送出編號）
   - 登入過期時不用離開頁面就能重新登入（寫到一半的內容留在輸入欄，可以先複製）
   這裡沒有任何「是否已登入」的判斷：能不能看、能不能送，都由伺服器決定。
   寫到一半的回覆與合言葉只存在這一頁的輸入欄裡，不會寫進瀏覽器的任何儲存空間。 */
(function () {
  'use strict';
  var doc = document;
  var canFetch = typeof window.fetch === 'function' && typeof window.URLSearchParams === 'function';
  var each = function (list, fn) { Array.prototype.forEach.call(list, fn); };

  /** 送出表單內容（不換頁），回應一律當作 JSON 讀。太久沒有回應就當作失敗 */
  var request = function (url, options, timeoutMs) {
    var controller = typeof window.AbortController === 'function' ? new window.AbortController() : null;
    var timer = controller ? window.setTimeout(function () { controller.abort(); }, timeoutMs || 30000) : null;
    var init = { method: options.method || 'GET', headers: { 'Accept': 'application/json' }, credentials: 'same-origin', redirect: 'error', cache: 'no-store' };
    if (options.fields) {
      var body = new window.URLSearchParams();
      Object.keys(options.fields).forEach(function (name) { body.append(name, options.fields[name]); });
      init.body = body.toString();
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    if (controller) { init.signal = controller.signal; }
    var done = function () { if (timer) { window.clearTimeout(timer); } };
    return window.fetch(url, init).then(function (res) {
      if (options.method === 'HEAD') { done(); return { status: res.status, ok: res.ok, data: null }; }
      return res.json().then(function (data) { done(); return { status: res.status, ok: res.ok, data: data }; });
    }, function (err) { done(); throw err; });
  };

  /* ---------- 顯示／隱藏輸入中的合言葉 ---------- */
  each(doc.querySelectorAll('[data-show-toggle]'), function (toggle) {
    var input = doc.getElementById(toggle.getAttribute('data-show-toggle'));
    var box = toggle.querySelector('input');
    if (!input || !box) { return; }
    toggle.hidden = false;
    box.checked = false;
    box.addEventListener('change', function () { input.type = box.checked ? 'text' : 'password'; });
  });
  // 登入表單送出後停用按鈕，避免連按兩次
  var pass = doc.getElementById('room-pass');
  var loginForm = pass ? pass.form : null;
  if (loginForm) {
    loginForm.addEventListener('submit', function () {
      var btn = loginForm.querySelector('button[type="submit"]');
      if (btn) { window.setTimeout(function () { btn.disabled = true; }, 0); }
    });
  }

  var replyForm = doc.querySelector('[data-reply-form]');
  var area = replyForm ? replyForm.querySelector('textarea') : null;
  var list = doc.querySelector('[data-photos]');

  /** 把伺服器給的新防偽造編號換進頁面上的表單：重新登入之後、或這一頁的防偽造編號已經過期時用。
      這裡只換防偽造編號。回覆表單裡的送出編號（nonce）代表「這一則回覆」，和登入無關，不在這裡動：
      它要等伺服器確認存好才換下一個（見下面的 send）。如果重新登入或換防偽造編號時把它也換掉，
      「其實已經存進去、只是成功的回應沒有送到」的那一則再送一次，就會被存成第二筆 */
  var adoptCsrf = function (csrf) {
    if (!csrf) { return; }
    each(doc.querySelectorAll('.reply__form input[name="csrf"], .room__logout input[name="csrf"]'), function (field) { field.value = csrf; });
  };

  /* ---------- 登入過期時：不離開頁面重新登入 ---------- */
  var relogin = (function () {
    var panel = doc.getElementById('relogin');
    var form = panel ? panel.querySelector('[data-relogin-form]') : null;
    if (!panel || !form || !canFetch) { return null; }
    var lead = panel.querySelector('.relogin__lead');
    var input = form.querySelector('input[name="password"]');
    var button = form.querySelector('button[type="submit"]');
    var status = form.querySelector('.room__status');
    var copyBox = panel.querySelector('[data-copy]');
    var copyButton = panel.querySelector('[data-copy-button]');
    var copyStatus = panel.querySelector('[data-copy-status]');
    var text = function (name) { return panel.getAttribute('data-' + name) || ''; };
    var busy = false;
    var after = null;

    var setStatus = function (message, isError) {
      status.textContent = message || '';
      status.classList.toggle('room__status--error', !!isError);
      if (isError) { input.setAttribute('aria-invalid', 'true'); } else { input.removeAttribute('aria-invalid'); }
    };

    /** 把寫到一半的內容放進剪貼簿。成功與否都說清楚；失敗時告訴對方可以自己長按選取 */
    var copyDraft = function () {
      var value = area ? area.value : '';
      var report = function (ok) {
        copyStatus.textContent = text(ok ? 'copied' : 'copy-failed');
        copyStatus.classList.toggle('room__status--error', !ok);
      };
      var fallback = function () {
        var ok = false;
        try { area.focus(); area.select(); ok = doc.execCommand('copy'); } catch (err) { ok = false; }
        report(ok);
      };
      if (!value) { report(false); return; }
      if (window.navigator && window.navigator.clipboard && typeof window.navigator.clipboard.writeText === 'function') {
        window.navigator.clipboard.writeText(value).then(function () { report(true); }, fallback);
      } else { fallback(); }
    };
    if (copyButton) { copyButton.addEventListener('click', copyDraft); }

    /** 登入成功後，把新的防偽造編號換進頁面上的表單，並重新載入剛剛沒載入成功的縮圖 */
    var adopt = function (data) {
      adoptCsrf(data.csrf);
      each(doc.querySelectorAll('.room__img'), function (img) {
        if (img.complete && img.naturalWidth === 0) { img.src = img.getAttribute('src').split('?')[0] + '?r=' + Date.now(); }
      });
    };

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy) { return; }
      if (!input.value) { setStatus(text('empty'), true); input.focus(); return; }
      busy = true;
      button.disabled = true;
      setStatus(text('busy'), false);
      var finish = function () { busy = false; button.disabled = false; };
      // 先向伺服器要登入表單用的防偽造編號，再送出合言葉
      request('/session', {}).then(function (info) {
        if (!info.ok || !info.data || !info.data.csrf) { throw new Error('no-csrf'); }
        return request(form.action, { method: 'POST', fields: { csrf: info.data.csrf, password: input.value } });
      }).then(function (result) {
        finish();
        if (result.ok && result.data && result.data.ok) {
          input.value = '';
          input.type = 'password';
          each(form.querySelectorAll('[data-show-toggle] input'), function (box) { box.checked = false; });
          setStatus('', false);
          copyStatus.textContent = '';
          panel.hidden = true;
          adopt(result.data);
          var next = after;
          after = null;
          if (next) { next(); }
        } else {
          setStatus((result.data && result.data.message) || text('failed'), true);
          input.focus();
        }
      }).catch(function () {
        finish();
        setStatus(text('failed'), true);
        input.focus();
      });
    });

    return {
      text: text,
      /** 打開重新登入的區塊。reason：'reply'（送出回覆時發現登入過期）或 'photo'（看照片時發現）；done：登入成功後要做的事 */
      open: function (reason, done) {
        after = done || null;
        lead.textContent = text(reason === 'reply' ? 'lead-reply' : 'lead-photo');
        if (copyBox) { copyBox.hidden = !(area && area.value); }
        copyStatus.textContent = '';
        setStatus('', false);
        panel.hidden = false;
        if (typeof panel.scrollIntoView === 'function') { panel.scrollIntoView({ block: 'center' }); }
        if (reason === 'reply') { panel.focus(); } else { input.focus(); }
      }
    };
  }());

  /* ---------- 照片放大 ---------- */
  var links = list ? Array.prototype.slice.call(list.querySelectorAll('[data-photo]')) : [];
  if (links.length && typeof window.HTMLDialogElement === 'function') {
    var label = function (name) { return list.getAttribute('data-' + name) || ''; };
    var dialog = doc.createElement('dialog');
    dialog.className = 'lightbox';
    var stage = doc.createElement('div');
    stage.className = 'lightbox__stage';
    // 照片還沒出現時，畫面中央的一句話與一顆按鈕（載入中／沒載入成功／登入過期／照片已經不在）
    var state = doc.createElement('div');
    state.className = 'lightbox__state';
    state.hidden = true;
    var message = doc.createElement('p');
    message.className = 'lightbox__message';
    message.setAttribute('role', 'status');
    message.setAttribute('aria-live', 'polite');
    var makeBtn = function (kind, textValue) {
      var b = doc.createElement('button');
      b.type = 'button';
      b.className = 'lightbox__btn lightbox__btn--' + kind;
      b.textContent = textValue;
      return b;
    };
    var action = makeBtn('action', '');
    action.hidden = true;
    state.appendChild(message);
    state.appendChild(action);
    stage.appendChild(state);
    var closeBtn = makeBtn('close', label('close'));
    var prevBtn = makeBtn('prev', label('prev'));
    var nextBtn = makeBtn('next', label('next'));
    var count = doc.createElement('p');
    count.className = 'lightbox__count';
    dialog.appendChild(stage);
    dialog.appendChild(closeBtn);
    dialog.appendChild(prevBtn);
    dialog.appendChild(nextBtn);
    dialog.appendChild(count);
    doc.body.appendChild(dialog);

    var current = 0;
    var opener = null;
    var shown = null;          // 目前顯示在畫面上的 <img>
    var ticket = 0;            // 每開始載入一張就加一：較早那一張晚到的結果會被忽略
    var attempt = 0;
    var waitTimer = null;
    var onAction = null;
    var keepFocus = false;     // 關閉放大畫面後，焦點要不要回到原本點的那張照片

    var setState = function (kind) {
      if (waitTimer) { window.clearTimeout(waitTimer); waitTimer = null; }
      dialog.setAttribute('data-state', kind);
      if (kind === 'ready') { state.hidden = true; message.textContent = ''; action.hidden = true; onAction = null; return; }
      state.hidden = false;
      action.hidden = true;
      onAction = null;
      if (kind === 'loading') {
        // 很快就載入好的話不顯示「載入中」，免得字閃一下
        message.textContent = '';
        waitTimer = window.setTimeout(function () { message.textContent = label('loading'); }, 300);
        return;
      }
      if (kind === 'failed') {
        message.textContent = label('failed');
        action.textContent = label('retry');
        action.hidden = false;
        onAction = function () { attempt += 1; load(); };
      } else if (kind === 'session') {
        message.textContent = label('session');
        if (relogin) {
          action.textContent = label('signin');
          action.hidden = false;
          onAction = function () {
            var index = current;
            keepFocus = false;
            dialog.close();
            // 重新登入成功後，回到剛剛那張照片
            relogin.open('photo', function () { open(index); });
          };
        }
      } else {
        message.textContent = label('gone');
      }
    };

    /** 圖片沒載入成功時，問伺服器是什麼情況：登入過期（401）、照片已經不在（404）、還是一時連不上 */
    var classify = function (url, mine) {
      if (!canFetch) { setState('failed'); return; }
      request(url, { method: 'HEAD' }, 15000).then(function (res) {
        if (mine !== ticket) { return; }
        setState(res.status === 401 ? 'session' : (res.status === 404 ? 'gone' : 'failed'));
      }, function () {
        if (mine === ticket) { setState('failed'); }
      });
    };

    var load = function () {
      ticket += 1;
      var mine = ticket;
      var link = links[current];
      var thumb = link.querySelector('img');
      if (shown) { stage.removeChild(shown); shown = null; }
      setState('loading');
      var img = doc.createElement('img');
      img.className = 'lightbox__img';
      img.decoding = 'async';
      img.alt = thumb ? thumb.alt : '';
      img.addEventListener('load', function () {
        if (mine !== ticket) { return; }
        shown = img;
        stage.appendChild(img);
        setState('ready');
      });
      img.addEventListener('error', function () {
        if (mine === ticket) { classify(link.href, mine); }
      });
      // 重試時在網址後面加一個數字，確保瀏覽器真的重新向伺服器要一次（伺服器只看路徑）
      img.src = link.href + (attempt ? '?retry=' + attempt : '');
    };

    var show = function (index) {
      current = (index + links.length) % links.length;
      attempt = 0;
      count.textContent = (current + 1) + ' / ' + links.length;
      prevBtn.hidden = nextBtn.hidden = links.length < 2;
      load();
    };
    var open = function (index) {
      opener = links[(index + links.length) % links.length];
      keepFocus = true;
      show(index);
      if (!dialog.open) { dialog.showModal(); }
      closeBtn.focus();
    };

    links.forEach(function (link, index) {
      link.addEventListener('click', function (e) {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) { return; }   // 想另開分頁的話照常
        e.preventDefault();
        open(index);
      });
    });
    action.addEventListener('click', function () { if (onAction) { onAction(); } });
    closeBtn.addEventListener('click', function () { dialog.close(); });
    prevBtn.addEventListener('click', function () { show(current - 1); });
    nextBtn.addEventListener('click', function () { show(current + 1); });
    dialog.addEventListener('click', function (e) { if (e.target === dialog || e.target === stage) { dialog.close(); } });
    dialog.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') { show(current - 1); }
      if (e.key === 'ArrowRight') { show(current + 1); }
    });
    dialog.addEventListener('close', function () {
      ticket += 1;                                   // 還在路上的載入結果不用再理會
      if (waitTimer) { window.clearTimeout(waitTimer); waitTimer = null; }
      if (shown) { stage.removeChild(shown); shown = null; }
      state.hidden = true;
      if (keepFocus && opener) { opener.focus(); }
    });
  }

  /* ---------- 回覆：字數、送出 ---------- */
  if (!replyForm) { return; }
  var status = doc.getElementById('reply-status');
  var counter = replyForm.querySelector('[data-count]');
  var button = replyForm.querySelector('button[type="submit"]');
  var max = counter ? Number(counter.getAttribute('data-max')) : 2000;
  var sending = false;

  var updateCount = function () {
    if (!counter) { return; }
    var n = Array.from(area.value).length;
    counter.textContent = n ? counter.getAttribute('data-template').replace('{count}', n).replace('{max}', max) : '';
  };
  var setStatus = function (text, isError) {
    status.textContent = text || '';
    status.classList.toggle('room__status--error', !!isError);
    if (isError) { area.setAttribute('aria-invalid', 'true'); } else { area.removeAttribute('aria-invalid'); }
  };
  area.addEventListener('input', function () {
    updateCount();
    if (!sending && status.classList.contains('room__status--error')) { setStatus('', false); }
  });
  updateCount();

  if (!canFetch) { return; }
  /** 送出期間把輸入欄鎖住（唯讀）、按鈕停用：等待回應的時候內容不會被改掉，也不會重送 */
  var lock = function (on) {
    sending = on;
    button.disabled = on;
    area.readOnly = on;
  };
  /** 送出回覆。refreshed：這一次是不是「換過防偽造編號之後的重送」（只自動重送一次） */
  var send = function (refreshed) {
    var fields = {};
    each(replyForm.elements, function (field) { if (field.name) { fields[field.name] = field.value; } });
    var sent = area.value;                         // 這一次實際送出去的內容
    lock(true);
    setStatus(replyForm.getAttribute('data-sending'), false);
    var needLogin = function (text) {
      // 登入過期：內容留在輸入欄，下面出現「複製」與「重新登入」。
      // 說明同樣不斷定「還沒送出」：這一則有可能在前一次嘗試時已經存好
      lock(false);
      setStatus(text, true);
      relogin.open('reply', function () {
        setStatus(relogin.text('done-reply'), false);
        button.focus();
      });
    };
    /* 沒有收到「已經存好」的確認。伺服器沒有給說明時（斷線、逾時、回應讀不懂）用 data-failed 那一句：
       說的是「無法確認有沒有送出」，不是「沒有送出」——這一次有可能其實已經存好，只是回應沒有送到 */
    var failed = function (text) {
      lock(false);
      setStatus(text || replyForm.getAttribute('data-failed'), true);
      area.focus();
    };
    request(replyForm.action, { method: 'POST', fields: fields }).then(function (result) {
      var data = result.data;
      if (result.ok && data && data.ok) {
        lock(false);
        // 伺服器確認已經存好，才顯示送出成功。這一則到此結束：換上伺服器給的下一個送出編號，
        // 下一則（就算文字一樣）才不會被當成同一次送出。送出編號只在這裡換——失敗、登入過期、重新登入、
        // 換防偽造編號之後的重送，用的都是原本那一個。
        // 清空之前再確認一次：輸入欄裡還是剛剛送出去的那一份。萬一等待期間內容被改過（送出的是 A、現在是 B），
        // 留著現在的內容不動，並說明它還沒有送出
        var unchanged = area.value === sent;
        if (unchanged) { area.value = ''; }
        updateCount();
        if (data.nonce) { replyForm.elements.nonce.value = data.nonce; }
        setStatus(unchanged ? data.message : replyForm.getAttribute('data-sent-kept'), false);
        return null;
      }
      if (result.status === 401 && data && data.code === 'session' && relogin) { needLogin(data.message); return null; }
      if (result.status === 403 && data && data.code === 'errExpired' && !refreshed) {
        // 這一頁的防偽造編號已經不是目前這次登入的（例如在另一個分頁重新登入過）：向伺服器要新的，自動再送一次。
        // 輸入欄在這段期間維持鎖住，內容不變；送出編號也不變（還是同一則）
        return request('/session', {}).then(function (info) {
          if (info.ok && info.data && info.data.signedIn && info.data.reply && info.data.reply.csrf) {
            adoptCsrf(info.data.reply.csrf);
            send(true);
          } else if (info.ok && info.data && !info.data.signedIn && relogin) {
            needLogin(replyForm.getAttribute('data-session'));
          } else {
            failed(data.message);
          }
        });
      }
      failed(data && data.message);
      return null;
    }).catch(function () {
      // 網路中斷、太久沒有回應等：內容留在輸入欄，送出編號不變，再按一次也不會存成兩筆
      failed('');
    });
  };
  replyForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!sending) { send(false); }                 // 送出中再按一次不會重送
  });
}());
