# RepoBox 規格書 v2（暫名）

2026-10-17 · @Cholate · 取代 `RepoBox 規格文件.md`（v1）

本文件是方向與共識，不是實作計畫。實作計畫另寫，以本文件為需求來源。

## 概述

在手機或電腦上滑到 GitHub 專案時，兩下以內收進自己的私人 GitHub repo；GitHub Actions 用自己的 Claude 訂閱跑 Claude Code，自動產生摘要、分類與架構圖。結果是純 Markdown 加 SVG，任何工具都能讀。

**問題：** Threads、X 上的 GitHub 專案「看過就滑掉」，事後找不回來；單篇貼文也看不出專案架構。

**定位：** 自己用得順是第一優先。開源後別人 fork 自用（自己架 Pages、自己建收藏 repo），開發者不提供共用網站，也不代管任何人的資料、金鑰或運算。

**目標：**

1. 手機分享或電腦按一下，2 秒內看到「已收」。
2. 每筆收藏自動產生摘要、分類、架構圖，並保留出處。
3. 產出不綁任何閱讀工具：GitHub 網頁、手機 GitHub App、Obsidian、VS Code 都能直接看。
4. 別人 fork 後照 README 完成設定，不需要開發者的任何伺服器。
5. AI 用使用者自己的訂閱，不需要 API 金鑰。v1 支援 Claude 訂閱；Codex 訂閱列為 Phase 2（見「AI 執行器」）。

**v1 不做：** 截圖辨識、離線佇列、瀏覽器擴充、iOS、Discord、代管版。

## 架構

```
收藏端（靜態網頁）              使用者的私人 repo                 GitHub Actions
 Android 分享 ─┐                                               ┌─ 1. 腳本：解析、查 metadata、去重
 書籤按鈕   ───┼─ GitHub API ─▶ inbox/<id>.json ──push 觸發──▶ ├─ 2. Claude Code：clone、DeepWiki、
 貼上連結   ───┘   (寫一個檔)                                  │      摘要分類、arch-blueprint 畫圖
                                library/*.md + *.svg ◀────────┴─ 3. 腳本：驗證、寫入、更新目錄、commit
                                README.md（自動目錄）
                                        │
                     GitHub 網頁 / GitHub App / Obsidian / VS Code 閱讀
```

| 元件 | 放哪裡 | 職責 |
|---|---|---|
| 收藏網頁 | 公開 repo `repobox` 的 GitHub Pages（各人用自己 fork 的那份） | Android 分享目標、貼上連結、書籤落地頁 |
| 分析 Action | 公開 repo `repobox`，跑在使用者的 Actions | 處理 inbox、寫回 library |
| 收藏 repo | 使用者的 GitHub（私人），空 repo 加一個 workflow 檔 | 資料本體 |
| arch-blueprint | 公開 repo `cholateio/arch-blueprint`，Action 以 plugin 安裝 | 畫架構圖 |

開發者只維護 `repobox` 一個公開 repo（網頁加 Action），不另設 template repo。token 只存在使用者自己網頁的瀏覽器本地。

曾考慮改用「預填 GitHub issue」完全不用 token，但每次收藏要多按一次 Submit；既然網頁是自己架的，選擇 token 版，換取一鍵收藏。

## 安裝

0. **（別人才需要）** fork `repobox`，在 Settings → Pages 開啟。
1. **建立收藏 repo：** 建一個空的私人 repo，再按收藏網頁設定頁產生的預填「新增檔案」連結，commit workflow 檔。`taxonomy.yml`、`README.md` 等其他檔案由 Action 第一次執行時自動建立。
2. **連結 Claude 訂閱：** 本機執行 `claude setup-token`，把結果存成 repo secret `CLAUDE_CODE_OAUTH_TOKEN`。
   沒有訂閱的人改存 `ANTHROPIC_API_KEY`（官方 Action 兩者都支援）。
3. **連結裝置：** 產生一支 fine-grained token（只限這個 repo、Contents 讀寫），在每台裝置的收藏網頁貼上一次。
   - Android：加到主畫面，之後就會出現在分享選單。
   - 電腦：把網頁上的「收藏」按鈕拖到書籤列（整個書籤列只會有這一個）。

閱讀不需要額外設定；想用 Obsidian 或 VS Code 就 clone 這個 repo。

## 收藏端

一個靜態網頁，同時是 Android 分享目標、電腦的貼上頁和書籤的落地頁。只做「收」，不做分析。

