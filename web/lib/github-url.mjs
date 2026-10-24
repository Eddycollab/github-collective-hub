// GitHub link parsing for the capture page: repository and skill targets out of pasted or shared text.
// Coupled with action/scripts/target.py (key, ref and path grammar) and docs/collective-plan.md §2.

export const RESERVED_OWNERS = new Set([
  'about', 'apps', 'codespaces', 'collections', 'copilot', 'enterprise', 'explore', 'features',
  'issues', 'join', 'login', 'logout', 'marketplace', 'new', 'notifications', 'orgs',
  'organizations', 'pricing', 'pulls', 'search', 'security', 'settings', 'site', 'sponsors',
  'topics', 'trending',
]);
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO_RE = /^[A-Za-z0-9._-]+$/;
const REF_SEG_RE = /^[A-Za-z0-9._@+-]+$/;
const PATH_SEG_RE = /^[A-Za-z0-9._@+ -]+$/;
const SHA_RE = /^[0-9a-f]{40}$/i;
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
const RAW_HOST = 'raw.githubusercontent.com';
// Only these link wrappers are unwrapped; any other host carrying a GitHub URL in its
// query (e.g. evil.example/?next=github.com/a/b) is rejected.
const WRAPPERS = new Map([
  ['l.threads.com', 'u'], ['l.threads.net', 'u'], ['l.facebook.com', 'u'], ['l.instagram.com', 'u'],
]);
const POST_HOSTS = [
  ['threads', /(^|\.)threads\.(com|net)$/], ['x', /(^|\.)(x|twitter)\.com$/], ['youtube', /(^|\.)youtube\.com$|^youtu\.be$/],
  ['instagram', /(^|\.)instagram\.com$/], ['facebook', /(^|\.)facebook\.com$/],
];
// Bare (scheme-less) candidates must not follow URL characters, so a path or query segment
// like evil.example/github.com/a/b never starts a candidate.
const CANDIDATE_RE = /https?:\/\/[^\s<>"'()（）「」，。]+|(?<![\w.@/:?=&%-])(?:www\.)?github\.com\/[^\s<>"'()（）「」，。]+/gi;
const PATH_MAX = 200;

export const SKILL_FILE = 'SKILL.md';

const lower = (s) => String(s).toLowerCase();

export function repoKey(repo) { return `repository:${lower(repo)}`; }
export function skillKey(repo, path) { return `skill:${lower(repo)}:${path}`; }
export function keyOf(t) { return t.item_type === 'skill' ? skillKey(t.repo, t.path ?? '') : repoKey(t.repo); }

function decodeSegments(pathname) {
  const out = [];
  for (const raw of pathname.split('/')) {
    if (!raw) continue;
    try { out.push(decodeURIComponent(raw)); } catch { return null; }
  }
  return out;
}

export function validPath(path) {
  if (path === '') return true;
  if (typeof path !== 'string' || path.length > PATH_MAX) return false;
  return path.split('/').every((s) => s && s !== '.' && s !== '..' && PATH_SEG_RE.test(s));
}

export function validRef(ref) {
  if (typeof ref !== 'string' || !ref || ref.length > 200) return false;
  if (ref.startsWith('-') || ref.includes('..') || ref.endsWith('.lock')) return false;
  return ref.split('/').every((s) => s && REF_SEG_RE.test(s));
}

// Every way to cut `segments` into <ref>/<path>; the first is the common single-segment branch.
function splits(segments) {
  const out = [];
  for (let i = 1; i <= segments.length; i++) {
    const ref = segments.slice(0, i).join('/'), path = segments.slice(i).join('/');
    if (validRef(ref) && validPath(path)) out.push({ ref, path });
  }
  return out;
}

function repoHit(owner, repo) {
  return { item_type: 'repository', owner, repo: `${owner}/${repo}`, url: `https://github.com/${owner}/${repo}`, ref: null, path: null };
}

// rest = what follows blob/ or tree/ (ref segments, then path segments); `file` marks a blob of SKILL.md.
function skillHit(owner, repo, rest, file) {
  const base = repoHit(owner, repo);
  const dirs = file ? rest.slice(0, -1) : rest;
  if (!dirs.length) return null;
  if (SHA_RE.test(dirs[0])) {
    const path = dirs.slice(1).join('/');
    return validPath(path) ? { ...base, item_type: 'skill', ref: dirs[0], path, refOptions: null, verified: file } : null;
  }
  const options = splits(dirs);
  if (!options.length) return null;
  return { ...base, item_type: 'skill', ref: options[0].ref, path: options[0].path,
    refOptions: options.length > 1 ? options : null, verified: file };
}

// One URL -> a target, or null. A tree/ folder becomes an unverified skill candidate (the folder
// may or may not hold SKILL.md); a tree/ of a bare ref is the repository itself.
export function parseGitHubUrl(candidate, depth = 0) {
  let url;
  try { url = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (url.username || url.password) return null;
  if (GITHUB_HOSTS.has(host)) {
    const seg = decodeSegments(url.pathname);
    if (!seg) return null;
    const [owner = '', repoSeg = '', kind = '', ...rest] = seg;
    if (!OWNER_RE.test(owner) || RESERVED_OWNERS.has(owner.toLowerCase())) return null;
    const repo = repoSeg.replace(/\.git$/i, '').replace(/\.+$/, '');
    if (!repo || !REPO_RE.test(repo)) return null;
    if (kind === 'blob' && rest.length >= 2 && rest[rest.length - 1].toLowerCase() === 'skill.md') {
      return skillHit(owner, repo, rest, true) || repoHit(owner, repo);
    }
    if (kind === 'tree' && rest.length >= 2) return skillHit(owner, repo, rest, false) || repoHit(owner, repo);
    return repoHit(owner, repo);
  }
  if (host === RAW_HOST) {
    const seg = decodeSegments(url.pathname);
    if (!seg || seg.length < 4 || seg[seg.length - 1].toLowerCase() !== 'skill.md') return null;
    const [owner, repo, ...rest] = seg;
    if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) return null;
    return skillHit(owner, repo, rest, true);
  }
  const param = WRAPPERS.get(host);
  if (param && depth < 2) {
    const target = url.searchParams.get(param);
    if (target) return parseGitHubUrl(target, depth + 1);
  }
  return null;
}

export function postPlatform(candidate) {
  let url;
  try { url = new URL(candidate); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (WRAPPERS.has(host)) return null;
  const hit = POST_HOSTS.find(([, re]) => re.test(host));
  return hit ? hit[0] : null;
}

// All GitHub targets in the texts, in order, each key once (dups counted), plus the social post
// links seen alongside (used to tell "only a Threads link" apart from "no link at all").
export function extractTargets(...texts) {
  const items = [], posts = [], byKey = new Map();
  let duplicates = 0;
  for (const raw of texts) {
    if (!raw) continue;
    for (const m of String(raw).matchAll(CANDIDATE_RE)) {
      const text = m[0].replace(/[.,;:!?。，、]+$/, '');
      const hit = parseGitHubUrl(text);
      if (!hit) {
        const platform = postPlatform(text);
        if (platform && !posts.some((p) => p.url === text)) posts.push({ platform, url: text });
        continue;
      }
      const key = keyOf(hit);
      if (byKey.has(key)) { duplicates += 1; continue; }
      const item = { ...hit, key, source_url: cleanSourceUrl(text) };
      byKey.set(key, item);
      items.push(item);
    }
  }
  return { items, posts, duplicates };
}

// The link as pasted, minus query and fragment (tracking parameters live there).
export function cleanSourceUrl(text) {
  try {
    const u = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    const inner = WRAPPERS.has(u.hostname.toLowerCase()) && u.searchParams.get(WRAPPERS.get(u.hostname.toLowerCase()));
    if (inner && inner !== text) return cleanSourceUrl(inner);
    return `${u.origin}${u.pathname}`.replace(/\/+$/, '').replace(/\.git$/i, '');
  } catch { return ''; }
}

// Resolves a slash-containing <ref>/<path> cut against the refs that really exist.
// listRefs(prefix) -> Promise<string[]> of branch and tag names starting with prefix.
export async function resolveRef(target, listRefs) {
  if (!target.refOptions) return { ...target, refOptions: null };
  const joined = [target.ref, target.path].filter(Boolean).join('/');
  const first = target.refOptions[0].ref;
  const names = await listRefs(first);
  const fits = names.filter((n) => joined === n || joined.startsWith(`${n}/`)).sort((a, b) => b.length - a.length);
  if (!fits.length) throw Object.assign(new Error('ref-not-found'), { code: 'ref-not-found' });
  const ref = fits[0];
  const path = joined === ref ? '' : joined.slice(ref.length + 1);
  return { ...target, ref, path, refOptions: null, key: skillKey(target.repo, path) };
}

// Picks one of the offered cuts (when refs cannot be listed, the person chooses).
export function chooseSplit(target, index) {
  const o = target.refOptions && target.refOptions[index];
  if (!o) return target;
  return { ...target, ref: o.ref, path: o.path, key: skillKey(target.repo, o.path) };
}

export function skillUrl(t) {
  const ref = t.ref || 'HEAD';
  const enc = (s) => s.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${t.repo}/blob/${enc(ref)}/${t.path ? `${enc(t.path)}/` : ''}${SKILL_FILE}`;
}

// Directories holding SKILL.md, from a recursive git tree listing.
export function skillDirs(treeEntries, under = '') {
  const prefix = under ? `${under}/` : '';
  return (Array.isArray(treeEntries) ? treeEntries : [])
    .filter((t) => t && t.type === 'blob' && typeof t.path === 'string' && (t.path === SKILL_FILE || t.path.endsWith(`/${SKILL_FILE}`)))
    .map((t) => t.path.slice(0, -SKILL_FILE.length).replace(/\/$/, ''))
    .filter((dir) => (under ? dir === under || dir.startsWith(prefix) : true) && validPath(dir))
    .sort();
}
