# RepoBox 閱讀頁 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 RepoBox 網頁加一個閱讀頁：電腦版一個畫面看完一筆收藏（標題欄、可互動的架構圖、這是什麼、使用門檻、分頁切換的其他內容），專案一律從收藏頁的「書庫」清單（收藏庫全部條目）點進去。

**Architecture:** 分析流程把閱讀頁要的欄位（intro、examples、requirements、summary、highlights）存進既有的隱藏 sidecar `library/<stem>.json`，`index.json` 加 `intro` 供清單用。網頁新增 `read.html`，用使用者的 token 經 GitHub Contents API（raw）讀 sidecar 與 SVG；架構圖在用戶端再過一次白名單才內嵌，做製圖動畫、燈箱縮放與節點連線高亮。收藏頁右欄從「本機收藏紀錄」改成「收藏庫書庫清單 + 本機還在分析中的項目」。純邏輯放 ES module（`web/lib/*.mjs`），用 `node --test` 在 CI 測；版面與互動用 Playwright 本機驗證。

**Tech Stack:** Python 3.12 + PyYAML（既有）；瀏覽器原生 ES modules、Web Animations API、Pointer Events，零外部 JS 依賴；Node 24 `node --test`（CI 用 runner 內建 node）；本機 Playwright（`/home/cholate/sekai-archive/node_modules/playwright-core`，不進 CI）。

**Spec:** `docs/specs/repobox.md`（§資料格式、§收藏端）；設計依據：原型 `.superpowers/proto/reader.v4.tpl.html`（https://claude.ai/artifact/P2ghcNG6cEAM6hMDJ678BB，第 4 版），本計畫的版面數值以原型為準。

## Global Constraints

- 網頁零外部 JS／CSS 依賴（token 存在這個網頁的 localStorage，任何第三方腳本都讀得到它）。
- 所有模型或 GitHub 來的文字一律 `textContent`，絕不 `innerHTML`。
- SVG 內嵌前必須通過 `web/lib/diagram.mjs` 的白名單（元素／屬性集合與 `action/scripts/validate.py` 相同）。**不通過就不顯示**：圖框只放「這張架構圖沒通過安全檢查，未顯示」與 GitHub 上原檔的連結。絕不把未通過的 SVG 位元組放進任何同源可開啟的網址（`blob:`、`data:`、`<img>`、`<object>` 都不行）：在新分頁直接打開它會變成獨立 SVG 文件並執行其中腳本，讀到 localStorage 的 token。
- 條目 stem 必須符合 `^[a-z0-9._-]+__[a-z0-9._-]+$` 才能拿來組 API 路徑。
- 設計 token 沿用收藏頁：`--paper #f4f7fb / --sheet #fff / --grid #dde6f2 / --ink #16233f / --mute #5b6b85 / --rule #c3d1e6 / --cyan #1f4fc4 / --on-ink #fff`；深色 `--paper #0e2f6b / --sheet #0b2758 / --grid #1c4486 / --ink #eaf1ff / --mute #a9bee3 / --rule #2a5598 / --cyan #9cc2ff / --on-ink #0e2f6b`。系統字型。手機側邊留白 24px。
- 電腦版（≥1000px）閱讀頁整頁不捲動；右欄在高度不足時自己捲動；分頁內容超出時底部淡出。
- 收藏頁既有的分享／書籤信任檢查邏輯不得改動；每次改 `app.js` 後重跑 9 情境 gate 測試，結果須與基準一致（A/B/D/H 待確認、C/G 各寫入一次、E 無動作、F 跳提示、I 剩 0）。
- 分析流程改動遵循既有規則：repobox main 推上後到 repobox-library 手動 bump 40 字元 SHA。
- 代碼內註解英文；commit 結尾附 session attribution。

## Review Focus

