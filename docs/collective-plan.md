# GitHub Collective Hub：架構盤點與改編計畫

2026-10-24

本文件盤點上游 RepoBox，定義 GitHub Collective Hub 的資料契約（schema）、相容性與遷移方式。`docs/specs/repobox.md` 仍是上游決策的權威來源；本文件記錄本 fork 偏離或延伸的部分。

## 0. 基底與開發根目錄

| 項目 | 值 |
|---|---|
| 上游應用程式 | `cholateio/repobox` @ `8132ed5bcd430f9f92634396a6a67c99a89a3fb6`（2026-10-23，與需求文件觀察到的參考 commit 相同） |
| 上游收藏庫範本 | `cholateio/repobox-library-template` @ `490e85b254db122b802a908c9fccebaadb668608`（caller 釘 `analyze.yml@60e57ed6…`） |
| 開發根目錄 | 本 repo 根目錄（本機開發分支 `collective-hub`，推到你自己 repo 的 `main`） |
| remote | 上游改名為 `upstream`，push URL 設為 `DISABLED-no-push-to-upstream`；`origin` 是你自己的應用程式 repo |
| 收藏庫範本 | 本 repo 的 `library-template/`（建立你自己的私人收藏庫時複製出去） |

上游原始檢查在 Windows 上需要 `PYTHONUTF8=1`（上游假設 Linux 的 UTF-8 預設編碼）；設定後 149 個 Python 測試、24 個 Node 測試、gate.cjs 11 項全數通過。

## 1. 上游架構盤點

```
收藏網頁 (web/, GitHub Pages, 原生 ES modules, 無第三方 JS)
  ├─ 貼上連結 / Android share_target (sw.js handoff) / 書籤 (#k=nonce)
  └─ Contents API PUT ─▶ 私人收藏庫 inbox/<id>.json
                              │ push (paths: inbox/*.json)
                              ▼
caller workflow (收藏庫 .github/workflows/repobox.yml, concurrency: repobox, 釘 40 字元 SHA)
  └─ reusable workflow analyze.yml
       plan    (contents: read)  items.py 列出 inbox
       analyze (contents: read)  gh api 查 metadata → clone → Claude Code（無 Bash、--restricted、dontAsk）
                                 → out/summary.json + out/diagram.svg → validate.py / check.py → stage/ artifact
       publish (contents: write) 不跑 Claude，重驗所有 artifact → library/*.md|json|svg、README.md、index.json
                                 → 一個 commit，push 衝突 rebase 重試 3 次
                              ▼
收藏網頁讀 index.json、library/<stem>.json|svg（Contents API raw）；移除走 Git Data API 單一 commit
```

| 檔案 | 職責 | 本次影響 |
|---|---|---|
| `action/scripts/items.py` | 驗證 inbox 收藏、產生 matrix | 支援 capture v2（item_type、target、reanalyze） |
| `action/scripts/entry.py` | 條目 .md/.json 讀寫、以 repo_id 查重、sightings | 改以身分鍵查重；record v2；sightings 保留分享文字／逐字稿 |
| `action/scripts/index.py` | README.md、index.json | index v2（item_type、skill、標籤字彙） |
| `action/scripts/publish.py` | 重驗 artifact、寫入、commit/push | 以身分鍵分組；驗證 target.json；重新分析不新增 sighting |
| `action/scripts/validate.py` | summary schema、SVG 白名單 | summary 分 repository／skill 兩種；SVG 白名單不變 |
| `action/scripts/prompt.py`、`action/prompts/` | 提示模板 | 新增 `analyze-skill.md`，模板帶版本號 |
| `action/scripts/taxonomy.py` | 分類 | 新增 `agent-skill` 分類；新增用途標籤 `tags.py` |
| `.github/workflows/analyze.yml` | plan → analyze → publish | skill 解析 ref/commit、只把 skill 目錄交給 Claude |
| `web/app.js`、`index.html` | 收藏頁 | 改為 Collective Hub：側欄、多標籤、搜尋、候選確認、語音 |
| `web/read.js`、`read.html` | 閱讀頁 | 詳情頁：skill 欄位、來源、筆記、標籤採用、重新分析 |
| `web/lib/library.mjs` | index 讀取、移除 | user.json、inbox 狀態、寫入重試 |
| `web/sw.js`、`manifest.webmanifest` | 分享 handoff | 名稱與配色；handoff 機制不變 |

