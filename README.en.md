# GitHub Collective Hub

[繁體中文](README.md) | **English**

Collect today's ideas for tomorrow.

When you spot a good GitHub project or AI Skill on Threads, in a friend's message or in a voice note, paste the link, the shared text or a transcript, and it lands in your own **private** GitHub repo. A few minutes later GitHub Actions uses your own Claude subscription to write a Traditional Chinese introduction, requirements, application ideas, and an architecture or usage-flow diagram.

Adapted from [cholateio/repobox](https://github.com/cholateio/repobox) (base commit `8132ed5bcd430f9f92634396a6a67c99a89a3fb6`), keeping its architecture: capture page → private library `inbox/` → GitHub Actions → Claude analysis → validated `library/` → capture page.

<p>
  <img src="docs/media/home.png" alt="Collection page: views and usage tags on the left, cards on the right (demo data)" width="72%">
  <img src="docs/media/phone.png" alt="Collection page on a phone" width="24%">
</p>

## What it does

- **Two kinds of items**: GitHub repositories (`owner/repo`) and Skills (one `SKILL.md` inside `owner/repo`; several skills in one repo are collected separately).
- **Many ways in**: paste a GitHub URL; paste Threads share text (every URL is extracted and listed for confirmation); paste a transcript or dictate; Android share sheet; desktop bookmarklet.
- **Usage tags**: 簡報類, 程式類, 語音類, AI 工具, 設計資源, 教育應用 — multi-select and extendable; AI-suggested tags stay separate from your own until you adopt them.
- **Organize**: all items, inbox, favorites, Skills, archive; search, multi-tag filters, cards/list, sort by captured or analyzed.
- **Your notes are never overwritten**: notes, manual tags, favorites and status live in the library's `user.json`, which the pipeline only reads.
- **Recoverable errors**: expired token, missing permission, API rate limit, failed analysis and rejected diagrams each have a clear state and a retry.

<img src="docs/media/skill.png" alt="Skill detail: name, triggers, compatibility and install notes (demo data)" width="80%">

## How it works

```
URL / share text / voice ──► capture page ──► private library inbox/<id>.json
                                                  │ push
                        GitHub Actions: plan → analyze (Claude, no shell) → publish (re-validates)
                                                  │
                  library/*.md|json|svg, index.json ──► capture page (read with your token)
```

No database. The page can live on GitHub Pages (paste a token once per device) or on Railway (sign in with GitHub; the token stays on the server); analysis always runs in your own Actions.

## Setup

Full steps (Windows local preview, tests, GitHub Pages, private library, secrets list) are in **[docs/setup.md](docs/setup.md)** (Chinese). In short:

1. Local preview: `node scripts/preview.mjs`, open <http://127.0.0.1:8080/>, then browse the demo data or connect the local mock library.
2. Push this repo to your own GitHub and enable Pages.
3. Create a **private** library from `library-template/` and pin the caller workflow's `uses:` to a 40-character commit SHA of your repo.
4. Library Actions secret: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`).
5. On each device, paste a fine-grained token once (library repo only, Contents: Read and write).

**To sign in with GitHub instead of pasting a token on each device**, deploy to Railway: see **[docs/railway.md](docs/railway.md)** (Chinese). One service serves the page, GitHub OAuth sign-in (identity only, one allowed GitHub user id) and the library API; the library token lives only in the server's environment.

## Privacy and security

- **Public page, private collection**: GitHub Pages on the free plan is a public site, but it only holds code and fictional demo data; your items are read from the private library with the token in your browser.
- The GitHub token stays in your browser and is only sent to `api.github.com` — never in URLs, logs or git; tokens pasted into shared text are masked. The page loads no third-party code.
- Claude treats other people's code and skills as untrusted data: no shell, no network, one scratch folder; instructions inside a skill are never followed, run or installed. A separate job that never runs Claude re-validates the output before writing it.
- Diagrams pass an SVG allowlist before they are written and again before they are shown; anything that fails is not displayed.
- Dictation uses the browser's recognizer (Chrome/Edge send audio to the vendor); paste a transcript instead if you prefer. Audio file upload transcription is phase 2 and not available yet ([docs/asr-adapter.md](docs/asr-adapter.md)).

## Docs

- [docs/collective-plan.md](docs/collective-plan.md): inventory, data formats, compatibility and migration
- [docs/setup.md](docs/setup.md): install, deploy, secrets
- [docs/railway.md](docs/railway.md): Railway deployment and GitHub sign-in
- [docs/specs/repobox.md](docs/specs/repobox.md): upstream RepoBox spec (original security decisions)

## License

[MIT](LICENSE). Upstream RepoBox © cholateio; diagrams drawn by [arch-blueprint](https://github.com/cholateio/arch-blueprint).