1. **網址 hash 帶進不合法的 stem**（`read.html#../../x`、`#a/b`、超長字串）→ 不得組出 API 請求，顯示「找不到這筆收藏」。Task 4 `parseStem` 測試覆蓋。
2. **token 過期或被作廢**（API 回 401/403）→ 閱讀頁與收藏頁清單顯示「token 失效，請到收藏頁重新設定」，不是空白或卡住。Task 6 Playwright 情境 (d)。
3. **新收藏庫沒有 index.json**（404）→ 收藏頁清單顯示空狀態文案，本機分析中的項目照樣列出。Task 4 `mergeLibrary` 測試 + Task 5 Playwright。
4. **SVG 沒過用戶端白名單**（舊條目或手改）→ 圖框顯示「未顯示」提示與原檔連結，頁面上不存在任何 `blob:`／`data:` 網址或 `img`/`object`/`embed`/`iframe` 指向它；閱讀頁其餘部分照常。Task 3 測試 + Task 6 情境 (e)。
5. **舊條目**：sidecar 缺閱讀欄位，或根本沒有 sidecar（`entry.read_record` 支援的舊格式）→ 閱讀頁顯示「舊格式」狀態：標題欄用 `index.json` 的資料、架構圖照常、右欄提示「重新分析後會有完整內容」，不顯示「找不到」。Task 6 情境 (f)(f2)。
6. **index.json 讀取失敗的各種原因**：404 但 repo 可存取 → 空書庫；repo 本身 404 → 「找不到收藏庫，或 token 沒有它的權限」；401 → token 失效；429／5xx／網路錯誤 → 「暫時連不到 GitHub」；200 但 JSON 壞掉或缺 `entries` 陣列 → 「書庫目錄格式錯誤」。每一種情況下本機的分析中／失敗項目都照樣列出。Task 4 + Task 5。

## 模型建議

| Task | 主模型 / effort | 理由 | 升級觸發 |
|---|---|---|---|
| 1–2 | Opus 5.5 / medium | 介面已定的 Python 擴充 + 部署 | 回填 run 失敗 |
| 3–4 | Opus 5.5 / medium | 原型已有的邏輯搬成可測模組 | 測試連續 2 次修不過 |
| 5 | Fable 5.1 / high | 動到收藏頁信任檢查所在的檔案 | gate 測試結果與基準不同 |
| 6 | Opus 5.5 / high | 版面與互動細節多，靠截圖驗證 | 1440×900 仍需捲動 |
| 7 | Opus 5.5 / low | 文件 | 無 |

---

### Task 1: 分析流程存閱讀欄位

**Files:**
- Modify: `action/scripts/entry.py`、`action/scripts/index.py`
- Test: `action/tests/test_entry.py`、`action/tests/test_index.py`、`action/tests/test_publish.py`

**Interfaces:**
- Produces:
  - `entry.READING_KEYS = ("intro", "examples", "requirements", "summary", "highlights")`；`entry.FM_KEYS` 在 `"stack"` 之後插入這五個（sidecar 欄位順序）。`DISPLAY_KEYS`（可見表格）不變。
  - `build_frontmatter(...)`：`analysis` 不是 None 時，五個欄位寫入 `to_plain` 後的值（list 逐項 `to_plain`）；dedup（`analysis is None`）時從 `prev` 沿用，`prev` 沒有就是 `None`。
  - `index.INDEX_FIELDS` 加 `"intro"`。

- [ ] **Step 1: 寫測試**：`test_record_carries_reading_fields`（`build_frontmatter(META, ANALYSIS, ...)` 的五個欄位等於 ANALYSIS 對應值經 `to_plain`）、`test_reading_fields_are_plain`（intro 含 `<b>x</b>` → 存成 `x`）、`test_dedup_keeps_prev_reading_fields`、`test_dedup_without_prev_reading_fields_is_none`、`test_display_frontmatter_hides_reading_fields`（可見表格 keys 不變）、`test_index_entries_include_intro`、`test_publish_sidecar_has_reading_fields`（publish 後讀 `owner__repo.json` 有 `intro`、`requirements`）。
- [ ] **Step 2: 跑 `python3 -m unittest discover -s action/tests` 確認新測試失敗**
- [ ] **Step 3: 實作**
- [ ] **Step 4: 全部通過**（既有 138 + 新增）
- [ ] **Step 5: Commit** `feat: store reading-page fields in the entry sidecar and intro in index.json`

---

### Task 2: 部署與回填

- [ ] **Step 1: Codex review（`review`，base = Task 1 前一個 commit）；處理發現後推 main**
- [ ] **Step 2: repobox-library 的 stub bump 成 main 的 40 字元 SHA；`grep -E 'analyze.yml@[0-9a-f]{40}$'` 命中**
- [ ] **Step 3: 依序 dispatch 重跑現有每一筆**：清單取自 `library/*.md`（不是 `*.json`，才涵蓋沒有 sidecar 的舊條目），每筆的 URL 用 `entry.read_record(md)['url']`。
  Expected: 每個 run 綠；每個 `.md` 都有對應 sidecar，且五個閱讀欄位非空；`index.json` 每筆有 `intro`。