上游安全限制全數保留（見第 6 節）。

## 2. 收藏類型與身分

`item_type`（收藏內容類型）與 `tags`（用途標籤）分開。

| item_type | target | 身分鍵 `key` | 檔名 `stem` |
|---|---|---|---|
| `repository` | `{repo: "owner/repo", ref: null, path: null}` | `repository:owner/repo`（小寫） | `owner__repo`（與上游相同） |
| `skill` | `{repo: "owner/repo", ref: "main" 或 null, path: "skills/pdf"}` | `skill:owner/repo:skills/pdf`（owner/repo 小寫，path 保留大小寫） | `owner__repo--skill--<slug>-<h6>` |

- `path` 是含 `SKILL.md` 的資料夾，相對 repo 根目錄；根目錄的 skill 用空字串 `""`。允許字元 `[A-Za-z0-9._@+ -]`，以 `/` 分段，不可有 `.`、`..`、空段、反斜線，最長 200。
- `ref` 是來源的可移動 ref（分支或 tag 名稱，可含 `/`）；`null` 表示預設分支。**ref 不屬於身分**：同一個 skill 路徑換分支再收，視為同一筆（更新 ref、追加 sighting）。分析時解析出的 `commit_sha` 記在 `resolved`，讓分析可追溯。
- `<slug>` = path 轉小寫、非 `[a-z0-9]` 的連續字元換成 `-`、去頭尾 `-`、最長 40，空的話用 `root`；`<h6>` = `sha256(key)` 的前 6 個十六進位字元。stem 仍符合上游 `STEM_RE`。
- 一個 repo 內多個 SKILL.md 各自是一筆；repository 與其 skills 也是不同筆。
- repo 改名或轉移：既有條目以 `repo_id`（＋ item_type、path）找到，沿用舊 stem 與舊 key。

### 網址正規化（前端 `web/lib/github-url.mjs`）

- 只接受 host 完全等於 `github.com`／`www.github.com`；只拆白名單轉址（`l.threads.com` 等，沿用上游）。
- 去除 query、fragment、尾斜線、`.git`；保留路徑判斷類型。
- `github.com/o/r/blob/<ref…>/<path>/SKILL.md` → skill（path = SKILL.md 所在資料夾）
- `github.com/o/r/tree/<ref…>/<path>` → skill 候選（資料夾，需確認裡面有 SKILL.md）
- **含斜線的 branch 不靠固定 URL segment 猜**：`<ref…>/<path>` 的切法先標成「待解析」，有 token 時呼叫 `GET /repos/o/r/git/matching-refs/heads/<第一段>`（與 tags）找最長且為前綴的 ref；查不到或沒有連線時列出可能切法讓使用者選。40 字元 SHA 直接視為 ref。
- `github.com/o/r`（及 issues、pulls 等子頁）→ repository。

## 3. 資料格式

### 3.1 收藏：`inbox/<id>.json`（capture v2）

```json
{
  "v": 2,
  "item_type": "skill",
  "url": "https://github.com/owner/repo",
  "target": { "repo": "owner/repo", "ref": "main", "path": "skills/pdf" },
  "source_url": "https://github.com/owner/repo/tree/main/skills/pdf",
  "captured_at": "2026-10-24T10:22:33+08:00",
  "source": "threads",
  "post_url": "https://www.threads.com/@someone/post/abc",
  "share_text": "分享內文…",
  "transcript": "",
  "note": "",
  "tags": ["程式類"],
  "reanalyze": false,
  "client": "collective@1"
}
```

