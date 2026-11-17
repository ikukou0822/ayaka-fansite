# 安全說明（SECURITY.md）

這份說明講的是**公開的應援網站**：純靜態網站，只有 HTML、CSS、JavaScript 和照片，放在 GitHub Pages 上。

2026-11-14 起另外有一個「合言葉のページ」（私密區）：需要密碼才能打開、可以留下回覆。它是**分開部署的另一個服務**（Cloudflare Workers，程式在 `backend/`），有自己的登入、資料庫與安全說明，見本文最後的「[私密區](#私密區合言葉のページ)」與 [backend/README.md](backend/README.md)。下面各節說的「這個網站」都是指公開網站。

- 公開網站本身沒有後端、沒有資料庫、沒有表單、沒有登入功能。
- 不收集任何訪客資料，沒有 cookie、沒有分析或追蹤工具。
- 不載入任何第三方資源（沒有 CDN、沒有 Google Fonts、沒有外部指令碼）；字型使用系統字型。
- 瀏覽器端只會在 `localStorage` 記一個值：語言設定（`ayaka-fansite:lang` = `ja` 或 `zh`）。讀寫都包在 `try/catch` 裡，被封鎖時網站照常運作。
- 「分享這個網站」按鈕不送出任何資料到第三方：只呼叫瀏覽器內建的 Web Share API（系統分享選單）或剪貼簿 API，沒有第三方分享按鈕或追蹤程式碼；分享的內容只有網站標題、一句說明和 `<link rel="canonical">` 的網址，之後要分享到哪裡完全由使用者在自己的裝置上決定。

## 已採取的防護與用途

| 項目 | 做法 | 用途 |
| --- | --- | --- |
| Content-Security-Policy | `index.html`／`letter.html`／`404.html` 的 `<meta http-equiv="Content-Security-Policy">`：`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; upgrade-insecure-requests; require-trusted-types-for 'script'; trusted-types 'none'` | 只允許載入同一網站的指令碼、樣式、圖片與 manifest；其他來源一律封鎖（字型用系統字型，沒有 `@font-face`，所以不開放 `font-src`；之後若自架字型再加回 `font-src 'self'`）。就算哪天不小心混入外部內容或注入攻擊，瀏覽器也不會執行。`base-uri 'none'` 防止被竄改相對路徑的基準，`form-action 'none'` 禁止任何表單送出，`upgrade-insecure-requests` 把 `http://` 自動升級成 `https://`。`require-trusted-types-for 'script'` 讓瀏覽器（Chromium）在執行期直接擋掉 `innerHTML`、`document.write`、`eval` 等會把字串變成 HTML／程式的操作，確保「不用 innerHTML」這條規則由瀏覽器強制執行。`trusted-types 'none'` 再禁止任何程式建立 Trusted Types 政策（沒有這條時，同源程式只要建立一個名為 `default` 的政策，字串型 innerHTML 就會重新變成合法）；日後若真的需要，必須用 `trustedTypes.createPolicy()` 建立政策，並把 `trusted-types 'none'` 改成 `trusted-types <名稱>`。 |
| 沒有 inline 程式與樣式 | 所有 JavaScript 與 CSS 都放在獨立檔案；HTML 裡沒有 `<script>…</script>`、`<style>`、`style="…"`、`onclick` 等屬性 | 配合上面的 CSP：inline 程式碼本來就會被封鎖，網站本身也不依賴它們 |
| 只用 `textContent`／`createElement` 寫入畫面 | `app.js` 把 `data.js`、`letter.js` 把 `letter-data.js` 的資料畫到畫面時都不使用 `innerHTML` | 資料裡就算含有 `<`、`>` 等字元，也只會被當成文字顯示，不會變成 HTML（防 XSS） |
| Referrer 政策 | `<meta name="referrer" content="no-referrer">` | 訪客從本站點到任何地方時，不會把本站網址當作來源送出 |
| 外部連結 | 出處、官方作品頁、官方連結等外部連結都由 `app.js` 的 `extLink()` 產生：只接受 `https://` 網址（其他只顯示文字），一律加上 `target="_blank"` 與 `rel="noopener noreferrer"`；連結目的地只來自 `data.js`，沒有任何使用者輸入。只有連結，沒有嵌入（iframe、第三方腳本、圖片都沒有），CSP 沒有因此放寬 | 防止被開啟的頁面操控本站視窗（`window.opener`）並且不送出 referrer；訪客的瀏覽器不會因為打開本站而連到任何第三方 |
| 被 iframe 嵌入時的保護 | `app.js` 檢查 `window.top !== window.self`：被嵌入時先嘗試導回最上層（同來源才會成功），然後**把整頁內容清空，只留下一段說明與「開啟網站」連結**（`target="_top"`） | GitHub Pages 無法設定 `X-Frame-Options`／`frame-ancestors` 標頭，瀏覽器也不允許跨來源 iframe 在沒有使用者互動時導向最上層，所以無法完全阻止被框；但被框的頁面會變成不可用的空殼，點擊劫持（clickjacking）與冒充就沒有內容可利用。訪客點連結即可在最上層開啟真正的網站。 |
| 分享按鈕 | `app.js` 只呼叫 `navigator.share`（有的話）或 `navigator.clipboard.writeText`，網址固定取 `<link rel="canonical">` 的絕對網址（`share.js` 只接受 http/https）；狀態文字只用 `textContent` 寫入 | 不載入第三方分享元件、不送出任何資料到第三方，也不會把含 query／hash 的目前網址或非 http(s) 的內容放進分享資料 |
| 照片中繼資料 | `photos/` 裡的照片（活動照片與視訊截圖）已去除 EXIF、ICC 等中繼資料（GPS、拍攝裝置等）；新照片用 `scripts/import_photos.py` 處理時也會一併去除 | 不洩漏拍攝位置與裝置資訊 |
| 相對路徑 | 所有資源都用相對路徑 | 放在 `https://ikukou0822.github.io/ayaka-fansite/` 這種子路徑下也能正常運作，不會意外去抓別的網址 |
| `.nojekyll` | 根目錄有 `.nojekyll` | 讓 GitHub Pages 直接發布檔案，不經過 Jekyll 處理，避免意外的轉換 |

### 已知限制

- 用 `<meta>` 設定的 CSP 不支援 `frame-ancestors` 與 `report-uri`，因此無法真正禁止被嵌入，只能在被嵌入時隱藏內容（見上表）。`404.html` 沒有 JavaScript，被嵌入時只會顯示那幾行靜態文字。
- GitHub Pages 不能自訂 HTTP 標頭（如 `Strict-Transport-Security`），請在 GitHub 的 Pages 設定勾選 **Enforce HTTPS**。

## 帳號安全建議（網站主人）

- GitHub 帳號開啟 **兩步驟驗證**（Settings → Password and authentication），並保存 recovery codes。
- **Pages 設定勾選 Enforce HTTPS**（Settings → Pages）。
- **保護 `main` 分支**（Settings → Rules → Rulesets，或 Settings → Branches）：禁止 force push 與刪除分支。
- GitHub → Settings → Emails：勾選「Keep my email addresses private」與「Block command line pushes that expose my email」。

## 回報問題

如果發現網站有安全或隱私上的問題，請透過這個 GitHub repo 聯絡網站主人。

## 私密區（合言葉のページ）

網站主人在 2026-11-14 要求新增密碼登入、私人合照與訪客回覆，所以多了一個獨立的後端。它不是這個靜態網站的一部分：

- **公開網站只放一個連結**：首頁的「合言葉をお持ちの方はこちら」，網址來自 `data.js` 的 `site.roomUrl`（`app.js` 只接受 `https://` 網址；還沒填時不顯示）。公開網站的 CSP 沒有改動，沒有新增表單、指令碼或任何外部資源。
- **私人內容不在這個 repo**：正式的密碼、金鑰、照片、留言與回覆都只存在 Cloudflare（資料庫、不公開的儲存桶、secrets）。repo 裡的 `backend/` 只有程式、資料表結構、測試與合成的範例圖。`.gitignore` 排除了 `.dev.vars`、`.env`、`.wrangler/`；`node --test` 會檢查 `backend/` 裡沒有金鑰檔、資料庫檔或範例圖以外的圖片。
- **密碼在伺服器驗證**，瀏覽器裡沒有可以改的登入旗標；每一次取得頁面、縮圖、原圖、送出回覆都重新檢查登入，檢查不過或出錯時一律不給。
- **訪客密碼只由系統亂數產生**（16 個位元組、128 bit），沒有自己取密碼的入口；登入時也只受理這個格式。
- **訪客與管理者分開**：訪客密碼只能看專區與送出回覆；讀取回覆、管理照片、換密碼都在另一個服務，放在 Cloudflare Access 後面，Worker 自己還會再驗一次身分。
- **管理者的登入要兩個步驟**，第二因子由 Cloudflare Access 強制（independent MFA）。「沒有完成第二因子就進不了管理端」是匯入正式照片之前的必要驗收；登入用的 Google／GitHub 帳號自己有兩步驟、或寄到信箱的驗證碼，都不算。設定與驗收的做法在 [backend/README.md](backend/README.md#管理端的多因素驗證mfa)。
- **照片**：伺服器照白名單重排每一個上傳的 JPEG，只留影像本身（Exif、GPS、JFIF 檔頭裡的縮圖等都不會寫進儲存空間）。
- **回覆重送不會重複，也不繞過權限**：伺服器用回覆表單裡的送出編號加上內容認出「同一次送出」，這個識別和登入無關（重新登入之後也認得，所以其實已經存好的那一則不會被存成第二筆）。每一次寫入都先檢查登入狀態與防偽造編號，通過了才去重與寫入；送出編號本身不是權限。
- cookie 的屬性、登出與撤銷、限速、跨站偽造請求防護、文字輸出、快取、照片中繼資料、日誌的做法，以及用到哪些 Cloudflare 防護、有沒有別的入口可以繞過，都列在 [backend/README.md 的「防護一覽」](backend/README.md#防護一覽)；怎麼驗證的在同一份文件的「八項驗收對應的測試」。
- **目前狀態（2026-11-16）：兩個服務已部署並設定金鑰；管理端的 Access／MFA 與正式環境驗收尚未完成，尚未匯入正式內容。** 帳號安全（Cloudflare 帳號要開兩步驟驗證、不要開啟儲存桶的公開存取）寫在 backend/README.md 的「部署」；正式環境要確認的項目（Access 與第二因子、其他入口、CPU 用量、真實手機）列在 [backend/ACCEPTANCE.md](backend/ACCEPTANCE.md)，通過之前不放真正的照片。