---

### Task 3: `web/lib/diagram.mjs`（架構圖引擎）

**Files:**
- Create: `web/lib/diagram.mjs`、`web/tests/diagram.test.mjs`
- Modify: `.github/workflows/ci.yml`：push `paths` 加 `web/**`；`test` job 加 `actions/setup-node`（釘 v4 的 40 字元 commit SHA，用 `gh api repos/actions/setup-node/git/ref/tags/v4` 查，tag object 再解一層），`node-version: 22`，再跑 `node --test web/tests/`

**Interfaces:**
- Produces（ES module exports，搬自原型並改成可在 Node 測試的形式；DOM 相關函式接收 `document`／元素參數）：
  - `ELEMENTS`、`ATTRS`（Set，與 validate.py 相同）
  - `checkSvgDoc(root: Element) -> boolean`：白名單檢查（元素、屬性、`on*`、反斜線、`javascript:`/`data:`、`href` 只准 `#`、`url()` 只准 `url(#id)`）。
  - `rejectedNotice(doc: Document, githubUrl: string) -> HTMLElement`：未通過白名單時放進圖框的提示（文字 + 原檔連結），不含任何 SVG 位元組。
  - `prepareSvg(text: string, prefix: string, doc: Document) -> SVGElement | null`：DOMParser 解析 → `checkSvgDoc` → id 加前綴並改寫 `href`/`url(#)`/`aria-labelledby` → `symbol`/`marker` 內 `#1a1a1a` 改 `currentColor` → 第一個寬度等於 viewBox 的 `rect` 加 class `canvas` → 移除 width/height → 加 class `dia`。不合格回傳 `null`。
  - `endpoints(d: string) -> [[x, y], [x, y]]`：支援 M/L/H/V 絕對座標。
  - `wire(svg: SVGElement, isDrag: () => boolean) -> void`：節點點擊高亮相連節點、連線與標籤；點空白取消。
  - `draft(svg: SVGElement) -> void`：分區 → 節點 → 實線依序描繪（暫時移除 marker-end，結束後還原）、虛線淡入 → 標籤；`prefers-reduced-motion` 時不做。
  - `mountLightbox(root: HTMLElement) -> { open(svg: SVGElement): void, close(): void }`（只接受通過白名單的 SVG；未通過時圖框不可點、不開燈箱）：縮放（滾輪、雙指）、拖曳、雙擊還原、Esc 關閉；拖曳超過 6px 視為拖曳，不觸發節點點擊。
- Node 測試環境沒有 DOM：`endpoints` 與「白名單規則」抽成純函式 `attrAllowed(name: string, value: string) -> boolean`、`elementAllowed(name: string) -> boolean` 供測試；`checkSvgDoc` 只是逐節點呼叫它們。

- [ ] **Step 1: 寫 `web/tests/diagram.test.mjs`**（`node:test` + `node:assert`）：`endpoints` 對 `M276,216 H318`、`M700,632 V652 H420 V666`、`M10 10 L20 20 L30 5` 各回傳正確首尾點；`elementAllowed` 對 `script`/`foreignObject`/`image`/`style`/`a` 為 false、`g`/`use`/`marker` 為 true；`attrAllowed` 拒絕 `onload`、`style`、`href="https://x"`、`fill="url(http://x)"`、`marker-end="\75 rl(x)"`、`href="data:..."`，接受 `href="#icon-x"`、`marker-end="url(#ah)"`、`fill="#1a1a1a"`。
- [ ] **Step 2: `node --test web/tests/` 確認失敗**
- [ ] **Step 3: 實作 `diagram.mjs`**（原型 `reader.v4.tpl.html` 的 `parseSafeSvg`／`endpoints`／`wire`／`draft`／燈箱程式碼為起點）
- [ ] **Step 4: 測試通過；CI 改動推上，用一個只改 `web/` 的 commit 確認 `test` job 有觸發且綠**
- [ ] **Step 5: Commit** `feat: diagram engine module with allowlist, drafting animation and lightbox`

---

### Task 4: `web/lib/library.mjs`（資料存取與合併）

**Files:**
- Create: `web/lib/library.mjs`、`web/tests/library.test.mjs`

