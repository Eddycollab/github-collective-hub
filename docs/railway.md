# Railway 部署：GitHub 登入版

2026-10-24。這個網站只供 Eddycollab 個人使用。部署到 Railway 後，在任何裝置用 GitHub 登入就能管理收藏，不用在每台裝置貼 token。GitHub Pages 版（每台裝置貼 token）照常可用，兩者並存。

**所有憑證只放在 Railway 的 Variables，不要寫進程式、Git、聊天或 issue。**

## 架構

```
瀏覽器 ──(HttpOnly session cookie)──► Railway 服務（server/）
                                       ├─ 網頁（web/）
                                       ├─ /auth/*：GitHub OAuth 登入（只確認身分）
                                       └─ /api/gh/*：收藏 API（白名單）──LIBRARY_TOKEN──► GitHub API
                                                                                         │
                                       私人收藏庫 inbox/ ──push──► 既有 GitHub Actions + Claude 分析（不變）
```

- **登入**：GitHub OAuth App，不要求任何 scope（只讀公開身分），使用 state 與 PKCE（S256）。拿到 GitHub user ID 後立即撤銷這把登入 token，伺服器不保存它。
- **授權**：只有 `ALLOWED_GITHUB_ID`（Eddycollab = `64090020`）能取得 session；每個 `/api/*` 私人請求都會重新檢查這個 ID。用數字 ID 而不是帳號名稱，改名也不會被冒用。
- **session**：簽章的 HttpOnly cookie（https 上是 `__Host-` 前綴 + Secure + SameSite=Lax），有效 7 天，閒置 48 小時過期。登出會讓舊 cookie 立刻失效。沒有資料庫。
- **CSRF**：寫入請求要帶 `X-CSRF-Token`（由 session 衍生，只能從同源頁面讀到），而且 `Origin` 必須是本服務。
- **收藏 API**：只放行網頁實際用到的 GitHub 呼叫，也就是讀收藏庫、寫 `inbox/`、寫 `user.json`、刪除條目的那次 commit，以及唯讀查公開 repo 的 SKILL.md。改 `.github/`、強制推送、其他 repo 的寫入一律拒絕。GitHub token 只在伺服器端加上，瀏覽器看不到。
- **分析流程不變**：伺服器用 fine-grained token 寫 `inbox/<id>.json`，跟以前網頁直接寫入完全一樣，push 事件照常觸發收藏庫的 `collective` workflow。

## 1. 建立 GitHub OAuth App

1. GitHub 頭像 → **Settings → Developer settings → OAuth Apps → New OAuth App**。
2. 填寫：
   - **Application name**：`GitHub Collective Hub`
   - **Homepage URL**：先填 `https://example.com`，第 2 步拿到 Railway 網址後回來改
   - **Authorization callback URL**：先填 `https://example.com/auth/callback`，之後改成 `<Railway 網址>/auth/callback`
   - **Enable Device Flow**：不要勾
3. 建立後記下 **Client ID**。按 **Generate a new client secret**，複製 secret，**直接貼到 Railway**（第 3 步），不要另外存檔。

> 這是 OAuth App，不是 GitHub App。它不要求任何權限，只用來確認你是誰。

## 2. 建立 Railway 服務

1. Railway → **New Project → Deploy from GitHub repo** → 選 `Eddycollab/github-collective-hub`。Railway 會讀 `railway.json`，用 `Dockerfile` 建置。
2. 服務 → **Settings → Networking → Generate Domain**，得到例如 `https://collective-hub-production.up.railway.app`。
3. 回到第 1 步的 OAuth App，把 Homepage URL 和 callback URL 改成這個網址（callback 是 `…/auth/callback`）。

## 3. 設定 Variables

服務 → **Variables**，逐一新增（名稱照抄）：

| 名稱 | 值 | 說明 |
|---|---|---|
| `GITHUB_CLIENT_ID` | OAuth App 的 Client ID | |
| `GITHUB_CLIENT_SECRET` | OAuth App 的 client secret | 只放這裡 |
| `ALLOWED_GITHUB_ID` | `64090020` | Eddycollab 的 GitHub user ID，可到 `https://api.github.com/users/Eddycollab` 核對 `"id"` |
| `LIBRARY_TOKEN` | 你現有的 fine-grained token | 只限 `github-library-collection-`；Contents: Read and write，Actions: Read-only（選用，顯示「分析中」用） |
| `SESSION_SECRET` | 至少 32 字元的隨機字串 | 在自己的終端機產生：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`，複製後關掉視窗 |
| `PUBLIC_URL` | 第 2 步的 https 網址 | 不要加結尾斜線以外的路徑 |

`PORT` 由 Railway 自動提供，不用設。收藏庫固定為 `Eddycollab/github-library-collection-`。

缺少或格式錯誤時，服務不會啟動，部署紀錄只會列出**變數名稱**（不會印出值）。

## 4. 第一次登入檢查

1. 打開 Railway 網址 → 右側「請先用 GitHub 登入」→ **使用 GitHub 登入** → GitHub 授權頁（顯示沒有要求任何權限）→ 同意。
2. 回到收藏頁，左上應顯示 `Eddycollab/github-library-collection-`，既有收藏都在。
3. 收一個新網址 → 收藏庫出現 `inbox/<id>.json` → **Actions** 出現 `collective` 執行 → 完成後重新整理看到結果。
4. 用另一個 GitHub 帳號登入應看到「這個網站只供擁有者使用」，Railway 紀錄會出現 `auth: refused sign-in for GitHub user id …`。

## 日常與維護

- **登出**：設定 → 登出。這台裝置的 session 立刻失效。
- **全部裝置登出**：更換 `SESSION_SECRET`（Railway 會重新部署）。
- **token 到期**：fine-grained token 有期限。到期後收藏頁會顯示「伺服器連不到收藏庫」，到 GitHub 換新 token、更新 Railway 的 `LIBRARY_TOKEN` 即可。
- **重新部署**：程式更新推到 `main` 後 Railway 會自動部署。分析流程（`analyze.yml`）仍由收藏庫的 `uses:` SHA 決定，兩者獨立。
- **紀錄**：伺服器只記錄方法、路徑、狀態碼與耗時，不記錄查詢字串、cookie、標頭或 token。

## 本機測試

```powershell
copy .env.example .env      # 填入測試值；.env 已被 .gitignore 排除
npm run dev                 # = node --env-file=.env server/index.mjs
node --test "server/tests/*.test.mjs"
node web/tests/e2e/server.cjs   # 需要 PW_CORE／PW_CHROME，見 docs/setup.md
```

`server.cjs` 用模擬的 github.com（OAuth）與本機預覽的模擬 API 跑完整流程，不會連到真正的 GitHub。

## 尚未在真實環境驗證

- Railway 實際建置（本機 Docker 引擎未啟動，只用相同檔案配置模擬啟動）
- 真正的 GitHub OAuth 授權頁與 PKCE 交換、登入 token 撤銷
- 透過伺服器寫入 `inbox/` 後觸發 `collective` workflow（與現行網頁寫入的方式相同，預期可觸發）