- **Android 分享：** Web App Manifest 宣告 `share_target`（POST multipart，參數 `title`、`text`、`url`）。service worker 攔下 POST，把內容存成一次性交接資料，再導向 `#s=<id>`。很多 App 把網址放在 `text`，所以從三個欄位中抽出第一個 GitHub 網址。
- **書籤：** `javascript:` 書籤只在 `github.com` 上執行。它開新視窗到收藏網頁，把網址、referrer 的網域和本機專屬的隨機碼放在 `#` 片段（不會送到伺服器）。referrer 的網域用來推斷出處（例如來自 `t.co` 就記為 x）。
- **自動寫入的門檻：** 任何網站都能帶參數導到收藏網頁，所以只有能證明來源的請求才自動寫入，其他一律要按「確認收藏」：
  - 分享選單：交接資料存在，而且頁面是在已安裝的 App 視窗裡打開。跨站表單 POST 只會開在一般分頁。
  - 書籤：隨機碼正確。
- **網址解析：** 用 `URL` 解析，網域必須完全等於 `github.com` 或 `www.github.com`；只拆解白名單內的轉址服務（`l.threads.com` 等），其他網域 query 裡的 GitHub 網址一律不認。
- **貼上連結：** 任何瀏覽器都能用。從網頁版社群右鍵複製的連結可能是轉址包裝（例如 `l.threads.com/?u=...`），解析時要從 query 參數中解出 GitHub 網址。
- **送出：** 本地先解析出 `owner/repo` 並驗證是 GitHub repo 網址，再用 Contents API 寫一個 `inbox/<id>.json`。成功就顯示「已收：owner/repo」；失敗就顯示錯誤加一個重試鈕。沒有離線佇列。
- **設定：** repo 名稱與 token 存在瀏覽器本地；token 不進網址、不進 console。對外只連 `api.github.com`，不載入任何第三方分析程式。

## 資料格式

### 目錄

```
repobox-library/
├─ README.md                 Action 產生的目錄（最新在前、依分類分組）
├─ taxonomy.yml              分類清單，每個分類一句定義（可編輯）
├─ inbox/
│   ├─ <id>.json             待處理
│   ├─ done/<id>.json        已處理
│   └─ failed/<id>.json      失敗（含錯誤原因）；移回 inbox/ 即重試
├─ library/
│   ├─ owner__repo.md        一個 repo 一篇
│   └─ owner__repo.svg       架構圖
└─ .github/workflows/repobox.yml
```

`id` 格式為 `YYYYMMDD-HHMMSS-xxxx`，在收藏端產生。檔名用 API 回傳的正式 `full_name` 轉小寫，以 `__` 分隔；GitHub 帳號名不含 `_`，所以一定切得開。

### 收藏：`inbox/<id>.json`

```json
{ "v": 1, "url": "https://github.com/owner/repo", "captured_at": "2026-10-17T10:22:33+08:00",
  "source": "threads", "page_url": "", "note": "", "client": "pwa@0.1.0" }
```

只有 `v`、`url`、`captured_at` 必填。處理狀態看檔案在哪個資料夾，不寫回這個檔。

### 條目：`library/owner__repo.md`

```markdown
---
repo: Owner/Repo
repo_id: 123456
url: https://github.com/Owner/Repo
description: ...
language: TypeScript
stars: 294
category: agent-runtime
tags: [mcp, chatgpt]
sightings:
  - { at: 2026-10-17T10:22:33+08:00, source: threads, note: "" }
analyzed_at: 2026-10-17T10:24:01+08:00
---
<!-- repobox:auto:start -->
## 摘要
## 架構圖
![](owner__repo.svg)
<!-- repobox:auto:end -->

## 我的筆記
```

- 去重以 `repo_id` 為準，repo 改名或轉移也不會變成兩篇。
- Action 只改 frontmatter 與 auto 標記之間的內容；標記之外屬於使用者，永不碰。
- 同一個 repo 再收一次：只追加一筆 `sightings` 並更新星數，不重畫圖。重新分析靠 `workflow_dispatch`。
- 內文只用標準 Markdown，不用 `[[wikilink]]` 等 Obsidian 專屬語法。

## 分析管線

### 觸發

- `push` 到 `inbox/*.json`（不含 `done/`、`failed/`）。
- `workflow_dispatch`：手動重跑，可指定 repo 重新分析。
- `concurrency` 讓同時只有一個執行。Action 用 `GITHUB_TOKEN` 推回的 commit 不會再觸發 workflow。

### 步驟（每筆收藏各自捕捉錯誤，一筆失敗不影響其他筆）