| 欄位 | 必填 | 限制 |
|---|---|---|
| `v` | ✓ | `1`（上游格式，視為 repository）或 `2` |
| `item_type` | v2 ✓ | `repository`／`skill` |
| `url` | ✓ | 正規化後的 repo 網址 `https://github.com/owner/repo` |
| `target` | v2 ✓ | `target.repo` 必須與 `url` 相同（不分大小寫）；skill 的 `path` 必填（可為 `""`） |
| `captured_at` | ✓ | ISO 8601 |
| `source` | | `github`、`threads`、`voice`、`friend`、`other`（上游舊值 `x`、`youtube`、`manual`、網域名稱照存） |
| `post_url` | | 原貼文／影音網址，≤ 500 |
| `share_text` | | 使用者貼上的分享內文，≤ 4000 |
| `transcript` | | 使用者確認過的逐字稿，≤ 8000 |
| `note`、`tags` | | ≤ 500 字；≤ 10 個、每個 ≤ 20 字 |
| `reanalyze` | | `true` = 強制重新分析同一筆，不追加 sighting |

`id` 格式沿用上游 `YYYYMMDD-HHMMSS-xxxx`，前端改用 8 個十六進位亂數；PUT 遇到 422（檔案已存在）換新 id 重送，兩台裝置同時收藏不會互相覆蓋。

### 3.2 分析輸出 `out/summary.json`（由 `validate.py` 驗證）

共同欄位（兩種類型都有）：

| 欄位 | 限制 | 性質 |
|---|---|---|
| `tagline` | 4–20 字、含中文 | 摘要（一句話介紹） |
| `intro` | 30–300 字、含中文 | 摘要 |
| `problem` | 10–200 字、含中文 | 摘要（解決什麼問題） |
| `requirements` | 1–4 行、每行 2–100 字 | 來源事實（使用門檻：平台／需要準備／費用／限制） |
| `summary` | 20–600 字 | 摘要（技術說明） |
| `category` | taxonomy 之一 | 分類 |
| `tags` | ≤ 5，小寫英數 | 關鍵字（上游欄位） |
| `stack` | repository 1–8；skill 0–8 | 來源事實 |
| `highlights` | repository 2–3；skill 1–3，每句 10–120 字 | 摘要 |
| `suggested_tags` | 0–4，必須在用途標籤字彙內 | **推論**：AI 建議標籤，等使用者採用 |
| `fit` | 1–3 句，每句 10–150 字 | **推論**：適合 Eddie 的應用建議 |

repository 另有 `examples`（1–2 句，10–120 字）。

skill 另有：

| 欄位 | 限制 |
|---|---|
| `triggers` | 1–4，觸發情境，每項 4–120 字 |
| `inputs`、`outputs` | 各 0–4，每項 2–100 字 |
| `compatible_tools` | 0–4，只能是 `Claude Code`、`Claude.ai`、`Claude API`、`Codex`、`其他`，**只列來源明確寫到的**；空陣列 = 相容性未確認 |
| `dependencies`、`permissions` | 各 0–6，每項 2–100 字（權限：需要的檔案、網路、shell、外部服務） |
| `install` | 0–4，每項 2–160 字，只轉述來源寫的安裝方式 |

skill 的名稱、description、license 由腳本從 `SKILL.md` frontmatter 取出（來源事實），不由模型產生。

### 3.3 分析 job → publish 的 stage 檔

沿用上游 `status.json`（8 個欄位）、`meta.json`、`run.json`、`summary.json`、`diagram.svg`、`check.txt`，新增：

```json
// stage/target.json —— 解析成功就寫，publish 全欄位重驗
{ "item_type": "skill", "repo": "Owner/Repo", "repo_id": 123, "default_branch": "main",
  "ref": "main", "commit_sha": "<40 hex>", "path": "skills/pdf",
  "skill": { "name": "pdf", "description": "…", "license": "Apache-2.0" } }
```

publish 重驗：`repo_id == meta.id`、`repo == meta.full_name`、sha 為 40 位十六進位、ref／path 符合文法；收藏來自 inbox 時，`path` 必須等於 capture 的 `target.path`、`ref` 必須等於 capture 的 ref（capture 沒指定 ref 時等於 `default_branch`）。

### 3.4 條目 `library/<stem>.json`（record v2）

