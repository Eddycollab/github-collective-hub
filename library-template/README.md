# GitHub Collective Hub 收藏庫範本

把這個資料夾的內容放進一個**私人** GitHub repo，就是你的收藏庫。收藏網頁把收藏寫進 `inbox/`，GitHub Actions 用你的 Claude 訂閱分析後寫進 `library/`，並產生 `index.json` 與這份 README（第一次分析完成後，這份說明會被收藏目錄取代）。

## 內容

| 路徑 | 誰寫 | 用途 |
|---|---|---|
| `inbox/` | 收藏網頁 | 待分析的收藏；處理後移到 `inbox/done/` 或 `inbox/failed/` |
| `library/` | Actions | 每筆收藏的 `.md`、`.json`、（有的話）`.svg` |
| `index.json`、`README.md` | Actions | 收藏目錄 |
| `user.json` | 收藏網頁 | 你的筆記、手動標籤、最愛、狀態；Actions 只讀不寫，重新分析不會覆寫 |
| `taxonomy.yml` | 你 | 分類（模型從中選一個） |
| `tags.yml` | 你 | 用途標籤字彙（簡報類、程式類…），AI 建議標籤只會從這裡挑 |
| `.github/workflows/collective.yml` | 你 | 呼叫分析流程的 caller workflow |

## 設定步驟

1. 在 GitHub 建一個新的 **Private** repo（例如 `collective-library`），把本資料夾的所有檔案（含 `.github/`）推上去。
2. 編輯 `.github/workflows/collective.yml` 的 `uses:`：把 `<OWNER>/<REPO>` 換成你 fork 的 GitHub Collective Hub 應用程式 repo，`@` 後面換成你檢查過的那個 commit 的 **40 字元 SHA**（不要用 `main` 等分支名）。
3. 在裝了 Claude Code 的電腦執行 `claude setup-token`，到這個 repo 的 **Settings → Secrets and variables → Actions → New repository secret**，名稱填 `CLAUDE_CODE_OAUTH_TOKEN`，值貼上剛剛的 token。token 只放在這裡，不要提交進任何檔案、不要貼在聊天或 issue。
4. 建一把 fine-grained personal access token：只選這個收藏庫，權限 **Contents: Read and write**（想在網頁上看到「分析中」再加 **Actions: Read-only**）。在每台裝置的收藏網頁設定裡貼上一次；它只存在那台裝置的瀏覽器。

## Secrets 清單

| 名稱 | 放哪裡 | 用途 |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | 收藏庫 → Actions secrets | 分析時讓 Claude Code 使用你的訂閱 |
| fine-grained PAT | 只在你的瀏覽器 | 收藏網頁讀寫這個收藏庫 |

## 重新分析與失敗重試

- 收藏網頁的「重新分析」會寫一個 `"reanalyze": true` 的收藏到 `inbox/`，更新同一筆，不新增收藏紀錄。
- 也可以在 **Actions → collective → Run workflow** 填 `url`（skill 再填 `skill_path`、`ref`）。
- 分析失敗的收藏在 `inbox/failed/<id>.json`，內含錯誤訊息；把其中的 `capture` 存回 `inbox/<id>.json`（或在網頁按「重新排入」）就會重試。

## 授權

[MIT](LICENSE)