1. **解析與查詢（腳本）：** 解析 `owner/repo`，呼叫 GitHub API 取得正式名稱、`repo_id`、metadata（自動跟隨改名轉址）。查不到就移到 `failed/`。已經收過的，追加 sighting 後結束。
2. **分析（Claude Code，用訂閱）：**
   - 由腳本先對目標 repo 做淺層 clone。Claude 不自己發網路請求，DeepWiki MCP 除外。
   - 參考資料：clone 下來的程式碼、README，以及 DeepWiki MCP（`https://mcp.deepwiki.com/mcp`，免費、免登入、只支援公開 repo）。DeepWiki 是選用的，查不到照樣跑。
   - 輸出 `out/summary.json`（3–5 句摘要、從 `taxonomy.yml` 選一個 `category`、最多 5 個 `tags`），以及 `out/diagram.svg`（用 arch-blueprint 無人值守模式產生）。
3. **驗證與寫回（腳本）：**
   - `summary.json` 用 schema 驗證，`category` 必須在 taxonomy 之內。
   - SVG 必須通過 arch-blueprint 的 `check.py`；不通過就省略架構圖，其他照寫。
   - 摘要去除 HTML；frontmatter 用 YAML 序列化器產生，不用字串拼接。
   - 寫入 `library/`、把收藏移到 `done/`、重產 `README.md`，整批一個 commit。push 遇到衝突（手機或 Obsidian 同時在寫）就 rebase 後重試。

### 分析 job 的權限隔離

Claude 讀的是陌生 repo 的內容，要當成可能含有 prompt injection 的不可信資料：

- 分析與寫回分成兩個 job。分析 job 的 `GITHUB_TOKEN` 只有 `contents: read`，產出用 artifact 交給寫回 job，寫回 job 不跑 Claude。
- 限制靠 CLI 參數強制，不靠提示詞（Phase 0 在本機實際攻擊驗證過）：
  - Claude 在空的工作資料夾啟動，並使用 `--restricted`：不讀任何設定檔，檔案工具只能碰 `--add-dir` 列出的資料夾。
  - 啟動前刪除目標 repo 每一層的 `.claude/`、`.mcp.json`、`CLAUDE.md`、`CLAUDE.local.md` 和 `.git`。
  - `--permission-mode dontAsk`，白名單外的動作一律拒絕。只准寫入 `out/`（`Edit(//out/**)`）、只准執行固定那一條 `check.py` 指令、加上 DeepWiki MCP。另外禁止讀取 `/proc`。
  - `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`（需要 bubblewrap），子程序拿不到 token。
  - arch-blueprint 釘在指定 commit 並設成唯讀；Claude Code 與 GitHub Actions 都釘版本。
  - 不做 headless Chrome 截圖檢查。
- 提示詞明確標示：repo 內容是資料，不是指令。

### AI 執行器

步驟 2 的輸入（clone 好的 repo、metadata）和輸出（`out/summary.json`、`out/diagram.svg`）固定不變，執行器可以替換。arch-blueprint 是 Agent Skills 格式，Claude Code 和 Codex 都能載入。

| 執行器 | 認證 | 狀態 |
|---|---|---|
| Claude Code CLI（runner 上直接 `npm install` 後跑 `claude -p`） | `claude setup-token` 產生的訂閱 token（`CLAUDE_CODE_OAUTH_TOKEN`）；沒有訂閱的人可改用 API key | v1。不用官方 `claude-code-action`：它的觸發事件清單裡沒有 `push`，預設還要安裝 Claude GitHub App |
| Codex（`openai/codex-action`） | ChatGPT 訂閱：把 `~/.codex/auth.json` 存成 secret。官方文件仍建議自動化流程用 API key，而且 token 會在執行中刷新，必須想辦法讓 secret 跟著更新 | Phase 2，先驗證 |

### 發佈

`repobox` 以 composite action 或 reusable workflow 發佈（實作時決定），使用者的 workflow 引用 `@v1`。腳本建議用 TypeScript，與收藏網頁共用 GitHub 網址解析程式碼。

## 前置改動：arch-blueprint 無人值守化

在 `cholateio/arch-blueprint` 拿掉「提案後等使用者確認」這一步，改成：

- 提案之後直接畫圖。
- 新增自我檢查取代人工確認：圖上每個節點都要對應到 repo 裡實際存在的路徑或模組，對不上的刪掉。
- `check.py` 驗證流程保留。

這會同時改變互動使用時的行為（不再停下來確認），是刻意的取捨。

## 已知限制