**Interfaces:**
- Produces:
  - `STEM_RE = /^[a-z0-9._-]+__[a-z0-9._-]+$/`；`parseStem(hash: string) -> string | null`（去掉開頭 `#`、`decodeURIComponent` 失敗或不符 STEM_RE、長度 > 200 → null）。
  - `stemOf(mdPath: string) -> string | null`（`library/<stem>.md` → stem，不符回 null）。
  - `ghRepo(cfg, fetchImpl = fetch) -> Promise<number>`：`GET https://api.github.com/repos/${cfg.repo}` 回傳狀態碼（網路錯誤 0），用來分辨 index.json 的 404 是「沒有目錄」還是「看不到 repo」。
  - `loadIndex(cfg, fetchImpl = fetch) -> Promise<{ state: 'ok' | 'empty' | 'no-repo' | 'auth' | 'unavailable' | 'bad-data', index: object | null }>`：200 → `JSON.parse`，失敗或 `entries` 不是陣列 → `bad-data`；404 → 再呼叫 `ghRepo`，對應為 200 → `empty`、404 → `no-repo`、401/403 → `auth`、其他（0、429、5xx）→ `unavailable`；index 本身 401/403 → `auth`；其他（含 0、429、5xx）→ `unavailable`。
  - `ghRaw(cfg, path: string, fetchImpl = fetch) -> Promise<{ status: number, text: string | null }>`：`GET https://api.github.com/repos/${cfg.repo}/contents/${path}`，headers 含 `Authorization: Bearer`、`Accept: application/vnd.github.raw+json`、`X-GitHub-Api-Version: 2022-11-28`；網路錯誤回 `{ status: 0, text: null }`。
  - `mergeLibrary(index: object | null, history: Array, lib: string) -> Array<Item>`：`Item = { kind: 'entry', stem, repo, intro, category, last_seen } | { kind: 'pending' | 'failed', id, repo, at }`。規則：index 的 entries（`stemOf(md)` 合格者）依 `last_seen` 降冪；history 中 `lib === lib` 且 `state` 為 `pending`／`failed`、且其 repo（不分大小寫）不在 index 裡的項目放最前面（依 `at` 降冪）；`state === 'done'` 的 history 一律忽略（index 已涵蓋）。
  - `specRows(lines: string[]) -> Array<[label: string | null, text: string]>`：`^([^：:]{1,8})[：:]\s*(.+)$` 拆標籤，否則 `[null, line]`。
  - `STATE_TEXT = { empty: '書庫還是空的。分享一個 GitHub repo 給 RepoBox，分析完會出現在這裡。', 'no-repo': '找不到收藏庫，或 token 沒有它的權限。請到設定確認收藏庫名稱與 token。', auth: 'token 失效，請到設定重新貼上。', unavailable: '暫時連不到 GitHub，稍後再試。', 'bad-data': '書庫目錄格式錯誤，下一次分析完成時會自動重建。' }`

- [ ] **Step 1: 寫測試**：`loadIndex` 用假 fetch 跑：index 200 正常、200 壞 JSON、200 但 `entries` 不是陣列、index 401、index 403、index 503、index 0；index 404 搭配 repo 200／404／401／403／429／503／0 各一（期望 empty／no-repo／auth／auth／unavailable／unavailable／unavailable）；`parseStem` 接受 `#owner__repo`、`#a-b__c.d`，拒絕 `#../x`、`#a/b`、`#A__B`（大寫）、空字串、`#%E0%A4%A`（解碼失敗）、201 字元；`stemOf`；`mergeLibrary` 四情境（index null + 1 pending → 只有 pending；pending 的 repo 已在 index → 不重複；failed 顯示在前；他庫 history 不出現）；`specRows`（`平台：Windows`、`費用: 免費`、`不需安裝`）；`ghRaw` 用假 fetch 驗證 URL、headers 與 401 傳回。
- [ ] **Step 2: 確認失敗 → 實作 → 通過**
- [ ] **Step 3: Commit** `feat: library module for index merge, stem parsing and raw API reads`

---

### Task 5: 收藏頁改用書庫清單

**Files:**
- Create: `web/tokens.css`（從 index.html 抽出 `:root` 與深色 token、body 格線背景以外的共用規則：字型、`:focus-visible`）
- Modify: `web/index.html`（`<link rel="stylesheet" href="tokens.css">`；「最近收藏」改名「書庫」，右上「開啟書庫 ↗」改「GitHub ↗」）、`web/app.js`（改為 `<script type="module">`；清單資料改用 `library.mjs`）

