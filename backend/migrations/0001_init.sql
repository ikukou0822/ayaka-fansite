-- 私密區的資料表（Cloudflare D1）。
-- 這個檔案只有結構，沒有任何正式資料：密碼雜湊、照片說明、回覆都是部署後才由管理頁寫入資料庫。

-- 設定：訪客密碼的雜湊與版本、撤銷登入用的世代編號、頁面的標題與留言
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 訪客的登入狀態。id_hash 是登入憑證的 SHA-256；憑證本身只存在訪客的 cookie 裡，資料庫沒有
CREATE TABLE sessions (
  id_hash          TEXT PRIMARY KEY,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  password_version INTEGER NOT NULL,   -- 登入時的密碼版本；換密碼後舊的全部失效
  epoch            INTEGER NOT NULL    -- 登入時的世代編號；「撤銷所有登入」會讓它加一
);
CREATE INDEX sessions_expires ON sessions (expires_at);

-- 照片的說明。檔案本體在私人儲存桶（R2）：photos/<id>/full.jpg、photos/<id>/thumb.jpg
CREATE TABLE photos (
  id           TEXT PRIMARY KEY,
  position     INTEGER NOT NULL DEFAULT 0,
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  thumb_width  INTEGER NOT NULL,
  thumb_height INTEGER NOT NULL,
  taken_on     TEXT,
  alt_ja       TEXT NOT NULL DEFAULT '',
  alt_zh       TEXT NOT NULL DEFAULT '',
  caption_ja   TEXT NOT NULL DEFAULT '',
  caption_zh   TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL
);

-- 訪客的回覆（純文字）。session_ref 只用來分辨「同一次登入送的」，認不出是誰；它不參與去重
CREATE TABLE replies (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  session_ref TEXT NOT NULL,
  lang        TEXT NOT NULL,
  body        TEXT NOT NULL,
  dedupe_key  TEXT NOT NULL UNIQUE     -- 由「送出編號＋內容」算出的雜湊，不含登入代號：同一次送出重送（包含重新登入之後）不會存成兩筆
);
CREATE INDEX replies_created ON replies (created_at);

-- 限速用的計數（固定時間窗）。bucket 裡的 IP 是加了金鑰的雜湊，不存原始 IP
CREATE TABLE rate_limits (
  bucket       TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);

-- 管理者做過的事（換密碼、刪除回覆、上傳照片…）。不記密碼、憑證或留言內容
CREATE TABLE audit (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