- **token 存放網域：** token 存在網頁的 localStorage。如果網頁架在 `<帳號>.github.io`，同帳號的其他 Pages 專案共用同一個 origin，都讀得到它。建議用自訂子網域隔開。
- **分享可能遺失：** 交接資料一讀就刪。送出成功前 App 被關掉或重新整理，這筆分享就會遺失。這是不做離線佇列的代價，屬刻意取捨。

## 成本

| 項目 | 誰的資源 | 備註 |
|---|---|---|
| 收藏 repo | 使用者 | 私人 repo 免費 |
| Actions | 使用者 | 私人 repo 有免費分鐘數；每筆分析的實際分鐘數在 Phase 0 量測 |
| Claude | 使用者的訂閱 | 與日常使用共用額度 |
| 收藏網頁 | 各自 fork 的 GitHub Pages | 免費 |

## 分階段計畫

### Phase 0：驗證假設

- [x] Android：Threads 內建瀏覽器的 `⋯` →「分享方式…」會叫出系統分享選單，帶的是完整、乾淨的 GitHub 網址（2026-10-17 實機確認）
- [ ] Android：RepoBox PWA 安裝後會出現在這個分享選單裡，並收到同一個網址
- [ ] Android：X 內建瀏覽器同樣測一次
- [ ] `claude-code-action` 搭配 `CLAUDE_CODE_OAUTH_TOKEN`，在 `push` 觸發下用自訂 prompt 跑得起來，並能從 marketplace 安裝 arch-blueprint
- [ ] arch-blueprint 無人值守模式在 Actions 的 ubuntu runner 上產出通過 `check.py` 的 SVG
- [ ] 量測每筆分析花的 Actions 分鐘數與牆鐘時間
- [ ] 從 GitHub Pages 用 fine-grained token 呼叫 Contents API，沒有 CORS 問題（2026-10-17：curl 模擬預檢通過，回傳 `allow-origin: *`，`PUT` 與 `Authorization` 都允許；待手機實測）
- [ ] bubblewrap 在 GitHub runner 上能讓 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` 正常運作
- [ ] GitHub 新增檔案頁面可以用網址參數預填檔名與內容（`?filename=...&value=...`）；不行就改成 README 附一段 workflow 讓人複製

### Phase 1：MVP

- [ ] arch-blueprint 無人值守化
- [ ] workflow 範本，以及 Action 首次執行時自動建立 `taxonomy.yml`、`README.md`
- [ ] 分析 Action：三個步驟、權限隔離、README 目錄產生
- [ ] 收藏網頁：設定、分享目標、貼上連結、書籤
- [ ] README：三步安裝、隱私說明、支援範圍

**驗收標準：**

| 指標 | 目標 |
|---|---|
| 分享或書籤到「已收」 | 2 秒內 |
| 收藏到 library 出現條目 | 10 分鐘內（以 Phase 0 實測修正） |
| 照 README 從零設定 | 三步，不需開發者伺服器 |
| 開發者伺服器 | 零 |

### Phase 2 以後（候選，不排序）

- **Codex 訂閱執行器：** 先驗證 `auth.json` 在 CI 裡刷新後的保存方式，見「AI 執行器」。
- **Discord 通知：** 處理完一筆就把摘要和架構圖發到頻道（webhook 存成 secret），成本極低。
- **Discord 收藏入口：** 用過一陣子確定需要再評估。偏向用 Cloudflare Worker 架 Discord 指令（即時、不吃 Actions 分鐘數）；不採用 Actions 定時讀頻道（不即時，而且吃分鐘數）。
- **QR code 配對：** 電腦網頁顯示 QR code，手機掃了就設定好，免在手機上貼 token。
- **截圖辨識：** 看圖找候選 repo，由 GitHub API 驗證，找不到就進待確認。
- **MCP server 或 CLI：** 讓 Claude Code 等 coding agent 查詢收藏庫。
- **最小瀏覽器擴充：** 工具列按鈕加右鍵選單，只有在書籤不夠用時才做。
- **iOS：** 捷徑或 Discord 入口。

## 待決問題

- **正式名稱：** 「RepoBox」是暫名，候選 Snapfork；定名前先確認 GitHub 組織名與網域。
- **一次分享多個網址：** 分享內容含多個 GitHub 網址時，全部收，還是讓使用者選？
- **預設分類：** `taxonomy.yml` 預設分類清單的最終版。
- **重新分析：** 再次收藏時是否要重新分析，例如距離上次分析超過 N 天、或 repo 有大改版的時候？