```json
{
  "schema_version": 2,
  "id": "owner__repo--skill--skills-pdf-1a2b3c",
  "key": "skill:owner/repo:skills/pdf",
  "item_type": "skill",
  "repo": "Owner/Repo", "repo_id": 123, "url": "https://github.com/Owner/Repo",
  "description": "…", "language": "Python", "stars": 10, "stars_at": "2026-10-24", "license": "MIT",
  "target": { "repo": "Owner/Repo", "ref": "main", "path": "skills/pdf" },
  "resolved": { "ref": "main", "commit_sha": "…", "default_branch": "main" },
  "skill": { "name": "pdf", "description": "…", "license": "Apache-2.0", "path": "skills/pdf",
             "url": "https://github.com/Owner/Repo/blob/<sha>/skills/pdf/SKILL.md" },
  "category": "agent-skill", "tags": [], "stack": [],
  "tagline": "…", "intro": "…", "problem": "…", "requirements": [], "summary": "…", "highlights": [],
  "triggers": [], "inputs": [], "outputs": [], "compatible_tools": [], "dependencies": [],
  "permissions": [], "install": [],
  "suggested_tags": ["程式類"], "fit": ["…"],
  "sightings": [{ "id": "…", "at": "…", "source": "threads", "note": "", "post_url": "…",
                  "share_text": "…", "transcript": "", "source_url": "…", "tags": ["程式類"] }],
  "capture_tags": ["程式類"],
  "created_at": "…", "updated_at": "…", "analyzed_at": "…",
  "analysis": { "version": "skill-v1", "status": "succeeded", "model": "…", "turns": 12,
                "wall_s": 300, "rounds": 0, "diagram": true }
}
```

- 只有 publish 會寫這個檔；**使用者筆記、手動標籤、最愛、狀態不在這裡**，所以重新分析不可能覆寫它們（見 3.6）。
- `.md` 照上游：frontmatter 只放人看的欄位，auto 標記之間由 Action 產生，end 標記之後手寫內容逐 byte 保留。skill 的 .md 多一段「Skill 資訊」。

### 3.5 `index.json`（index v2）

```json
{ "schema_version": 2, "generated_at": "…", "count": 2,
  "categories": [{ "name": "agent-skill", "definition": "…" }],
  "tag_vocabulary": [{ "name": "簡報類", "definition": "…" }],
  "entries": [{ "schema_version": 2, "id": "…", "key": "…", "item_type": "skill",
                "repo": "…", "repo_id": 1, "url": "…", "description": "…", "tagline": "…", "intro": "…",
                "problem": "…", "requirements": [], "language": "…", "stars": 1, "license": "…",
                "category": "…", "tags": [], "stack": [], "suggested_tags": [], "capture_tags": [],
                "skill_name": "…", "skill_path": "…", "ref": "…", "commit_sha": "…",
                "sources": ["threads"], "analyzed_at": "…", "first_seen": "…", "last_seen": "…",
                "updated_at": "…", "analysis_version": "…", "sightings_n": 1,
                "md": "library/<stem>.md", "svg": "library/<stem>.svg" }] }
```

上游 v1 的 index（沒有 `schema_version`）前端照樣讀，全部視為 repository。

### 3.6 使用者資料 `user.json`（收藏庫根目錄，只由前端寫）

```json
{ "schema_version": 1, "updated_at": "…",
  "items": { "skill:owner/repo:skills/pdf": {
      "tags": ["程式類", "教育應用"], "note": "…", "favorite": true,
      "status": "in_use", "updated_at": "…" } } }
```

- `status`：`to_analyze`（待分析）、`analyzed`（已分析）、`in_use`（使用中）、`archived`（封存）。沒設定時由前端推導：有分析結果 = 已分析，否則待分析。
- **分析工作狀態另列**：`queued`（檔案在 `inbox/`）、`running`（token 有 Actions 讀取權限且有進行中的 run 時才顯示，否則顯示「排隊中」）、`succeeded`（有 record）、`failed`（`inbox/failed/<id>.json`）。兩者不混用。
- 手動標籤：使用者還沒編輯前，顯示收藏當下帶的標籤（`capture_tags`）；第一次編輯後以 `user.json` 為準。AI 建議標籤（`suggested_tags`）分開顯示，按「採用」才加進手動標籤。
- 寫入用 Contents API 帶 `sha`；409／422 時重新讀取、以 key 為單位合併後重送（最多 3 次）。
- pipeline 只讀 `user.json`（把使用者自訂的標籤加進建議字彙），從不寫入；publish 的 `git add` 不包含它。

