// Library data for the capture and reading pages: GitHub API access, index loading, entry reads,
// user.json edits, inbox state, capture writes and removal.
// Coupled with action/scripts/index.py (index.json shape), publish.py (library/<stem>.md|json|svg,
// inbox/done|failed) and docs/collective-plan.md §3.

export const STEM_RE = /^[a-z0-9._-]+__[a-z0-9._-]+$/;
const GITHUB_API = 'https://api.github.com';
// Server mode (server/app.mjs): same-origin proxy that adds the library token on the server side.
export const SERVER_API = '/api/gh';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export const CATEGORY_LABEL = { 'agent-framework': 'Agent 框架', 'mcp-server': 'MCP 伺服器', 'dev-tool': '開發工具',
  'model-inference': '模型推論', 'data-processing': '資料處理', frontend: '前端', infrastructure: '基礎設施', game: '遊戲',
  'desktop-app': '桌面應用', 'agent-skill': 'Agent Skill', other: '其他' };

// Category names come from a user-edited taxonomy and from index.json, so never read inherited members.
export function categoryLabel(key) {
  return Object.hasOwn(CATEGORY_LABEL, key) ? CATEGORY_LABEL[key] : String(key ?? '');
}

export const STATE_TEXT = {
  empty: '收藏庫還是空的。貼上一個 GitHub 網址或分享文字，分析完會出現在這裡。',
  'no-repo': '找不到收藏庫，或 token 沒有它的權限。請到設定確認收藏庫名稱與 token。',
  auth: 'token 失效或權限不足，請到設定重新貼上。',
  'rate-limit': 'GitHub API 用量已達上限，請稍後再試。',
  unavailable: '暫時連不到 GitHub，稍後再試。',
  'bad-data': '收藏目錄格式錯誤，下一次分析完成時會自動重建。',
  demo: '示範模式不會寫入任何資料。要真正收藏，請到設定連結你的私人收藏庫。',
};

// Server mode has no token to fix: authentication problems mean signing in again.
const SERVER_TEXT = {
  'no-repo': '伺服器連不到收藏庫：請確認伺服器的 LIBRARY_TOKEN 仍有效、且有這個收藏庫的權限。',
  auth: '登入已過期，請重新用 GitHub 登入。',
  demo: '示範模式不會寫入任何資料。要真正收藏，請到設定離開示範模式。',
};
let serverText = false;
export function useServerText(on = true) {
  serverText = on;
  Object.assign(STATE_TEXT, on ? SERVER_TEXT : TOKEN_TEXT);
}
const TOKEN_TEXT = Object.fromEntries(Object.keys(SERVER_TEXT).map((k) => [k, STATE_TEXT[k]]));

// The transport every call goes through by default; demo mode swaps it for read-only fixtures.
let transport = (...a) => fetch(...a);
export function useTransport(fn) { transport = fn || ((...a) => fetch(...a)); }
const send = (...a) => transport(...a);

// A local mock API is only honoured on a loopback page pointing at a loopback port, so a token
// can never be sent anywhere but api.github.com from a deployed page.
export function apiBase(cfg, loc = globalThis.location) {
  if (cfg && cfg.server) return SERVER_API;
  if (cfg && typeof cfg.api === 'string' && cfg.api && loc && LOOPBACK.has(loc.hostname)) {
    try {
      const u = new URL(cfg.api);
      if (u.protocol === 'http:' && LOOPBACK.has(u.hostname)) return u.origin;
    } catch { /* fall through */ }
  }
  return GITHUB_API;
}
const repoApi = (cfg, repo = cfg.repo) => `${apiBase(cfg)}/repos/${repo}`;

