# RepoBox（暫名）

在手機或電腦上滑到 GitHub 專案時一鍵收進自己的私人 repo，由 GitHub Actions 用自己的 Claude 訂閱產生摘要、分類、值得借鏡的重點與架構圖。結果是純 Markdown 加 SVG，在 GitHub、Obsidian、VS Code 都能讀。

想用的人請 fork 自用；本專案不提供共用網站，也不代管任何資料或金鑰。設計與決策見 [`docs/specs/repobox.md`](docs/specs/repobox.md)。

## 自用安裝

1. **收藏網頁**：fork 本 repo，在 Settings → Pages 選 GitHub Actions。建議綁自訂子網域（token 存在網頁的 localStorage，`<帳號>.github.io` 底下的其他 Pages 讀得到）。
2. **收藏 repo**：建一個空的私人 repo，新增 `.github/workflows/repobox.yml`：

   ```yaml
   name: repobox
   on:
     push: { branches: [main], paths: ['inbox/*.json'] }
     workflow_dispatch:
       inputs:
         url: { description: 'GitHub repo URL to (re)analyze; empty = process inbox', required: false, default: '' }
   concurrency: { group: repobox, cancel-in-progress: false }
   permissions: { contents: write }
   jobs:
     repobox:
       uses: <你的帳號>/repobox/.github/workflows/analyze.yml@<40 字元 commit SHA>
       with: { url: '${{ inputs.url }}' }
       secrets: { CLAUDE_CODE_OAUTH_TOKEN: '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}' }
   ```

   `uses:` 一定要用 commit SHA，不要用 `@main`：這個 workflow 拿得到你私人 repo 的寫入權與 Claude token。要更新分析流程時，到這裡手動換成新的 SHA。
3. **Claude 訂閱**：在自己的終端機執行 `claude setup-token`，再執行 `gh secret set CLAUDE_CODE_OAUTH_TOKEN -R <帳號>/<收藏 repo>` 貼上（token 約一年到期）。
4. **裝置**：建一支 fine-grained token（只限收藏 repo、Contents 讀寫），在每台裝置的收藏網頁貼上一次。Android 加到主畫面後會出現在分享選單；電腦把網頁上的書籤按鈕拖到書籤列。

## 怎麼用

- 分享或按書籤 → 收藏寫進 `inbox/`，約 2–10 分鐘後 `library/` 出現條目，`README.md` 是總目錄。
- 同一個 repo 再收一次只記「又看到一次」，不重跑分析。
- 想重新分析：Actions → repobox → Run workflow，填網址。留空則處理 inbox 裡所有待處理的收藏。
- 失敗的收藏在 `inbox/failed/`，裡面寫了原因。
- 條目裡「## 我的筆記」以下是你的，Action 永遠不會改。

## 隱私

- 收藏 repo 是你的私人 repo；token 只存在你自己裝置的瀏覽器，只送往 `api.github.com`。
- 分析跑在你自己的 GitHub Actions、用你自己的 Claude 訂閱。只分析公開 repo。
- Claude 讀的是陌生 repo 的內容，當成不可信資料處理：沒有 shell、只能寫一個暫存資料夾，產出由另一個不跑 Claude 的 job 重新驗證後才寫進 repo。

## 開發

- 單元測試：`python3 -m unittest discover -s action/tests`
- workflow 檢查：`actionlint`