### 3.7 用途標籤 `tags.yml`

```yaml
tags:
  - name: 簡報類
    definition: 製作、生成、轉換或展示簡報與投影片
  - name: 程式類
    definition: 寫程式、開發流程、程式碼品質與開發者工具
  - name: 語音類
    definition: 語音辨識、語音合成、錄音與逐字稿
  - name: AI 工具
    definition: 以 AI 模型為核心的工具、agent 與工作流程
  - name: 設計資源
    definition: 視覺設計、UI、圖示、字型與設計系統
  - name: 教育應用
    definition: 教學、學習、課程與教育平台
```

缺檔或格式錯誤時用預設值；使用者可自行新增。taxonomy（`category`，單選、模型分類）保留上游用法並新增 `agent-skill`。

## 4. 流程

### 4.1 收藏入口

| 入口 | 行為 |
|---|---|
| GitHub 網址 | 正規化、去追蹤參數、查重（index＋inbox＋本機紀錄）；可補介紹（備註）與標籤 |
| Threads／分享文字 | 貼上內文＋來源連結 → 擷取全部 GitHub 網址 → 列候選（重複的標示並預設不勾）→ 確認後各寫一個 capture。只有 Threads 網址沒有內文時，提示貼上內文，不假裝讀到貼文 |
| 語音 | 貼上逐字稿，或用瀏覽器 Web Speech API 口述（處理不支援、拒絕權限、停止、取消）；使用者確認／修改文字後才擷取網址。不從專案名稱猜 repo |
| Android 分享 | manifest `share_target` → sw.js handoff（沿用上游）。只有在已安裝 App 視窗、且只有一個非重複 repository 時才自動寫入；多個網址或 skill 一律列候選 |
| 電腦書籤 | 在 github.com 帶 nonce（可自動寫入）；在其他網站只帶選取文字與網址、**不帶 nonce**（避免頁面腳本攔截 nonce），一律要確認 |
| iOS | 沒有 Web Share Target：用 Safari 分享 → 拷貝，回收藏頁貼上；或捷徑（Shortcuts）開 `<網址>#text=<內容>`，一律要確認 |

分享內容只當資料解析網址，裡面任何文字都不會被當成操作指令。

### 4.2 分析（Actions）

- plan：`items.py` 讀 inbox v1/v2，matrix item = `{id, item_type, url, repo, ref, path, force}`；`reanalyze: true` → `force`。
- analyze：
  - repository：沿用上游（metadata、只收公開 repo、淺層 clone、刪除 agent 設定與 symlink）。
  - skill：`gh api` 取 metadata → 解析 ref（未指定用 default_branch）→ `commits/<ref>` 取 commit SHA → 確認 `<path>/SKILL.md` 存在（≤ 256 KB）→ 解析 frontmatter → 以 SHA 淺層 fetch → **只把 skill 資料夾**加上 repo 的 README／LICENSE 複製到 `$TARGET` 交給 Claude。
  - 查重：`target.py lookup` 以 `(item_type, repo_id, path)` 找既有條目；已存在且非 `force` 只記 sighting。
  - 提示：`analyze.md`（repository-v2）、`analyze-skill.md`（skill-v1）；兩者都標明內容是不可信資料，skill 裡的指令絕不遵循、不執行、不安裝。圖為選配：repository 適合時畫架構圖，skill 有多步驟流程時畫使用流程圖。
  - 驗證：`validate.py summary --item-type <t> --vocab <tags.yml>`；SVG 過 `check.py` 與白名單，不過就不附圖。
- publish：以身分鍵分組（同一批同一筆合併 sighting、挑有圖的結果）；`reanalyze` capture 不追加 sighting；寫入 record v2、README、index v2；一個 commit。

### 4.3 前端狀態

