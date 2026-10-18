# RepoBox

> CLAUDE.md（kit v4.3）。本檔只放「這個專案是什麼」——工作流、派工、
> review 規則由 `.claude/rules/` 自動載入（kit-owned，別在專案裡改）。

## Project goal

把滑到的 GitHub 專案收進自己的私人 repo，由 GitHub Actions 用自己的 Claude 訂閱寫白話介紹與架構圖。個人自用，其他人 fork 自架；不做共用網站、不代管任何人的 token。

## Stack

- Language: Python 3（pipeline）、原生 ES modules（網頁，無 build、無第三方 JS）
- Framework: none；GitHub Actions reusable workflow + GitHub Pages
- Datastore: 使用者自己的私人 GitHub repo（`library/*.md|json|svg`、`index.json`）
- Build/run: 無 build；`web/` 直接部署到 Pages，`analyze.yml` 由收藏 repo 以 SHA 呼叫
- Test: `python3 -m unittest discover -s action/tests && node --test 'web/tests/*.test.mjs'`；
  e2e：`PW_CORE=<playwright-core 路徑> [PW_CHROME=<chrome 路徑>] node web/tests/e2e/gate.cjs`（另有 capture.cjs、read.cjs）

## File layout

- `web/` — 收藏頁（index.html + app.js）、閱讀頁（read.html + read.js）、`lib/` 共用模組
- `action/scripts/` — pipeline：驗證、寫條目、索引、publish；`action/prompts/` — 給 Claude 的提示詞
- `.github/workflows/analyze.yml` — reusable workflow（plan → analyze → publish）
- `docs/specs/repobox.md` — 需求與決策的權威來源；`docs/media/` — README 用圖

## Project-specific constraints（禁區與硬規則）

- 收藏 repo 呼叫 `analyze.yml` 一律釘 40 字元 SHA，永不 `@main`——它拿得到私人 repo 寫入權與 Claude token；改了 pipeline 要手動換 SHA 才生效
- analyze job 裡的 Claude 不給 Bash／shell——runner 上 bwrap 起不來，且讀的是不可信 repo；需要執行的檢查由 workflow 跑再 `--resume` 回饋
- 存 token 的網頁不載入任何第三方 JS
- 沒過白名單的 SVG 不可經任何 blob:/data:/img URL 曝光，只顯示 rejectedNotice
- 改 `web/app.js` 後 `gate.cjs` 必須通過

**同步執法**：上面每一條「路徑型」禁區，都要把路徑同步加進
`.claude/protected-paths`（一行一個 glob，`*` 會跨目錄層級，
`src/legacy/` 結尾斜線代表整棵子樹）——PreToolUse hook 會物理擋下
對這些路徑的編輯，不再只靠模型自律。放寬或刪除任何一條需要 user
明確同意（見 kit-evolution 規則）。

## 檔案路由（需要時才讀，不用背）

| 情境 | 讀這裡 |
|------|--------|
| 卡關了 / 想宣告完成 / 猶豫要不要問 user | `.claude/docs/judgment-matrix.md` |
| 要派工給 subagent | `/kit-dispatch` skill（五種模板） |
| 要記教訓 / 查歷史教訓 / 想改 harness 檔案 | `docs/LESSONS.md`（append；動大手術前先掃一眼）/ kit-evolution 規則（自動已載入） |
| 有 spec 的功能 | `docs/specs/`（spec 是需求的唯一權威來源） |
| 要做 UI / 設計 schema / 同一 bug 連續卡 / 引入外部服務 / 定架構 | `.claude/docs/verification-signals.md`（命中哪節讀哪節） |

（review / isolation / 任務 sizing / 派工升降級 / 判斷層的規則不在
本檔——`.claude/rules/` 的 kit-workflow、kit-delegation、kit-evolution、
kit-judgment 已自動載入每個 session，直接遵守即可。）