export function parseStem(hash) {
  let s = String(hash || '').replace(/^#/, '');
  try { s = decodeURIComponent(s); } catch { return null; }
  return s.length <= 200 && STEM_RE.test(s) ? s : null;
}

export function stemOf(mdPath) {
  const m = /^library\/([^/]+)\.md$/.exec(String(mdPath || ''));
  return m && STEM_RE.test(m[1]) ? m[1] : null;
}

function headers(cfg, accept) {
  if (cfg.server) return { Accept: accept, 'X-CSRF-Token': cfg.csrf || '' };
  return { Authorization: `Bearer ${cfg.token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
}

// GitHub answers an exhausted rate limit with 403 (or 429) and x-ratelimit-remaining: 0.
function rateOf(res) {
  const h = res && res.headers;
  if (!h || typeof h.get !== 'function') return null;
  const remaining = h.get('x-ratelimit-remaining'), reset = Number(h.get('x-ratelimit-reset'));
  return remaining === null ? null : { remaining: Number(remaining), reset: Number.isFinite(reset) ? reset * 1000 : 0 };
}
const limited = (status, rate) => (status === 429 || (status === 403 && rate && rate.remaining === 0));

// no-cache: the API answers with max-age=60, which would keep showing an entry just removed or published.
export async function ghRaw(cfg, path, fetchImpl = send) {
  try {
    const res = await fetchImpl(`${repoApi(cfg)}/contents/${path}`, { headers: headers(cfg, 'application/vnd.github.raw+json'), cache: 'no-cache' });
    const rate = rateOf(res);
    return { status: res.status, text: res.ok ? await res.text() : null, rate, limited: limited(res.status, rate) };
  } catch {
    return { status: 0, text: null };
  }
}

export async function ghRepo(cfg, fetchImpl = send) {
  try {
    return (await fetchImpl(repoApi(cfg), { headers: headers(cfg, 'application/vnd.github+json') })).status;
  } catch {
    return 0;
  }
}

const failState = (status, isLimited) => (isLimited ? 'rate-limit' : status === 401 || status === 403 ? 'auth' : 'unavailable');

// A private repo answers 404 both when index.json is missing and when the token cannot see the
// repo, so a 404 is resolved by asking for the repo itself.
export async function loadIndex(cfg, fetchImpl = send) {
  const r = await ghRaw(cfg, 'index.json', fetchImpl);
  if (r.status === 200) {
    try {
      const index = JSON.parse(r.text);
      return index && Array.isArray(index.entries) ? { state: 'ok', index } : { state: 'bad-data', index: null };
    } catch {
      return { state: 'bad-data', index: null };
    }
  }
  if (r.status === 404) {
    const repo = await ghRepo(cfg, fetchImpl);
    if (repo === 200) return { state: 'empty', index: null };
    if (repo === 404) return { state: 'no-repo', index: null };
    return { state: failState(repo), index: null };
  }
  return { state: failState(r.status, r.limited), index: null, reset: r.rate && r.rate.reset };
}

async function ghJson(cfg, method, path, body, fetchImpl, repo = cfg.repo) {
  const res = await fetchImpl(`${repoApi(cfg, repo)}${path}`, {
    method, cache: 'no-cache', headers: { ...headers(cfg, 'application/vnd.github+json'), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const rate = rateOf(res);
  return { status: res.status, data: res.ok ? await res.json() : null, limited: limited(res.status, rate), rate };
}

export class GitHubError extends Error {
  constructor(status, isLimited = false, reset = 0) {
    super(`GitHub ${status}`); this.status = status; this.limited = isLimited; this.reset = reset;
  }
}
const must = (r) => { if (!r.data) throw new GitHubError(r.status, r.limited, r.rate && r.rate.reset); return r.data; };

// One sentence a person can act on, for any GitHubError (or network failure).
export function errorText(e, action = '操作') {
  if (!e || !e.status) return `${action}失敗：${STATE_TEXT.unavailable}`;
  if (e.limited) return `${action}失敗：${STATE_TEXT['rate-limit']}${e.reset ? `（約 ${new Date(e.reset).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })} 重設）` : ''}`;
  if (e.status === 'demo') return STATE_TEXT.demo;
  if (e.status === 401) return `${action}失敗：${STATE_TEXT.auth}`;
  if (e.status === 403) return serverText ? `${action}失敗：伺服器拒絕了這個操作（登入狀態或安全檢查不符），請重新整理後再試。`
    : `${action}失敗：token 沒有這個收藏庫的寫入權限（需要 Contents: Read and write）。`;
  if (e.status === 404) return serverText ? `${action}失敗：${SERVER_TEXT['no-repo']}` : `${action}失敗：找不到收藏庫，或 token 沒有它的權限。`;
  if (e.status === 409 || e.status === 422) return `${action}失敗：資料剛被其他裝置或分析流程更新，請重試。`;
  return `${action}失敗（GitHub 回應 ${e.status}），稍後再試。`;
}

export function b64utf8(s) {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

function utf8b64(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

// --- user.json: the only file the page owns. Written with its sha; on a conflict the latest copy
// is re-read and the same patch applied again, so two devices never drop each other's edits.

export async function loadUser(cfg, fetchImpl = send) {
  const r = await ghJson(cfg, 'GET', '/contents/user.json', null, fetchImpl);
  if (r.status === 404) return { state: 'ok', doc: { schema_version: 1, items: {} }, sha: null };
  if (!r.data) return { state: failState(r.status, r.limited), doc: null, sha: null };
  try {
    const doc = JSON.parse(utf8b64(r.data.content));
    if (!doc || typeof doc !== 'object' || !doc.items || typeof doc.items !== 'object') return { state: 'bad-data', doc: null, sha: r.data.sha };
    return { state: 'ok', doc, sha: r.data.sha };
  } catch {
    return { state: 'bad-data', doc: null, sha: r.data.sha };
  }
}

// edit(doc) -> new doc. Returns the saved doc.
export async function saveUser(cfg, edit, message = 'collective: update notes', fetchImpl = send) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await loadUser(cfg, fetchImpl);
    if (cur.state === 'bad-data') throw new GitHubError(422);
    if (!cur.doc) throw new GitHubError(cur.state === 'auth' ? 401 : 0);
    const next = edit(cur.doc);
    const body = { message, content: b64utf8(JSON.stringify(next, null, 2) + '\n'), ...(cur.sha ? { sha: cur.sha } : {}) };
    const r = await ghJson(cfg, 'PUT', '/contents/user.json', body, fetchImpl);
    if (r.data) return next;
    if (r.status !== 409 && r.status !== 422) throw new GitHubError(r.status, r.limited);
  }
  throw new GitHubError(409);
}

// --- inbox: queued captures are inbox/*.json, failed ones inbox/failed/*.json ({error, failed_at, capture, raw}).

const ID_RE = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{4,8}$/;
const INBOX_READ_MAX = 40;

async function listDir(cfg, path, fetchImpl) {
  const r = await ghJson(cfg, 'GET', `/contents/${path}`, null, fetchImpl);
  if (r.status === 404) return [];
  if (!Array.isArray(r.data)) throw new GitHubError(r.status, r.limited);
  return r.data.filter((f) => f && f.type === 'file' && /\.json$/.test(f.name) && ID_RE.test(f.name.slice(0, -5)));
}

const newestFirst = (files) => [...files].sort((a, b) => (a.name < b.name ? 1 : -1)).slice(0, INBOX_READ_MAX);

export async function loadInbox(cfg, fetchImpl = send) {
  const [queuedFiles, failedFiles] = await Promise.all([listDir(cfg, 'inbox', fetchImpl), listDir(cfg, 'inbox/failed', fetchImpl)]);
  const read = async (f) => {
    const r = await ghRaw(cfg, f.path, fetchImpl);
    try { return { id: f.name.slice(0, -5), sha: f.sha, path: f.path, data: JSON.parse(r.text) }; } catch { return null; }
  };
  const queued = (await Promise.all(newestFirst(queuedFiles).map(read))).filter(Boolean)
    .map((f) => ({ id: f.id, sha: f.sha, path: f.path, capture: f.data, at: f.data && f.data.captured_at }));
  const failed = (await Promise.all(newestFirst(failedFiles).map(read))).filter((f) => f && f.data && f.data.capture)
    .map((f) => ({ id: f.id, sha: f.sha, path: f.path, capture: f.data.capture, error: String(f.data.error || ''), at: f.data.failed_at }));
  return { queued, failed };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function makeId(d, rnd = crypto.getRandomValues(new Uint32Array(1))[0]) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${rnd.toString(16).padStart(8, '0')}`;
}

export function isoLocal(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

// Each capture is its own new file, so two devices never overwrite each other; a 422 means the id
// already exists and a fresh one is tried.
export async function writeCapture(cfg, capture, label, fetchImpl = send, now = () => new Date()) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = makeId(now());
    const r = await ghJson(cfg, 'PUT', `/contents/inbox/${id}.json`, {
      message: `capture: ${label}`, content: b64utf8(JSON.stringify(capture, null, 2) + '\n'),
    }, fetchImpl);
    if (r.data) return id;
    if (r.status !== 422) throw new GitHubError(r.status, r.limited, r.rate && r.rate.reset);
  }
  throw new GitHubError(422);
}

// Retry = write the capture back under a fresh id, then drop the failed record.
export async function requeueFailed(cfg, failed, fetchImpl = send) {
  const id = await writeCapture(cfg, failed.capture, `retry ${failed.id}`, fetchImpl);
  await deleteFile(cfg, failed.path, failed.sha, `retry: ${failed.id}`, fetchImpl).catch(() => {});
  return id;
}

export async function deleteFile(cfg, path, sha, message, fetchImpl = send) {
  if (!/^inbox\/(failed\/)?[0-9]{8}-[0-9]{6}-[0-9a-f]{4,8}\.json$/.test(path)) throw new GitHubError(400);
  must(await ghJson(cfg, 'DELETE', `/contents/${path}`, { message, sha }, fetchImpl));
}

// --- public repositories being collected (not the library): refs and SKILL.md discovery.

export async function listMatchingRefs(cfg, repo, prefix, fetchImpl = send) {
  const enc = String(prefix).split('/').map(encodeURIComponent).join('/');
  const names = [];
  for (const kind of ['heads', 'tags']) {
    const r = await ghJson(cfg, 'GET', `/git/matching-refs/${kind}/${enc}`, null, fetchImpl, repo);
    if (!Array.isArray(r.data)) throw new GitHubError(r.status, r.limited);
    for (const x of r.data) if (x && typeof x.ref === 'string') names.push(x.ref.replace(/^refs\/(heads|tags)\//, ''));
  }
  return names;
}

export async function findSkills(cfg, repo, ref, fetchImpl = send) {
  const meta = must(await ghJson(cfg, 'GET', '', null, fetchImpl, repo));
  if (meta.private) throw new GitHubError(403);
  const use = ref || meta.default_branch;
  const enc = String(use).split('/').map(encodeURIComponent).join('/');
  const tree = must(await ghJson(cfg, 'GET', `/git/trees/${enc}?recursive=1`, null, fetchImpl, repo));
  return { ref: use, defaultBranch: meta.default_branch, entries: Array.isArray(tree.tree) ? tree.tree : [], truncated: Boolean(tree.truncated) };
}

// Whether the token may read Actions runs; null when it cannot (fine-grained tokens often can't).
export async function actionsRunning(cfg, fetchImpl = send) {
  try {
    const r = await ghJson(cfg, 'GET', '/actions/runs?status=in_progress&per_page=5', null, fetchImpl);
    if (!r.data) return null;
    return Array.isArray(r.data.workflow_runs) && r.data.workflow_runs.length > 0;
  } catch { return null; }
}

// --- removal

export function withoutEntry(indexText, stem) {
  const data = JSON.parse(indexText);
  const entries = (Array.isArray(data.entries) ? data.entries : []).filter((e) => !(e && stemOf(e.md) === stem));
  return JSON.stringify({ ...data, generated_at: new Date().toISOString().replace(/\.\d+Z$/, '+00:00'), count: entries.length, entries }, null, 2) + '\n';
}

// Coupled with index.py render_readme: entry lines are `- [label](library/<stem>.md) ...` and the
// header starts with `N 筆收藏` (upstream: `N 個 repo`). The next publish rebuilds README.md whole;
// this only keeps it from linking a deleted file.
export function readmeWithout(readme, stem, count) {
  const lines = readme.split('\n');
  const kept = lines.filter((l) => !l.startsWith('- [') || !l.includes(`](library/${stem}.md)`));
  if (kept.length === lines.length) return readme;
  return count === null ? kept.join('\n') : kept.join('\n').replace(/^\d+ (個 repo|筆收藏)/m, `${count} $1`);
}

// Removes one entry in a single commit: library/<stem>.{md,json,svg}, its index.json row, its README
// line and (opts.key) its user.json notes. Retries when the branch moved under it (a publish landed in
// between). Returns 'ok', or 'gone' when nothing referenced the stem any more; throws GitHubError and
// commits nothing when a read fails, so a retry can finish it.
export async function removeEntry(cfg, stem, repoName, fetchImpl = send, opts = {}) {
  if (!STEM_RE.test(stem)) throw new GitHubError(400);
  const branch = must(await ghJson(cfg, 'GET', '', null, fetchImpl)).default_branch;
  const ref = String(branch).split('/').map(encodeURIComponent).join('/');
  const read = async (path, head) => {
    const r = await ghRaw(cfg, `${path}?ref=${head}`, fetchImpl);
    if (r.status !== 200 && r.status !== 404) throw new GitHubError(r.status, r.limited);
    return r.text;
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = must(await ghJson(cfg, 'GET', `/git/ref/heads/${ref}`, null, fetchImpl)).object.sha;
    const treeSha = must(await ghJson(cfg, 'GET', `/git/commits/${head}`, null, fetchImpl)).tree.sha;
    const libDir = must(await ghJson(cfg, 'GET', `/git/trees/${treeSha}`, null, fetchImpl)).tree.find((t) => t.path === 'library' && t.type === 'tree');
    const names = libDir ? must(await ghJson(cfg, 'GET', `/git/trees/${libDir.sha}`, null, fetchImpl)).tree.map((t) => t.path) : [];
    const tree = ['md', 'json', 'svg'].map((x) => `${stem}.${x}`).filter((n) => names.includes(n))
      .map((n) => ({ path: `library/${n}`, mode: '100644', type: 'blob', sha: null }));
    const [idxText, readmeText] = [await read('index.json', head), await read('README.md', head)];
    let count = null;
    if (idxText !== null) {
      try {
        const before = JSON.parse(idxText).entries;
        if (Array.isArray(before)) {
          const content = withoutEntry(idxText, stem);
          count = JSON.parse(content).count;
          if (count !== before.length) tree.push({ path: 'index.json', mode: '100644', type: 'blob', content });
        }
      } catch { /* a malformed index is rebuilt by the next publish */ }
    }
    if (readmeText !== null) {
      const content = readmeWithout(readmeText, stem, count);
      if (content !== readmeText) tree.push({ path: 'README.md', mode: '100644', type: 'blob', content });
    }
    if (opts.key) {
      const userText = await read('user.json', head);
      if (userText !== null) {
        try {
          const doc = JSON.parse(userText);
          if (doc && doc.items && Object.hasOwn(doc.items, opts.key)) {
            const items = { ...doc.items }; delete items[opts.key];
            tree.push({ path: 'user.json', mode: '100644', type: 'blob', content: JSON.stringify({ ...doc, items, updated_at: new Date().toISOString() }, null, 2) + '\n' });
          }
        } catch { /* leave a malformed user.json alone */ }
      }
    }
    if (!tree.length) return 'gone';
    const newTree = must(await ghJson(cfg, 'POST', '/git/trees', { base_tree: treeSha, tree }, fetchImpl)).sha;
    const commit = must(await ghJson(cfg, 'POST', '/git/commits', { message: `remove: ${repoName || stem}`, tree: newTree, parents: [head] }, fetchImpl)).sha;
    const moved = await ghJson(cfg, 'PATCH', `/git/refs/heads/${ref}`, { sha: commit, force: false }, fetchImpl);
    if (moved.status === 200) return 'ok';
    if (moved.status !== 422) throw new GitHubError(moved.status);
  }
  throw new GitHubError(409);
}
// Upstream name kept for callers that still catch it.
export { GitHubError as RemoveError };

const time = (iso) => { const t = Date.parse(iso); return Number.isNaN(t) ? 0 : t; };

// Upstream list model (index entries + this device's pending/failed history), kept for read.js and tests.
export function mergeLibrary(index, history, lib) {
  const str = (v) => (typeof v === 'string' ? v : '');
  const entries = (index && Array.isArray(index.entries) ? index.entries : [])
    .filter((e) => e && typeof e === 'object' && typeof e.repo === 'string' && typeof e.md === 'string')
    .map((e) => ({ kind: 'entry', stem: stemOf(e.md), repo: e.repo, tagline: str(e.tagline), intro: str(e.intro), category: str(e.category),
      requirements: Array.isArray(e.requirements) ? e.requirements.filter((r) => typeof r === 'string') : [], last_seen: str(e.last_seen) }))
    .filter((e) => e.stem && e.repo)
    .sort((a, b) => time(b.last_seen) - time(a.last_seen));
  const known = new Set(entries.map((e) => e.repo.toLowerCase()));
  const local = (Array.isArray(history) ? history : [])
    .filter((h) => h && h.lib === lib && (h.state === 'pending' || h.state === 'failed') && !known.has(String(h.repo).toLowerCase()))
    .map((h) => ({ kind: h.state, id: h.id, repo: h.repo, at: h.at }))
    .sort((a, b) => time(b.at) - time(a.at));
  return [...local, ...entries];
}

export function specRows(lines) {
  return (lines || []).map((line) => {
    const m = /^([^：:]{1,8})[：:]\s*(.+)$/.exec(line);
    return m ? [m[1], m[2]] : [null, line];
  });
}

const OS = [['Windows', /windows/i], ['macOS', /mac\s?os|macos|\bmac\b|apple silicon/i], ['Linux', /linux/i],
  ['iOS', /\bios\b|iphone|ipad/i], ['Android', /android/i]];

// A match counts only when no negation (不支援、無法、不需、不按…) sits just before it.
const NEGATION = /(不|無|免|非|沒有|沒)[^，,。；;、]{0,3}$/;
const AFFIRMATIVE = /(無論|不論|不管|不只|不僅|不但|並非只|非只)[^，,。；;]{0,6}$/;
function positive(text, re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (const m of text.matchAll(g)) {
    const before = text.slice(Math.max(0, m.index - 6), m.index);
    if (!NEGATION.test(before) || AFFIRMATIVE.test(before)) return m.index;
  }
  return -1;
}

// Short card labels derived from the 使用門檻 lines; anything unrecognised yields no badge.
export function badges(requirements) {
  const out = [];
  for (const [label, text] of specRows(Array.isArray(requirements) ? requirements : [])) {
    if (!label && /不需安裝/.test(text)) out.push('不需安裝');
    if (label === '平台') {
      const os = OS.map(([name, re]) => [name, positive(text, re)]).filter(([, at]) => at >= 0).sort((x, y) => x[1] - y[1]).map(([name]) => name);
      if (os.length >= 3) out.push('跨平台');
      else if (os.length) out.push(...os);
      else if (positive(text, /瀏覽器|網頁|web/i) >= 0) out.push('網頁');
    }
    if (label === '費用') {
      if (positive(text, /訂閱|月費|年費/) >= 0) out.push('訂閱');
      else if (positive(text, /用量|計費|使用費|按次/) >= 0) out.push('需付模型費');
      else if (/免費/.test(text)) out.push('免費');
    }
  }
  return out.slice(0, 3);
}
