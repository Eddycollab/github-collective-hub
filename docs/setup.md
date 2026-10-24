# 安裝與部署（Windows）

2026-10-24。這份文件帶你從本機預覽走到真正上線。**token 和 secret 只放在下面指定的位置，不要貼到聊天、issue 或任何檔案。**

## 0. 需要的工具

| 工具 | 用途 | 檢查指令 |
|---|---|---|
| Git | 版本控制 | `git --version` |
| Python 3.10+ 與 PyYAML | pipeline 與測試 | `python -c "import yaml"` |
| Node.js 22+ | 前端測試、本機預覽 | `node --version` |
| Chrome 或 Edge | e2e 測試、語音輸入 | — |
| Claude Code | 產生 `CLAUDE_CODE_OAUTH_TOKEN` | `claude --version` |

PowerShell 執行 Python 測試前先設定 UTF-8（上游假設 Linux 的 UTF-8 預設編碼）：`$env:PYTHONUTF8 = "1"`。

## 1. 本機預覽（不需要任何帳號）

```powershell
cd <本 repo 的本機資料夾>
node scripts/preview.mjs
```

1. 打開 <http://127.0.0.1:8080/>。
2. **只想看介面**：按「以示範資料瀏覽」。示範資料是虛構的（`collective-demo`），畫面頂端會一直標示，不會寫入或分析。
3. **想走完整流程**：在「連結收藏庫」填
   - 收藏庫：`local/collection`
   - token：任意文字（例如 `local-preview`，不會送到 GitHub）
   - 本機模擬 API：`http://127.0.0.1:8787`（這個欄位只在 localhost 出現、也只在 localhost 生效）
4. 新增收藏後，它們會停在「等待分析」，因為本機沒有 GitHub Actions。另開一個視窗執行：

   ```powershell
   $env:PYTHONUTF8 = "1"
   python scripts/fixture_analyze.py --library .preview/collection
   ```

   這會用**真正的** `items.py` 與 `publish.py` 處理收件匣，但分析內容是標明「fixture 模擬分析，不是 Claude 產出」的固定文字。重新整理網頁就會看到條目、標籤與詳情頁。加 `--fail owner/repo` 可以模擬分析失敗，練習「重新排入」。
5. 本機資料在 `repobox/.preview/collection`（已加入 `.gitignore`）；刪掉這個資料夾就重新開始。

預設會把「列出 SKILL.md／解析分支」的請求，**不帶 token** 轉給 api.github.com 查公開資料（每小時 60 次的匿名額度）；加 `--offline` 完全不連網。

## 2. 測試

```powershell
$env:PYTHONUTF8 = "1"
python -m unittest discover -s action/tests          # pipeline（含 fixture 全流程 test_flow.py）
node --test "web/tests/*.test.mjs"                    # 前端純邏輯
# e2e（Playwright）：需要 playwright-core；沒有的話先 npx playwright-core --version 讓 npx 下載
$env:PW_CORE = "<playwright-core 資料夾路徑>"
$env:PW_CHROME = "C:\Program Files\Google\Chrome\Application\chrome.exe"
node web/tests/e2e/gate.cjs       # 信任門檻（改 app.js 後必跑）
node web/tests/e2e/capture.cjs    # 收藏頁
node web/tests/e2e/read.cjs       # 詳情頁
```

## 3. 把程式碼放到你自己的 GitHub（應用程式 repo）

本機的 `repobox` 資料夾目前只有指向上游的 `upstream` remote，而且 push 已停用，不會誤推到上游。

1. 在 GitHub 建一個新 repo，例如 `github-collective-hub`。**它可以是公開的**：裡面只有程式碼、空白範本與虛構示範資料，沒有你的收藏。
2. 推上去：

   ```powershell
   git remote add origin https://github.com/<你的帳號>/github-collective-hub.git
   git add -A
   git commit -m "feat: GitHub Collective Hub"
   git push -u origin collective-hub:main
   ```

3. **Settings → Pages → Source** 選 **GitHub Actions**；到 **Actions → pages → Run workflow** 跑一次。網頁會在 `https://<你的帳號>.github.io/github-collective-hub/`。
4. 記下這次推上去的 commit 的 40 字元 SHA（`git rev-parse HEAD`），下一步要用。

