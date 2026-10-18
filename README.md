# RepoBox

滑 Threads、X 看到不錯的 GitHub 專案，按一下分享就收進你自己的私人 repo。幾分鐘後，你自己的 Claude 訂閱會讀完那個專案，寫好白話介紹、使用門檻、技術摘要和一張架構圖。

![閱讀頁：架構圖會一筆一筆畫出來，點圖放大後可以看元件之間怎麼連](docs/media/demo.gif)

- **收得快**：手機分享選單或電腦書籤列，一下就收進來，不用開別的 App。
- **看得懂**：「這是什麼」用白話寫，附一個實際例子；「使用門檻」列出平台、要準備什麼、要不要錢。
- **看得到架構**：每個專案都有一張架構圖，點節點就看它連到哪些元件。
- **資料是你的**：結果是 Markdown 加 SVG，存在你自己的私人 repo，GitHub、Obsidian、VS Code 都能直接讀。

<p>
  <img src="docs/media/home.png" alt="收藏頁：貼連結的框、分類索引和一句話介紹的卡片" width="72%">
  <img src="docs/media/phone.png" alt="手機版收藏頁" width="24%">
</p>

分析結果是繁體中文。

## 它怎麼運作

```
手機分享 / 書籤 ──► 你的收藏網頁 ──► 私人 repo 的 inbox/
                                         │
                       GitHub Actions + 你的 Claude 訂閱
                                         │
                     library/ 寫進介紹、使用門檻、架構圖 ──► 收藏網頁的書庫
```

沒有伺服器、沒有資料庫，也沒有共用網站。網頁是你 fork 出來的 GitHub Pages，分析跑在你自己的 GitHub Actions。

## 安裝（約 15 分鐘）

需要：GitHub 帳號、Claude Pro 或 Max 訂閱、裝好 [Claude Code](https://claude.com/claude-code) 和 [GitHub CLI](https://cli.github.com) 的電腦。

### 1. 架收藏網頁

1. Fork 本 repo。
2. 到 fork 的 **Actions** 分頁按啟用（fork 預設是關的）。
3. **Settings → Pages → Source** 選 **GitHub Actions**，再到 **Actions → pages → Run workflow** 跑一次。

網址會是 `https://<帳號>.github.io/repobox/`。建議在同一頁綁一個自訂子網域：token 存在網頁裡，同一個 `<帳號>.github.io` 底下的其他網站讀得到它。

### 2. 建收藏 repo

```sh
gh repo create repobox-library --private --add-readme
gh api repos/<帳號>/repobox/commits/main --jq .sha    # 記下這串 40 字元的 SHA
```

在 `repobox-library` 新增 `.github/workflows/repobox.yml`，把兩個 `<…>` 換掉：

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
    uses: <帳號>/repobox/.github/workflows/analyze.yml@<40 字元 SHA>
    with: { url: '${{ inputs.url }}' }
    secrets: { CLAUDE_CODE_OAUTH_TOKEN: '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}' }
```

接著在自己的終端機把 Claude 訂閱接上（token 約一年到期）：

```sh
claude setup-token                                          # 會印出一串 token
gh secret set CLAUDE_CODE_OAUTH_TOKEN -R <帳號>/repobox-library   # 貼上剛剛那串
```

`uses:` 一定要寫 commit SHA，不要寫 `@main`。這個 workflow 拿得到你私人 repo 的寫入權和 Claude token，釘死版本才不會被別人的改動牽著走。之後想更新分析流程，再手動換新的 SHA。

### 3. 每台裝置連一次

到 GitHub **Settings → Developer settings → Fine-grained tokens** 建一把 token：Repository access 只選 `repobox-library`，Permissions 只開 **Contents: Read and write**。打開收藏網頁的設定，填上收藏庫（`<帳號>/repobox-library`）和這把 token。

- **Android**：把網頁加到主畫面，分享選單就會出現 RepoBox。
- **電腦**：把網頁上的書籤按鈕拖到書籤列，在 GitHub 頁面按它。

## 日常使用

- 收進來的專案約 3–8 分鐘分析完，出現在收藏頁的書庫；點進去是閱讀頁。
- 同一個專案再收一次只記「又看到一次」，不會重跑分析。
- 想重新分析：`repobox-library` 的 **Actions → repobox → Run workflow**，填專案網址。
- 分析失敗的收藏會留在 `inbox/failed/`，檔案裡寫了原因。
- 每次分析用掉幾分鐘的 Actions 時間。GitHub 免費方案的私人 repo 每月有 2000 分鐘。

## 隱私與安全

- token 只存在你自己裝置的瀏覽器，只會送到 `api.github.com`。網頁不載入任何第三方程式碼。
- 只分析公開 repo。Claude 讀的是陌生人的程式碼，所以當成不可信資料處理：它沒有 shell、只能寫一個暫存資料夾，產出要經過另一個不跑 Claude 的 job 重新檢查才會寫進你的 repo。
- 架構圖在顯示前會再過一次白名單，有問題的圖只顯示提示，不會被執行。

## 開發

- 測試：`python3 -m unittest discover -s action/tests`、`node --test 'web/tests/*.test.mjs'`
- 網頁情境測試（需要 playwright-core）：`PW_CORE=<playwright-core 路徑> node web/tests/e2e/gate.cjs`，另有 `capture.cjs`、`read.cjs`
- 設計與決策：[`docs/specs/repobox.md`](docs/specs/repobox.md)
- 架構圖由 [arch-blueprint](https://github.com/cholateio/arch-blueprint) 繪製