| 狀況 | 顯示 | 恢復方式 |
|---|---|---|
| 401 | token 失效 | 設定重新貼上 |
| 403 + `x-ratelimit-remaining: 0` | API 限流，顯示重設時間 | 時間到再試（按鈕） |
| 403／404 | token 沒有收藏庫權限或找不到 | 檢查設定 |
| 寫入 409／422 | 衝突 | 自動重讀合併重送，仍失敗顯示重試 |
| 分析失敗 | `inbox/failed` 的錯誤訊息 | 「重新排入」把 capture 寫回 inbox |
| SVG 未過白名單 | 不顯示圖，只顯示提示與原檔連結 | 重新分析 |

## 5. 相容性與遷移

| 對象 | 相容方式 | 遷移 |
|---|---|---|
| capture v1 | `items.py`／publish 照收，視為 repository | 不需要 |
| 上游 record（無 `schema_version`） | `read_record` 補上 `schema_version: 2`、`id`、`key`、`item_type: repository`、`target` | 下次寫入（新 sighting 或重新分析）自動升級；或執行 `python action/scripts/migrate.py --library <收藏庫>/library`（預設只預覽，加 `--write` 才寫） |
| 上游 index.json | 前端照讀 | 下一次 publish 重產 |
| 上游 caller workflow | 輸入 `url` 保留 | 把 `uses:` 換成你 fork 的 repo 與新 SHA；可選擇新增 `skill_path`、`ref` 輸入 |
| `taxonomy.yml` | 不變 | 想用 skill 分類就加上 `agent-skill` |
| 瀏覽器 localStorage | key 從 `repobox.*` 改為 `collective.*`，第一次開啟時讀舊值搬過來 | 自動 |

## 6. 安全限制（沿用上游，並延伸到 skill）

- Claude 不給 Bash／shell、不掛 MCP、`--restricted` ＋ `dontAsk` ＋ 讀寫白名單；陌生 repo 與 skill 內容只當資料。
- skill 內容絕不遵循、不執行 scripts、不安裝；前端也不提供「安裝這個 skill」的動作，只顯示來源寫的安裝說明。
- 模型輸出由不跑 Claude 的 publish job 重驗後才寫入；SVG 白名單前後端各驗一次，未通過不經任何 blob:/data:/img 曝光。
- Actions：頂層 `contents: read`，只有 publish 提升為 write；caller 保留 `concurrency`；所有 `uses:` 釘 40 字元 SHA。
- Claude 授權只放收藏庫的 Actions Secret `CLAUDE_CODE_OAUTH_TOKEN`；GitHub token 只在使用者瀏覽器 localStorage，只送 `api.github.com`，不進網址、console、Git、日誌。前端不載入第三方 JS。
- Web Speech API 在 Chrome 會把語音送到瀏覽器廠商的伺服器辨識，介面上明確告知；不想送出就改貼逐字稿。
- 本機預覽的模擬 API 只在 `localhost`／`127.0.0.1` 頁面、且目標也是本機時才允許，token 不可能被導到其他網域。

## 7. 示範資料與本機預覽

- 未連結收藏庫時可開「示範模式」：讀 `web/demo/` 的固定資料，畫面頂端常駐「示範資料」標示；寫入一律拒絕並說明，不假裝送出、不假裝分析、不顯示星數。
- `node scripts/preview.mjs`：啟動靜態伺服器與本機模擬 GitHub API（資料寫在暫存資料夾），可完整操作收藏、編輯、匯出匯入；inbox 會停在「排隊中」，因為本機沒有 Actions。
- pipeline 的完整流程由 `action/tests/test_flow.py` 以 fixture 驗證（capture → items → 模擬 analyze stage → publish → index）。

## 8. 第二階段（只有介面與需求，未實作）

- 錄音／影音檔上傳轉錄：`web/lib/transcribe.mjs` 定義 adapter 介面，目前只有「未設定提供者」實作；介面上不放上傳按鈕。需要決定提供者、費用、secret 存放位置（不可放前端），見 `docs/asr-adapter.md`。
- Codex 執行器、QR 配對、Discord：維持上游 Phase 2 清單。
