# LESSONS

### 2026-10-17 GitHub Actions 的 job 層 env 不能用 runner context
- Context: RepoBox 分析 workflow，job 層 `env: WORK: ${{ runner.temp }}/work`
- Error: run 0 秒失敗、沒有任何 job：「This run likely failed because of a workflow file issue.」actionlint：`context "runner" is not allowed here`
- Solution: 改在第一個 step 用 `$RUNNER_TEMP` 寫進 `$GITHUB_ENV`
- Rule: 推 workflow 前一律跑 actionlint；0 秒失敗先懷疑 workflow 檔本身

### 2026-10-17 GitHub runner 上 Claude Code 的 Bash 沙箱起不來
- Context: `claude -p` 在 ubuntu runner 跑 check.py，開了 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`
- Error: 先是缺 socat；補上後 `bwrap: setting up uid map: Permission denied`（AppArmor 限制 unprivileged userns）
- Solution: 不給 Claude Bash，check.py 由 workflow 執行、把錯誤交回 `claude -p --resume` 修正
- Rule: CI 裡的 agent 不要依賴 Bash 沙箱；需要執行的驗證由 workflow 代跑

### 2026-10-18 reusable workflow 的 checkout 預設是觸發的 commit，排隊的執行會讀到舊狀態
- Context: 兩筆收藏相隔幾秒 push，產生兩個排隊的執行
- Error: 第二個執行重複處理第一個已搬走的檔，publish rebase 衝突在 README.md／index.json
- Solution: 所有 caller checkout 加 `ref: ${{ github.ref }}`（分支最新狀態），配合 concurrency 串行
- Rule: 會寫回 repo 的 workflow，checkout 用分支 tip 而不是 github.sha

### 2026-10-18 模型輸出的 schema 限制要寫進提示詞，並給一次修正機會
- Context: summary.json 的 highlights 限 120 字，提示詞沒寫
- Error: Claude 寫出 120+ 字的一句，整筆 5 分鐘的分析被判失敗（run 39062486874）
- Solution: 提示詞列出所有硬限制；驗證失敗時把錯誤交回同一對話修一次
- Rule: validator 擋的每一條限制，提示詞都要明寫；驗證失敗先給修正輪，不要直接丟掉整次分析