### GitHub Pages 是否私人？

- **網頁本身**：免費方案的 Pages 一律公開，任何人都能打開這個網頁、看到程式碼與虛構示範資料。
- **你的收藏**：不在網頁裡。網頁用你瀏覽器裡的 token，透過 GitHub API 讀你的**私人收藏庫**；沒有 token 的人只看得到空殼。
- 建議幫網頁綁自訂子網域：同一個 `<帳號>.github.io` 底下的其他 Pages 網站可以讀到這個網頁存的 token。

## 4. 建立私人收藏庫

1. 在 GitHub 建一個 **Private** repo，例如 `collective-library`。
2. 把本 repo 的 `library-template/` 內容（含 `.github/`）放進去並推上去。
3. 編輯 `.github/workflows/collective.yml` 的 `uses:`，換成 `<你的帳號>/github-collective-hub/.github/workflows/analyze.yml@<第 3 步的 40 字元 SHA>`。**不要用 `@main`**：這個 workflow 會把收藏庫的寫入權和 Claude token 交給那份程式碼。之後改了分析流程，要手動換成新的 SHA 才會生效。

## 5. Secrets 與 token 清單

| 名稱 | 放在哪裡 | 怎麼產生 | 權限／用途 |
|---|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | 私人收藏庫 → **Settings → Secrets and variables → Actions → New repository secret** | 在裝了 Claude Code 的電腦執行 `claude setup-token`（依 Claude Code 官方文件，需要 Claude 訂閱） | 分析時讓 Claude Code 使用你的訂閱 |
| Fine-grained personal access token | **只**在每台裝置的收藏網頁設定（瀏覽器 localStorage） | GitHub 頭像 → **Settings → Developer settings → Personal access tokens → Fine-grained tokens** | Repository access 只選私人收藏庫；Permissions：**Contents: Read and write**；選用 **Actions: Read-only**（網頁才能顯示「分析中」） |

不需要其他 secret；應用程式 repo 本身不需要任何 secret。

## 6. 第一次真正收藏的檢查清單

1. 收藏網頁 → 連結收藏庫，填 `<帳號>/collective-library` 與 fine-grained token。
2. 新增收藏一個公開 repo 網址 → 收藏庫出現 `inbox/<id>.json`。
3. 收藏庫 **Actions** 出現 `collective` 執行；完成後 `library/`、`index.json`、`README.md` 更新，收件匣檔案移到 `inbox/done/`。
4. 收藏網頁重新整理，條目出現，可用標籤與搜尋找到。
5. 再收一個 SKILL.md 網址，確認 Skills 專區與 Skill 資訊。

### 這些項目只用 fixture 與單元測試驗證過，尚未在真正的 GitHub Actions 上跑過

- `analyze.yml` 的 skill 解析（`gh api` 取 commit SHA、以 SHA fetch、jq 編碼 ref／path）
- Claude Code CLI 在新版 workflow 的實際執行與輸出品質（`analyze-skill.md` 是新提示）
- publish 推回私人收藏庫（commit 與 push 重試）
- actionlint（本機 Docker 引擎沒開，未執行）
- 真實 GitHub API 的 rate limit 標頭、`matching-refs` 與 `git/trees` 回應

第一次執行請盯著 Actions 的紀錄；失敗的收藏會留在 `inbox/failed/`，網頁上可以「重新排入」。

## 7. 改用 GitHub 登入（Railway，選用）

不想在每台裝置貼 token，可以把同一份程式部署到 Railway：用 GitHub 登入，token 只放在伺服器。步驟見 [railway.md](railway.md)。GitHub Pages 版可以繼續使用。

## 8. 手機

- **Android**：用 Chrome 打開網頁 → 選單 → 加到主畫面。之後在 Threads 按分享 → 選 Collective，就會帶入網址（只有一個新 repo 時自動收藏，其他情況要你確認）。
- **iPhone／iPad**：iOS 不支援網頁加入分享選單。複製連結或貼文文字，回網頁按「新增收藏」貼上；或用「捷徑」開啟 `<網頁網址>#text=<內容>`（一律要確認）。
- **語音**：Chrome／Edge 的語音輸入會把聲音送到瀏覽器廠商的伺服器辨識；不想送出就直接貼逐字稿。
