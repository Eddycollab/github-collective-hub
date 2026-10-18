// Library data for the capture and reading pages: index loading, entry reads and the merged list.
// Coupled with action/scripts/index.py (index.json shape) and publish.py (library/<stem>.md|json|svg).

export const STEM_RE = /^[a-z0-9._-]+__[a-z0-9._-]+$/;
const API = 'https://api.github.com/repos';

export const CATEGORY_LABEL = { 'agent-framework': 'Agent 框架', 'mcp-server': 'MCP 伺服器', 'dev-tool': '開發工具',
  'model-inference': '模型推論', 'data-processing': '資料處理', frontend: '前端', infrastructure: '基礎設施', game: '遊戲',
  'desktop-app': '桌面應用', other: '其他' };

export const STATE_TEXT = {
  empty: '書庫還是空的。分享一個 GitHub repo 給 RepoBox，分析完會出現在這裡。',
  'no-repo': '找不到收藏庫，或 token 沒有它的權限。請到設定確認收藏庫名稱與 token。',
  auth: 'token 失效，請到設定重新貼上。',
  unavailable: '暫時連不到 GitHub，稍後再試。',
  'bad-data': '書庫目錄格式錯誤，下一次分析完成時會自動重建。',
};

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
  return { Authorization: `Bearer ${cfg.token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
}

export async function ghRaw(cfg, path, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${API}/${cfg.repo}/contents/${path}`, { headers: headers(cfg, 'application/vnd.github.raw+json') });
    return { status: res.status, text: res.ok ? await res.text() : null };
  } catch {
    return { status: 0, text: null };
  }
}

export async function ghRepo(cfg, fetchImpl = fetch) {
  try {
    return (await fetchImpl(`${API}/${cfg.repo}`, { headers: headers(cfg, 'application/vnd.github+json') })).status;
  } catch {
    return 0;
  }
}

const failState = (status) => (status === 401 || status === 403 ? 'auth' : 'unavailable');

// A private repo answers 404 both when index.json is missing and when the token cannot see the
// repo, so a 404 is resolved by asking for the repo itself.
export async function loadIndex(cfg, fetchImpl = fetch) {
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
  return { state: failState(r.status), index: null };
}

const time = (iso) => { const t = Date.parse(iso); return Number.isNaN(t) ? 0 : t; };

export function mergeLibrary(index, history, lib) {
  const str = (v) => (typeof v === 'string' ? v : '');
  const entries = (index && Array.isArray(index.entries) ? index.entries : [])
    .filter((e) => e && typeof e === 'object' && typeof e.repo === 'string' && typeof e.md === 'string')
    .map((e) => ({ kind: 'entry', stem: stemOf(e.md), repo: e.repo, intro: str(e.intro), category: str(e.category), last_seen: str(e.last_seen) }))
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