**Interfaces:**
- Consumes: Task 4 `mergeLibrary`、`loadIndex`、`STATE_TEXT`。
- 行為：
  - 載入時 `loadIndex(cfg)`：`ok` → 照常；其他狀態 → 清單上方顯示 `STATE_TEXT[state]`；任何狀態都把本機 pending／failed 列出（`mergeLibrary(index or null, ...)`）。
  - `entry` 項目連到 `read.html#<stem>`（同分頁開啟）；`pending` 連 Actions 頁、`failed` 連 `inbox/failed/<id>.json`（沿用既有）。
  - 既有的 `refreshStates`（逐筆查 done/failed）保留；任一筆變成 done 時重新抓 `index.json` 並重繪。
  - 空狀態文案用 `STATE_TEXT.empty`。
- [ ] **Step 1: 先寫斷言版 gate 測試 `web/tests/e2e/gate.cjs`，在未改動的 app.js 上跑一次建立基準**（`PW_CORE` 環境變數指 playwright-core 路徑；只計 `PUT`）：A/B/D/H 斷言 PUT 次數 0 且 `#status` 為「待確認」；C/G 斷言 PUT 恰 1 次且「已收」；E 斷言 0 次且「等待收藏」；F 斷言出現 `RepoBox: open a GitHub repo page first` 提示且沒有新視窗；I 斷言 handoff 快取剩 0；全程沒有 `pageerror`、console error 或 module 載入錯誤。任何一條不符 `process.exit(1)`。
  Expected: exit 0（證明斷言本身與現狀相符）。
- [ ] **Step 2: 抽 `tokens.css`，index.html 改用；截圖比對收藏頁 390×780 與 1280×800 深淺色和改動前一致（目測 + `scrollHeight == innerHeight`）；重跑 gate.cjs**
- [ ] **Step 3: app.js 改 module、接上 `library.mjs`；重跑 gate.cjs**
  Expected: exit 0，結果與 Step 1 完全相同。
- [ ] **Step 4: Playwright 情境**：index.json 200（3 筆）+ 1 筆 pending → 清單 4 列、第一列「分析中」；index 404 + repo 200 → 空書庫文案 + pending；index 404 + repo 404 → 「找不到收藏庫」文案 + pending；401 → 失效文案；503 → 暫時連不到；壞 JSON → 格式錯誤文案 + pending；點 entry → URL 變成 `read.html#xiaopuouo__openchatx-mcp`。
- [ ] **Step 5: Commit** `feat: capture page lists the whole library and links to the reading page`

---

### Task 6: 閱讀頁 `read.html`

**Files:**
- Create: `web/read.html`、`web/read.js`（module）、`web/tests/e2e/read.cjs`

**Interfaces:**
- Consumes: Task 3 全部、Task 4 `parseStem`／`ghRaw`／`loadIndex`／`specRows`／`STATE_TEXT`、`localStorage['repobox.cfg']`（與收藏頁同一份設定）。
- 版面與樣式：照原型 v4 的 `#read-view` 區塊（標題欄 5 格：repo + GitHub 連結／分類／星數／語言／收藏日；左架構圖、右 480px 欄；右欄：這是什麼 + 例如、使用門檻規格表、分頁「值得借鏡／技術摘要／技術棧」）。左上「← 收藏」連 `./`。收藏日 = sightings 最大 `at`，沒有就 `analyzed_at`。
- 資料流程：`parseStem(location.hash)` → `Promise.all([ghRaw(cfg, 'library/<stem>.json'), ghRaw(cfg, 'library/<stem>.svg'), loadIndex(cfg)])`。
  - sidecar 200 → 用 sidecar；sidecar 404 但 index 裡有這個 stem（舊格式，沒有 sidecar）→ 用 index 那筆資料進入「舊格式」狀態；兩邊都沒有 → 「找不到這筆收藏」。401/403 → `STATE_TEXT.auth`；其他錯誤 → `STATE_TEXT.unavailable`；每種錯誤頁都有「回收藏頁」連結。
  - SVG 200 且過白名單 → 內嵌；200 但沒過 → `rejectedNotice`；404 → 圖框顯示「這筆沒有架構圖」。後兩者都隱藏「點圖放大」、圖框不可點。
  - `hashchange` 時重新載入。沒有 cfg → 「先到收藏頁連結收藏庫」。
