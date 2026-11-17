# 部署清單：站主要做的事、方案與付款、順序

這份清單給站主本人照著做。它把 [README.md](README.md) 的說明整理成四件事：開始之前要準備什麼、哪些地方要填付款資料、依序做哪些事、在哪裡停下來。每一步的結果記在 [ACCEPTANCE.md](ACCEPTANCE.md)。

**現在的狀態（2026-11-16）：階段 0 到 4 已完成，兩個服務已部署並設定金鑰；階段 5 之後（管理端的 Access／MFA、正式環境驗收、匯入正式內容）還沒有做。** 2026-11-15 交付這一版時還沒有部署，只在本機交付。下面每一步都等站主確認之後才開始，而且都要由站主本人操作：登入帳號、填付款資料、設定金鑰、註冊第二因子。

**這個 repo 是公開的。** 密碼、金鑰、驗證碼、信箱都不要貼進對話、不要寫進任何檔案。要請人幫忙看結果時，貼指令的輸出或錯誤訊息就好（貼之前看一眼裡面有沒有上述的東西）。

## 目錄

- [一、本機已經備妥的](#一本機已經備妥的)
- [二、開始之前：要準備與決定的](#二開始之前要準備與決定的)
- [三、方案與付款條件](#三方案與付款條件)
- [四、部署順序](#四部署順序)
- [五、驗收用的範例內容](#五驗收用的範例內容)
- [六、誰做什麼](#六誰做什麼)
- [七、中止與復原](#七中止與復原)
- [之後更新程式](#之後更新程式)

## 一、本機已經備妥的

這些不用站主做，結果是 2026-11-15 在這份檔案所在的 commit 上得到的。

| 項目 | 結果 |
| --- | --- |
| 測試 | 後端 141 項、公開網站 51 項、`scripts/qa.js` 491 項，全部通過 |
| 兩個 Worker 打包得起來 | `wrangler deploy --dry-run`（只打包、不上傳）：訪客端 51.63 KiB（gzip 14.80 KiB）、管理端 117.00 KiB（gzip 32.28 KiB）。Workers 免費方案的上限是壓縮後 3 MB |
| 部署設定 | 兩個設定檔的預覽網址都是關閉、沒有寫死的金鑰、沒有本機模擬用的設定（`tests/unit.spec.mjs` 每次測試都檢查）。只差 `database_id`，要等資料庫建立之後才有 |
| 指令 | 下面用到的 `wrangler` 指令與參數，都用鎖定的版本（4.162.0）確認過存在。**沒有對真的帳號執行過**。指令區塊照原樣貼進 zsh 5.9 的互動模式試過：階段 0 是真的執行；階段 3、4、8 的 `wrangler` 與檢查腳本用只記錄參數的替身 |
| 驗收用的內容 | 合成的測試圖 `tests/fixtures/sample-1-full.jpg`～`sample-3-full.jpg`；範例文字在[第五節](#五驗收用的範例內容) |
| 驗收紀錄的格子 | [ACCEPTANCE.md](ACCEPTANCE.md) 的 B、C 兩區（傳送之前）、D 區（定稿）、E 區（泡泡訊息送出之後） |

本機做不到、要部署之後才知道的：Cloudflare Access 與第二因子實際有沒有擋住、每個請求的 CPU 時間、真的 iPhone、泡泡。

## 二、開始之前：要準備與決定的

- [ ] **一台有終端機的電腦**，裝好 Node.js 22 以上與 git（`node --version`、`git --version`）。跑單元測試另外需要 Python 3。
- [ ] **Cloudflare 帳號**，而且帳號本身開啟兩步驟驗證。能登入這個帳號的人，就能直接讀到資料庫與照片。
- [ ] **付款方式**（以結帳頁面接受的為準）。有兩個地方要走結帳流程，見[下一節](#三方案與付款條件)。要不要填、填哪一種，都由站主在結帳頁面上自己決定。
- [ ] **兩個名字**。之後要改就等於換網址，請先想好；兩個都不要用本名或信箱的帳號：
  - `workers.dev` 子網域：會出現在給對方的網址裡，`https://ayaka-room.<子網域>.workers.dev`。
  - Zero Trust 的團隊名稱：只出現在站主自己登入管理頁時的網址，`<團隊名稱>.cloudflareaccess.com`。
- [ ] **第二因子**：手機上的驗證器 App（一次性密碼，TOTP）。另外準備一個備用的**另一種**驗證方式（這台電腦或手機的生物辨識，或安全金鑰）：官方文件寫明驗證器 App 每個人同時只能註冊一個。
- [ ] **管理頁的第一個登入步驟**用哪一種。建立 Zero Trust 組織時，Cloudflare 會自動加上「用 Cloudflare 帳號登入」；也可以另外加信箱驗證碼或 Google／GitHub。建議就用預設的，少一個要顧的帳號。不論哪一種，都還要再加上 Access 自己要求的第二因子。
- [ ] 驗收用：一支 iPhone（Safari）、泡泡 App（只看不送出的草稿與既有的訊息；驗收階段不對彩花送出任何訊息）、一張無關緊要的手機照片（量上傳的 CPU 用；風景之類的，不是合照）。
- [ ] 一段不被打擾的時間。帳號與部署估計一小時上下，驗收另外算（這是估計，沒有量過）。

## 三、方案與付款條件

2026-11-15 查閱官方頁面（出處在 [README 最後一節](README.md#查證過的-cloudflare-資料)）。Cloudflare 的方案會調整，結帳前以當下的頁面為準。

| 服務 | 要選的方案 | 費用 | 開通時要付款資料嗎 | 什麼時候會開始花錢 |
| --- | --- | --- | --- | --- |
| Cloudflare 帳號 | — | 免費 | 不用 | — |
| Workers（兩個服務） | Free | 0 | 不用 | 不會自動收費。每天 100,000 個請求、每個請求 10 ms 的 CPU 時間，超過時那個請求失敗。B-4 量到 CPU 超過上限時，要改 Workers Paid（每月最低 5 美元）或調整程式 |
| D1（資料庫） | 跟著 Workers Free | 0 | 不用 | 不會自動收費。單一資料庫 500 MB、帳號合計 5 GB；每天讀 500 萬列、寫 10 萬列，到了就停到隔天 |
| R2（照片） | 加上 R2 訂閱（有每月免費用量，超過的按用量計費） | 免費用量內 0 | **要走結帳流程**：先在後台加上 R2 訂閱。官方文件沒有明寫這一步要不要填付款方式，以結帳畫面為準 | 超過每月免費用量的部分：10 GB-month 的儲存、100 萬次 Class A 操作、1,000 萬次 Class B 操作。這個專案的規模是幾十張照片 |
| Zero Trust（Cloudflare Access） | Free（50 人以內） | 0 | **要**：建立組織時要選方案並填付款資料；官方的說明是選 Free 不會被收費 | 改選 Pay-as-you-go（每人每月 7 美元）時。結帳頁面上的條款見[階段 1](#階段-1帳號與付款) |
| 自己的網域 | 不需要 | — | — | 用 `workers.dev` 網址 |

**預期每月費用是 0。** 會變成要付費的情況有三種：

1. 正式環境量到某個操作的 CPU 超過 10 ms（最可能是管理端上傳照片），又不調整程式：Workers Paid，每月最低 5 美元。
2. Access 的 independent MFA：官方沒有寫它屬於哪個方案，所以現在**沒有依據**說它需要付費，也沒有依據說付了費就能用。找不到設定或註冊失敗時怎麼處理，寫在[階段 5](#階段-5管理端的-access-與第二因子)：先核對設定，必要時向官方確認資格；官方確認付費確實能解決之後，才由站主決定要不要升級（Pay-as-you-go 是每人每月 7 美元，這裡只有站主一個人）。
3. R2 的用量超過免費額度。以這個規模不太可能。

### 文件上查不到、要在後台實測的一件事

**independent MFA 在 Zero Trust Free 能不能用。**

- 官方的 independent MFA 說明、Access 的更新紀錄、方案比較頁，都沒有寫這個功能屬於哪個方案。
- Cloudflare 社群論壇上有使用者回報：在 Zero Trust Free 上用驗證器 App 的 independent MFA，輸入錯的驗證碼會被拒絕（2026 年 11 月的貼文）。那是使用者的回報，不是官方的說法。
- 同一批貼文也提到：一開始所有方法都是關閉的，這時候後台不會顯示「Apply global MFA settings by default」與驗證的有效時間，應用程式那一層的 MFA 選項也看不到。所以一開始看不到完整的設定不代表不能用：先在組織層勾選方法並儲存，再看其他設定有沒有出現（這一點還沒有實測）。
- 所以結論不變：**以站主自己後台的實測為準**（[階段 5](#階段-5管理端的-access-與第二因子)）。設定得起來、而且「沒完成第二因子進不了管理端」的實測通過，才往下走；做不到就停在那裡。停下來之後的處理順序也在階段 5。**升級方案不是已知的解法。**

## 四、部署順序

每個階段做完，把結果記到 ACCEPTANCE.md。標 🛑 的地方沒有通過就停下來，不往下做。

階段 0 從部署目錄的最上層開始；階段 0 的 `cd backend` 之後，所有指令都在部署目錄的 `backend/` 資料夾裡執行。

貼指令的時候：

- 指令區塊裡只有指令，說明都寫在區塊外面。macOS 預設的終端機（zsh）不會把指令後面的 `#` 當成註解，帶著說明一起貼會出錯。
- `<…>` 是要換成實際值的地方。沒有換就貼上的話，終端機會直接報錯，指令不會執行。
- `git` 與 `npm` 的區塊可以整段貼上。
- `npx wrangler …` 請**一次貼一行**，等它做完、回到提示字元再貼下一行。它有時候會停下來問問題；整段貼上的話，下一行指令會被當成回答。
- 用 `REV`、`VISITOR` 這類變數的指令，要在設定它的同一個終端機視窗裡執行。

### 階段 0：取得程式，確認版本

部署用一個**獨立的目錄**：直接停在交付的那個 commit 上，不掛在任何分支上。這樣不會動到平常工作的目錄、分支與還沒提交的修改，也看得出部署的到底是哪一個 commit。下面兩種方式擇一。

- 兩種方式的第一行，都換成 bundle 實際放的位置與檔名。
- 部署目錄都建在家目錄：`~/ayaka-room-deploy`。不要放在會同步到雲端的資料夾（例如開了 iCloud 同步的桌面與文件）：安裝之後 `node_modules` 裡有上千個小檔案。

方式 A：另外 clone 一份，專門用來部署（建議）

```bash
BUNDLE=~/Downloads/ayaka-2026-11-15-backend-4.bundle
cd ~
git clone https://github.com/ikukou0822/ayaka-fansite.git ayaka-room-deploy
cd ~/ayaka-room-deploy
git fetch "$BUNDLE" private-backend
git checkout --detach FETCH_HEAD
```

方式 B：已經有 clone 時，另外開一個不掛分支的工作目錄。原本的目錄、分支、還沒提交的修改都不會動。先用 `cd` 進到既有的 clone 裡面，再貼這一段：

```bash
BUNDLE=~/Downloads/ayaka-2026-11-15-backend-4.bundle
git fetch "$BUNDLE" private-backend
git worktree add --detach ~/ayaka-room-deploy FETCH_HEAD
cd ~/ayaka-room-deploy
```

- `git fetch "$BUNDLE" private-backend` 只把交付的 commit 取進來，不建立也不移動任何分支。
- `git checkout --detach`、`git worktree add --detach` 讓部署目錄停在那個 commit 上，不在任何分支上。

接著確認版本（兩種方式都一樣）：

```bash
git rev-parse HEAD
git status --short --branch
BASE=d299b2077426e40192a295128758375b5468a8d7
git --no-pager diff --stat "$BASE" HEAD
git --no-pager diff --stat "$BASE" HEAD -- backend/visitor backend/admin backend/shared backend/migrations backend/styles backend/package.json backend/package-lock.json
cd backend
npm ci --ignore-scripts
npm run test:unit
```

| 指令 | 應該看到 |
| --- | --- |
| `git rev-parse HEAD` | 和交付說明寫的 commit 一字不差。驗收紀錄寫的就是它 |
| `git status --short --branch` | 只有一行 `## HEAD (no branch)`：不在任何分支上，也沒有任何修改 |
| 第一個 `git --no-pager diff --stat` | 和複核過的程式版本（`BASE`，也就是 `d299b20`）差在哪些檔案：只有說明文件與 `backend/scripts/check_deployed.mjs` |
| 第二個 `git --no-pager diff --stat` | **沒有任何輸出**：會被部署的程式、資料表結構、安裝的套件，和複核過的那一版完全相同 |
| `npm ci --ignore-scripts` | 照 `package-lock.json` 安裝；不執行任何安裝腳本 |
| `npm run test:unit` | 幾秒；全部通過 |

- [ ] `git rev-parse HEAD` 印出的 commit 和交付說明寫的一樣。
- [ ] `git status --short --branch` 只有 `## HEAD (no branch)` 一行。
- [ ] 第二個 `git --no-pager diff --stat` 沒有輸出。有輸出的話，表示要部署的程式和複核過的那一版不同，先停下來確認。
- [ ] 單元測試全部通過。

之後所有的指令都在這個部署目錄的 `backend/` 裡執行。這個目錄只用來部署：不要在裡面切換分支或修改程式（階段 2 填的 `database_id` 除外）。

### 階段 1：帳號與付款

在瀏覽器裡，Cloudflare 後台。後台的畫面常常調整，以實際看到的為準。

- [ ] 登入（或註冊）Cloudflare，開啟帳號的兩步驟驗證。
- [ ] R2：Storage & databases → R2 → Overview，走完結帳流程，加上 R2 訂閱。這裡先不要建立儲存桶（階段 2 用指令建）。
- [ ] Zero Trust：選 Zero Trust，取團隊名稱，選 **Free** 方案，填付款資料。
- [ ] 兩個結帳頁面上的金額與條款，站主自己讀過再按確認。金額不是 0，或條款和[第三節](#三方案與付款條件)寫的不一樣時，先停下來。
  - 官方的說明：Zero Trust 選 Free 仍然要填付款資料，但不會被收費。
  - 社群論壇上有使用者回報（2026 年 11 月的貼文；**不是官方的說法**，而且只看到搜尋結果裡的摘要，原文沒能打開）：Zero Trust Free 的結帳頁面顯示每月 0 元、50 人以內，同時要求同意「超過免費額度的用量每月收費，直到取消為止」。這個條款實際涵蓋什麼，這裡沒有查到官方的說明；看到這類條款而不確定它的意思時，先停在那裡，不要為了往下走而同意。
- [ ] `workers.dev` 子網域：在 Workers & Pages 設定；還沒設定的話，第一次部署時 `wrangler` 會問。

記到 ACCEPTANCE.md 的 B 區開頭：選了哪些方案。不要寫卡號與信箱。

### 階段 2：資料庫與儲存桶

一次貼一行。

1. 登入。會開瀏覽器請站主登入並同意；登入資料存在系統的鑰匙圈：

   ```bash
   npx wrangler login --use-keyring
   ```

2. 確認登入的是站主的帳號。**輸出裡有信箱，自己看就好，不要貼出來**：

   ```bash
   npx wrangler whoami
   ```

3. 建立資料庫：

   ```bash
   npx wrangler d1 create ayaka-room --location apac
   ```

   把輸出裡的 `database_id` 填進 `visitor/wrangler.jsonc` 與 `admin/wrangler.jsonc`（兩個檔案填同一個值，取代 `00000000-…`）。`database_id` 不是密碼，要有站主的 Cloudflare 登入才用得到；不想公開的話，這兩行修改不要 commit。

   照這裡的寫法（在 `backend/` 裡執行、不加 `-c`），它找不到設定檔，照 wrangler 4.162.0 的程式碼看不會多問。如果它問「Would you like Wrangler to add it on your behalf?」，回答 **no**（直接按 Enter 會是 yes）：兩個設定檔已經有這個資料庫的設定，只差 `database_id`。

4. 建立資料表。它會先列出要套用的檔案（`0001_init.sql`），再問要不要繼續（「About to apply 1 migration(s) … continue?」），回答 yes：

   ```bash
   npx wrangler d1 migrations apply ayaka-room --remote -c visitor/wrangler.jsonc
   ```

5. 建立儲存桶（同樣地，如果問要不要替你把設定寫進設定檔，回答 **no**）：

   ```bash
   npx wrangler r2 bucket create ayaka-room-photos
   ```

6. 確認儲存桶沒有對外。第一個指令應該顯示公開的 `r2.dev` 網址是關閉的，第二個應該沒有任何自訂網域：

   ```bash
   npx wrangler r2 bucket dev-url get ayaka-room-photos
   ```

   ```bash
   npx wrangler r2 bucket domain list ayaka-room-photos
   ```

- [ ] 資料表建立成功。
- [ ] 儲存桶的公開網址是關閉的，沒有自訂網域。之後也不要開啟。

### 階段 3：部署兩個服務

這時候還沒有金鑰，兩邊都是鎖著的。

先確認要部署的內容。`git status --short` 應該只列出兩個 `wrangler.jsonc`（剛填的 `database_id`）；`echo` 印出的是這個 commit 的短編號，下面兩個指令會用到：

```bash
git status --short
REV=$(git rev-parse --short HEAD)
echo "$REV"
```

再部署，一次貼一行：

```bash
npx wrangler deploy -c visitor/wrangler.jsonc --tag "$REV" --message "private-backend $REV"
```

```bash
npx wrangler deploy -c admin/wrangler.jsonc --tag "$REV" --message "private-backend $REV"
```

`--tag` 與 `--message` 把 commit 記在這一次上傳的版本上。後台與 `npx wrangler versions list -c visitor/wrangler.jsonc` 會怎麼顯示它，還沒有對真的帳號確認過，所以 commit 另外也要手寫記在 ACCEPTANCE.md。

記下兩個網址：`https://ayaka-room.<子網域>.workers.dev`、`https://ayaka-room-admin.<子網域>.workers.dev`。

- [ ] 用瀏覽器打開兩個網址：訪客端只有一句「ただいま準備中です。…」（準備中），管理端只有 `Forbidden (not-configured)`。🛑 這時候看得到其他內容的話，停下來。

### 階段 4：金鑰

兩個服務要設成同一組值。下面的寫法不會把金鑰顯示在畫面上，也不經過剪貼簿。這五行是一個完整的指令，整段貼上：

```bash
for KEY in PEPPER SESSION_SECRET; do
  VALUE=$(openssl rand -hex 32)
  printf '%s' "$VALUE" | npx wrangler secret put "$KEY" -c visitor/wrangler.jsonc
  printf '%s' "$VALUE" | npx wrangler secret put "$KEY" -c admin/wrangler.jsonc
done; unset VALUE
```

再確認兩邊都設好了。這兩個指令只列名稱、不顯示內容，兩邊都應該有 `PEPPER` 與 `SESSION_SECRET`：

```bash
npx wrangler secret list -c visitor/wrangler.jsonc
```

```bash
npx wrangler secret list -c admin/wrangler.jsonc
```

`wrangler secret put` 不在互動式終端機時會從標準輸入讀值（鎖定的 wrangler 4.162.0 的程式碼是這樣寫的）；這個用法還沒有對真的帳號試過。失敗的話改用提示輸入：`openssl rand -hex 32` 產生一個值，執行 `npx wrangler secret put PEPPER -c visitor/wrangler.jsonc` 與 `… -c admin/wrangler.jsonc`，兩次都依提示貼上同一個值；`SESSION_SECRET` 用另一個值照做一次。

這兩個值不需要另外保存。兩邊的 `PEPPER` 如果不一樣，訪客端登入時會顯示「準備中」而不是「密碼錯誤」。

- [ ] 訪客端的網址現在是合言葉的登入表單（還沒有產生合言葉，誰都登不進去）；管理端仍然是 `Forbidden (not-configured)`。

### 階段 5：管理端的 Access 與第二因子

🛑 這個階段沒有通過之前，不放任何真正的內容。細節與每一層的畫面名稱在 README 的「[管理端的多因素驗證（MFA）](README.md#管理端的多因素驗證mfa)」。

1. **替管理端啟用 Cloudflare Access**（後台 → Workers & Pages → `ayaka-room-admin`）。
   - 新版後台在這個 Worker 的 **Access** 分頁選擇用 Access 保護這個 Worker；舊版在 **Settings → Domains & Routes** 的 `workers.dev` 那一列按 **Enable Cloudflare Access**。
   - 政策只放一條 Allow，只允許站主自己的信箱。不要加 Bypass 或 Service Auth 政策。
   - **只對管理端啟用。** 不要對訪客端 `ayaka-room` 啟用，否則拿到合言葉的人會先被擋在 Access 的登入頁。
   - 啟用時後台會顯示 `TEAM_DOMAIN`（`https://<團隊名稱>.cloudflareaccess.com`）與 `POLICY_AUD`。把它們和站主登入 Access 用的信箱設給管理端。一次貼一行，值在它提示的時候才輸入（不會顯示在畫面上）：
     ```bash
     npx wrangler secret put TEAM_DOMAIN -c admin/wrangler.jsonc
     npx wrangler secret put POLICY_AUD -c admin/wrangler.jsonc
     npx wrangler secret put ADMIN_EMAILS -c admin/wrangler.jsonc
     ```
2. **設定 independent MFA 的三層**：組織（勾選允許的方法、儲存）→ 應用程式（Custom MFA settings，每次登入都要）→ 政策（不可以是 Disable MFA）。
3. **註冊驗證器**：登入 `https://<團隊名稱>.cloudflareaccess.com` → Account → MFA devices → Add an MFA device。驗證器 App 一個，再加一個另一種的當備用。
4. **必要驗收：沒有完成第二因子，進不了管理端。** 照 README「[必要驗收](README.md#必要驗收沒有完成第二因子進不了管理端)」的七個步驟做，結果記在 ACCEPTANCE.md 的 B-1。
5. 完成兩個步驟後打開管理端。看到 `Forbidden (…)` 的話，括號裡的原因與下面那一行說明會指出哪個設定不對（例如 `aud-mismatch` 會列出實際的 AUD，照著改 `POLICY_AUD`）。

- [ ] B-1 的必要項目全部通過。

🛑 **停下來的情況**：後台找不到 independent MFA 的設定、設定存不起來、驗證器註冊不上去，或是沒完成第二因子也看得到管理頁。這時候不放真正的內容，照下面的順序處理：

1. **先核對設定。** 是不是在對的 Zero Trust 組織（團隊）裡；組織層的方法有沒有勾選、而且按了儲存（一開始全部是關閉的，這時候其他設定可能不會顯示，見[第三節](#文件上查不到要在後台實測的一件事)）；應用程式是不是 Custom MFA settings；政策有沒有被設成 Disable MFA；登入 Access 用的是不是政策允許的那個信箱。改完重新整理後台，再試一次。
2. **還是不行，就向 Cloudflare 官方確認資格。** 記下看到的畫面與錯誤訊息（不要記驗證碼），透過官方的管道確認這個帳號與方案能不能使用 independent MFA。方案比較頁列的支援管道（2026-11-15 查閱）：Free 是社群論壇與 Discord，Pay-as-you-go 才有線上對談與客服單。所以在 Free 方案上，能問的地方是官方的社群論壇與 Discord，再加上官方文件；為了客服單而升級也是付費的決定，同樣由站主決定。
3. **官方確認「付費方案包含這個功能，而且能解決遇到的問題」之後**，才由站主決定要不要升級。升級不是已知的解法：官方沒有寫這個功能屬於哪個方案，沒有確認之前，付了費也不保證能用。
4. 不靠方案的另一條路，是在管理端的程式裡自己加第二因子。那需要另一輪開發與審查，要不要走也由站主決定。

### 階段 6：其他入口

- [ ] 兩個 Worker 的 Preview URLs（新版後台也叫 Version URLs）是 Disabled：後台 → Workers & Pages → 該 Worker → Settings → Domains & Routes。
- [ ] 無痕視窗打開訪客端的網址：直接看到合言葉的登入頁，沒有先被帶到 Access。
- [ ] 再跑一次階段 2 最後兩行（R2 的公開網址與自訂網域）。

結果記在 B-2。

### 階段 7：範例內容與測試用的合言葉

在管理頁：

- [ ] 「標題與留言」貼上[第五節](#五驗收用的範例內容)的範例文字。
- [ ] 「照片」上傳兩三張合成的測試圖（`tests/fixtures/sample-*-full.jpg`）。記下其中一張的編號（照片下面「編號」後面那 32 個字）。
- [ ] 「密碼與登入」產生一組**測試用**的合言葉。只顯示一次；它只用在驗收，驗收完就換掉。

### 階段 8：B 區驗收

🛑 必要項目沒有全部通過之前，不放真正的內容。

先把三個值設成變數（換成實際的值），之後的指令在同一個終端機視窗裡執行：

```bash
VISITOR=https://ayaka-room.<子網域>.workers.dev
ADMIN=https://ayaka-room-admin.<子網域>.workers.dev
TEAM=<團隊名稱>.cloudflareaccess.com
```

1. 不需要密碼的檢查：

   ```bash
   node scripts/check_deployed.mjs --visitor "$VISITOR" --admin "$ADMIN" --team-domain "$TEAM"
   ```

2. 測試圖在登入、登出、撤銷、換密碼前後的存取結果；回覆重送只存一筆。測試用的合言葉在執行時輸入，不會顯示。報告寫在 repo 以外：

   ```bash
   node scripts/check_deployed.mjs --visitor "$VISITOR" --admin "$ADMIN" --team-domain "$TEAM" --photo-id <測試圖的編號> --reply --report ~/ayaka-room-acceptance-report.json
   ```

3. CPU 用量。開著下面的指令，同時在瀏覽器裡把每一種操作各做幾次，再按 Ctrl+C。訪客端與管理端各做一次：

   ```bash
   npx wrangler tail ayaka-room --format json | node scripts/cpu_report.mjs --expect visitor
   ```

   ```bash
   npx wrangler tail ayaka-room-admin --format json | node scripts/cpu_report.mjs --expect admin
   ```

每一項怎麼判讀在 README 的「[部署之後的檢查](README.md#部署之後的檢查)」。結果記在 B-3、B-4。

- [ ] B-1～B-4 的必要項目全部通過；每一個「無法判定」都另外確認過。

### 階段 9：C 區：真的 iPhone，與傳送之前的泡泡確認

**這個階段不對彩花送出任何訊息。** 訪客端放的還是範例內容。

- [ ] 用真的 iPhone 的 Safari，照 ACCEPTANCE.md 的 C-1 一項一項做。每一項回報結果；有問題的附截圖（這時候頁面上是範例內容）。
- [ ] 泡泡只做 C-2 列的三件事：不送出的草稿（字數與排版，用同樣長度的假字）、既有訊息上看得到的操作、Safari 上和登入有關的確認。

要真的送出訊息才能確認的項目，以及藝人收件端，不在這個階段。它們記在 ACCEPTANCE.md 的 E 區，維持「未驗證」，也不擋下一個階段。

### 階段 10：定稿與正式內容

B 的必要項目、C-1、C-2 做完之後才開始（ACCEPTANCE.md 的總檢查）。E 區的項目不是前置條件。

- [ ] 整理定稿清單給站主確認：正式的標題與留言（日文、繁體中文）、署名、每一張合照與說明、公開網站上的入口、要寫進泡泡的訊息（分成幾則、每一則的文字）。
- [ ] 站主確認之後：刪掉範例文字、測試圖與測試回覆，在管理頁輸入正式的內容，產生正式的合言葉（驗收時那一組同時失效）。
- [ ] 公開網站的入口：把訪客端的網址填進根目錄 `data.js` 的 `site.roomUrl`。這一步會改到公開網站，照原本「先審查、站主說上線才上線」的流程處理。
- [ ] 要不要、什麼時候在泡泡送出訊息，由站主決定。只有真的送出才看得到的事（含網址的訊息送不送得出去、送出後網址能不能點），這時候才記到 ACCEPTANCE.md 的 E 區；藝人收件端維持「未驗證」。

## 五、驗收用的範例內容

這些是確認功能用的字，不是正式的內容。正式的文字由站主在階段 10 提供。

| 欄位 | 日文 | 繁體中文 |
| --- | --- | --- |
| 標題 | （サンプル）合言葉のページ | （範例）通關密語頁面 |
| 留言 | これは動作確認用のサンプル文です。本番の文章ではありません。 | 這是確認功能用的範例文字，不是正式的內容。 |
| 照片說明 | サンプルの写真 1 | 範例照片 1 |
| 署名 | SAMPLE | SAMPLE |

測試回覆請寫看得出是測試的字，例如「これは確認用のサンプルです」。確認收到之後在管理頁刪掉。

## 六、誰做什麼

| | 內容 |
| --- | --- |
| 只能由站主做 | 註冊與登入 Cloudflare、填付款資料、選方案、設定金鑰與 Access、註冊第二因子、在管理頁輸入內容、在 iPhone 與泡泡上操作、決定什麼時候放正式內容與什麼時候上線、決定要不要與什麼時候在泡泡送出訊息 |
| 可以交給協助的人（或 AI）做 | 看指令的輸出與錯誤訊息、判讀 `check_deployed.mjs` 與 `cpu_report.mjs` 的結果、把結果整理成驗收紀錄、遇到具體問題時修改程式並重新交付 |
| 不要交出去的 | 密碼、金鑰、驗證碼、合言葉、信箱；`--report` 產生的檔案裡有網址，不要 commit |

## 七、中止與復原

- 任何階段都可以停。兩個服務在沒有金鑰、沒有合言葉、或 Access 沒設定好的時候，本來就不給任何內容。
- 懷疑金鑰外流：重新執行[階段 4](#階段-4金鑰)設定新的 `PEPPER` 與 `SESSION_SECRET`。換了 `PEPPER` 之後原本的合言葉會失效，要到管理頁重新產生。
- 全部撤掉：在後台刪除兩個 Worker、D1 資料庫 `ayaka-room`、R2 儲存桶 `ayaka-room-photos`、Zero Trust 裡管理端的 Access 應用程式；把 `data.js` 的 `site.roomUrl` 改回 `null`。R2 訂閱與 Zero Trust 方案要不要取消，在後台的帳單頁處理（這部分的細節沒有查證）。

## 之後更新程式

拿到新的 bundle 之後，在部署目錄裡把新的 commit 取進來，並停在它上面：

```bash
BUNDLE=~/Downloads/<新的 bundle 檔名>
git fetch "$BUNDLE" private-backend
git checkout --detach FETCH_HEAD
git rev-parse HEAD
git status --short --branch
```

`git rev-parse HEAD` 要和新的交付說明寫的 commit 一樣；`git status --short --branch` 是 `## HEAD (no branch)`，加上兩個 `wrangler.jsonc`（之前填的 `database_id`）。

兩個 `wrangler.jsonc` 裡填的 `database_id` 是還沒提交的修改，切換時 git 會保留。它如果說這兩個檔案會被覆蓋而不肯切換，先把 `database_id` 記下來，在 `backend/` 裡用 `git checkout -- visitor/wrangler.jsonc admin/wrangler.jsonc` 還原，切換之後再填回去。

接著重新執行[階段 3](#階段-3部署兩個服務)的兩個 `deploy` 指令；金鑰、資料庫與照片都不受影響。資料表結構有新增（`migrations/` 多了檔案）時，先執行階段 2 的 `d1 migrations apply`。**重新部署之後，B 區要用新的 commit 重做一次。**
