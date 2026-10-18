// Library data for the capture and reading pages: index loading, entry reads and the merged list.
// Coupled with action/scripts/index.py (index.json shape) and publish.py (library/<stem>.md|json|svg).

export const STEM_RE = /^[a-z0-9._-]+__[a-z0-9._-]+$/;
const API = 'https://api.github.com/repos';

export const CATEGORY_LABEL = { 'agent-framework': 'Agent 框架', 'mcp-server': 'MCP 伺服器', 'dev-tool': '開發工具',
  'model-inference': '模型推論', 'data-processing': '資料處理', frontend: '前端', infrastructure: '基礎設施', game: '遊戲',
  'desktop-app': '桌面應用', other: '其他' };

// Category names come from a user-edited taxonomy and from index.json, so never read inherited members.
export function categoryLabel(key) {
  return Object.hasOwn(CATEGORY_LABEL, key) ? CATEGORY_LABEL[key] : String(key ?? '');
}

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