- 缺欄位：sidecar 沒有 `intro` 就整段「這是什麼」省略；三個分頁中沒有資料的分頁不顯示；閱讀欄位全部沒有（含舊格式）時右欄顯示「這筆是舊格式，重新分析後會有完整內容」，有 `requirements` 仍顯示規格表。
- `<title>`：`<repo> · RepoBox`。
- [ ] **Step 1: 寫 `web/tests/e2e/read.cjs`**（mock `api.github.com`，fixture 取 `repobox-library` 的真實 sidecar 與 svg）情境：(a) 1440×900 淺色：`scrollHeight == innerHeight`、右欄 `scrollHeight - clientHeight <= 0`、`svg.dia` 存在且有 `.node`；(b) 1280×720：整頁不捲、右欄可捲；(c) 390×844：無橫向捲動、側邊留白 24px；(d) sidecar 401 → 失效文案；(e) SVG 含 `<script>` → 圖框顯示「未顯示」提示、`document.querySelectorAll('img, object, embed, iframe').length === 0`、頁面上沒有任何元素的 `src`／`href`／`data`／`srcdoc` 屬性以 `blob:` 或 `data:` 開頭（不論 MIME 類型）、`window.__pwned` 未被設定（payload 為 `<script>window.__pwned=1</script>`）；(f) sidecar 缺 `intro`/`highlights` → 無對應區塊、無 pageerror；(f2) sidecar 404 但 index 有此 stem → 舊格式提示、標題欄顯示 repo 名、架構圖照常；(g) hash `#../x` → 「找不到這筆收藏」且沒有任何 API 請求；(h) 點圖開燈箱、點節點後有 `.lit`、Esc 關閉；(i) 深色模式截圖。
- [ ] **Step 2: 跑腳本確認失敗（頁面不存在）**
- [ ] **Step 3: 實作 `read.html`／`read.js`**
- [ ] **Step 4: 全部情境通過；九張截圖目視檢查（重點：1440×900 一屏、深色圖示清楚、手機留白）**
- [ ] **Step 5: Commit** `feat: one-screen reading page with interactive architecture diagram`

---

### Task 7: 文件與收尾

- [ ] **Step 1: 規格書**：§收藏端加「閱讀頁」小節（資料來源、一屏版面、從收藏頁進入、用戶端白名單）；§條目 sidecar 欄位加五個閱讀欄位；§Phase 2 候選移除「閱讀頁」。
- [ ] **Step 2: README「怎麼用」加閱讀頁一行。**
- [ ] **Step 3: `PROJECT.toml` status_note 更新。**
- [ ] **Step 4: 全 branch Codex review（adversarial，重點：token 頁面的新程式碼、SVG 內嵌、hash 路由）；處理發現；處理完後再跑一次 `web/tests/e2e/gate.cjs` 與 `read.cjs`（任何 app.js／read.js 改動之後都要重跑）；push main，確認 Pages 部署成功、`https://repobox.cholate.dev/read.html` 200。**
- [ ] **Step 5: Commit** `docs: reading page in spec and readme`

---

## Self-review 紀錄

- 規格覆蓋：資料欄位（Task 1）、回填（Task 2）、安全白名單（Task 3）、收藏頁入口（Task 5）、一屏版面與手機（Task 6）、文件（Task 7）。未納入：清單搜尋與分類篩選（收藏少時不需要，收藏過 30 筆再做）。
- 型別一致：`mergeLibrary` 的 `Item` 在 Task 4 定義、Task 5 消費；`STATE_TEXT`、`loadIndex`、`ghRaw` 同；`diagram.mjs` 函式在 Task 3 定義、Task 6 消費。
- Review Focus 六條各有測試（Task 4、6、4+5、3+6、6、4+5）。
- Codex round 3（2026-10-19）：補上 index 403 與 repo 403 的測試案例。
- Codex round 2（2026-10-19，只看修訂）：4 條全部採納——rejected SVG 測試改為禁止任何 `blob:`／`data:` 網址；Task 6 改用正確的 `STATE_TEXT`；`ghRepo` 各狀態碼明確對應；gate 基準移到 module 化之前。
- Codex round 1（2026-10-19）：5 條全部採納——未過白名單的 SVG 不再以任何同源網址顯示；回填改從 `library/*.md` 列舉並定義無 sidecar 的舊格式狀態；index 讀取失敗分成六種狀態（404 用 repo 查詢分辨）；gate 測試改為斷言版並在最後一次改動後重跑；CI 加 `web/**` 觸發與釘 SHA 的 setup-node。
