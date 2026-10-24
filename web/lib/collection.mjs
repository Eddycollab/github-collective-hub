// The collection model: index.json entries + user.json + inbox captures -> one list of items,
// and the pure operations on it (filter, search, sort, duplicates, user edits, backup).
// Coupled with action/scripts/index.py (index v2) and docs/collective-plan.md §3.

import { keyOf, repoKey, skillKey } from './github-url.mjs';

export const ITEM_TYPE_LABEL = { repository: 'GitHub 專案', skill: 'Skill' };
export const USER_STATUS = { to_analyze: '待分析', analyzed: '已分析', in_use: '使用中', archived: '封存' };
export const JOB_STATUS = { queued: '排隊中', running: '分析中', succeeded: '分析完成', failed: '分析失敗' };
export const SOURCE_LABEL = { github: 'GitHub', threads: 'Threads', voice: '語音分享', friend: '朋友推薦', other: '其他',
  x: 'X', youtube: 'YouTube', manual: '手動貼上' };
export const SOURCES = ['github', 'threads', 'voice', 'friend', 'other'];
export const DEFAULT_TAGS = [
  { name: '簡報類', definition: '製作、生成、轉換或展示簡報與投影片' },
  { name: '程式類', definition: '寫程式、開發流程、程式碼品質與開發者工具' },
  { name: '語音類', definition: '語音辨識、語音合成、錄音與逐字稿' },
  { name: 'AI 工具', definition: '以 AI 模型為核心的工具、agent 與工作流程' },
  { name: '設計資源', definition: '視覺設計、UI、圖示、字型與設計系統' },
  { name: '教育應用', definition: '教學、學習、課程與教育平台' },
];
export const TAG_MAX = 20, TAGS_MAX = 10, NOTE_MAX = 2000;
export const VIEWS = { all: '所有收藏', inbox: '靈感收件匣', favorites: '我的最愛', skills: 'Skills 專區', archived: '封存' };

const str = (v) => (typeof v === 'string' ? v : '');
const strs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []);
const time = (iso) => { const t = Date.parse(iso); return Number.isNaN(t) ? 0 : t; };
const STEM_RE = /^[a-z0-9._-]+__[a-z0-9._-]+$/;

export function cleanTag(t) {
  const s = String(t ?? '').replace(/[\u0000-\u001f<>`]/g, '').replace(/\s+/g, ' ').trim();
  return s.length && s.length <= TAG_MAX ? s : '';
}

export function cleanTags(list) {
  const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    const c = cleanTag(t);
    if (c && !out.includes(c)) out.push(c);
  }
  return out.slice(0, TAGS_MAX);
}

function stemOf(md) {
  const m = /^library\/([^/]+)\.md$/.exec(str(md));
  return m && STEM_RE.test(m[1]) ? m[1] : null;
}

// index.json v1 (upstream) and v2 rows -> one shape; anything malformed is dropped.
export function normalizeEntry(e) {
  if (!e || typeof e !== 'object' || typeof e.repo !== 'string') return null;
  const stem = stemOf(e.md);
  if (!stem) return null;
  const itemType = e.item_type === 'skill' ? 'skill' : 'repository';
  const path = itemType === 'skill' ? str(e.skill_path) : null;
  const key = str(e.key) || (itemType === 'skill' ? skillKey(e.repo, path) : repoKey(e.repo));
  return {
    kind: 'entry', key, stem, itemType, repo: e.repo, url: str(e.url), skillName: str(e.skill_name), skillPath: path,
    ref: str(e.ref) || null, commitSha: str(e.commit_sha) || null,
    tagline: str(e.tagline), intro: str(e.intro), problem: str(e.problem), description: str(e.description),
    category: str(e.category), keywords: strs(e.tags), suggestedTags: strs(e.suggested_tags), captureTags: strs(e.capture_tags),
    requirements: strs(e.requirements), license: str(e.license), sources: strs(e.sources),
    capturedAt: str(e.last_seen), firstSeen: str(e.first_seen) || str(e.last_seen), analyzedAt: str(e.analyzed_at),
    updatedAt: str(e.updated_at) || str(e.analyzed_at), analysisVersion: str(e.analysis_version), hasSvg: typeof e.svg === 'string',
    sightings: Number.isInteger(e.sightings_n) ? e.sightings_n : 0,
  };
}

// A capture file (inbox/<id>.json or the `capture` of inbox/failed/<id>.json) -> target fields.
export function captureTarget(c) {
  if (!c || typeof c !== 'object') return null;
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/?$/.exec(str(c.url));
  const repo = c.target && typeof c.target.repo === 'string' ? c.target.repo : m && m[1];
  if (!repo) return null;
  const itemType = c.item_type === 'skill' ? 'skill' : 'repository';
  const path = itemType === 'skill' ? str(c.target && c.target.path) : null;
  return { itemType, repo, ref: (c.target && str(c.target.ref)) || null, path, key: keyOf({ item_type: itemType, repo, path }) };
}

export function userItem(user, key) {
  const items = user && user.items && typeof user.items === 'object' ? user.items : {};
  const u = Object.hasOwn(items, key) ? items[key] : null;
  return u && typeof u === 'object' ? u : null;
}

// Builds the list. Captures whose key already has an entry become that entry's job state (a
// re-analysis or a repeat share), not a second card.
export function buildItems({ index, user, queued = [], failed = [], running = false, history = [] } = {}) {
  const entries = (index && Array.isArray(index.entries) ? index.entries : []).map(normalizeEntry).filter(Boolean);
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const captures = new Map();
  const addCapture = (c, job) => {
    const t = captureTarget(c.capture);
    if (!t) return;
    const existing = byKey.get(t.key);
    if (existing) {
      if (!existing.job || job === 'failed' || time(c.at) > time(existing.jobAt)) Object.assign(existing, { job, jobAt: c.at, jobError: c.error || '', jobId: c.id, jobReanalyze: Boolean(c.capture.reanalyze) });
      return;
    }
    const prev = captures.get(t.key);
    if (prev && time(prev.capturedAt) >= time(c.capture.captured_at || c.at)) return;
    captures.set(t.key, {
      kind: 'capture', key: t.key, stem: null, itemType: t.itemType, repo: t.repo, url: `https://github.com/${t.repo}`,
      skillName: '', skillPath: t.path, ref: t.ref, tagline: '', intro: '', problem: '', description: '', category: '',
      keywords: [], suggestedTags: [], captureTags: cleanTags(c.capture.tags), requirements: [], license: '',
      sources: c.capture.source ? [str(c.capture.source)] : [], capturedAt: str(c.capture.captured_at || c.at), firstSeen: str(c.capture.captured_at),
      analyzedAt: '', updatedAt: '', hasSvg: false, sightings: 1, job, jobAt: c.at, jobError: c.error || '', jobId: c.id,
      capture: c.capture, note: str(c.capture.note),
    });
  };
  for (const c of failed) addCapture(c, 'failed');
  for (const c of queued) addCapture(c, running ? 'running' : 'queued');
  // Captures this device sent that the inbox listing has not caught up with yet.
  // Upstream history rows carry no capture; their repo is enough to show them as waiting.
  for (const h of Array.isArray(history) ? history : []) {
    if (!h || h.state !== 'pending' || [...queued, ...failed].some((c) => c.id === h.id)) continue;
    const capture = h.capture || { v: 1, url: `https://github.com/${h.repo}`, captured_at: h.at };
    addCapture({ id: h.id, at: h.at, capture }, running ? 'running' : 'queued');
  }
  const items = [...captures.values(), ...entries];
  for (const it of items) {
    const u = userItem(user, it.key);
    it.userEdited = Boolean(u && Array.isArray(u.tags));
    it.tags = it.userEdited ? cleanTags(u.tags) : it.captureTags;
    it.note = u && typeof u.note === 'string' ? u.note : (it.note || '');
    it.favorite = Boolean(u && u.favorite === true);
    const derived = it.kind === 'entry' ? 'analyzed' : 'to_analyze';
    it.status = u && Object.hasOwn(USER_STATUS, u.status) ? u.status : derived;
    if (!it.job) it.job = it.kind === 'entry' ? 'succeeded' : 'queued';
  }
  return items;
}

export function tagVocabulary(index, items = []) {
  const out = [];
  const add = (name, definition = '') => { const n = cleanTag(name); if (n && !out.some((t) => t.name === n)) out.push({ name: n, definition }); };
  const vocab = index && Array.isArray(index.tag_vocabulary) ? index.tag_vocabulary : DEFAULT_TAGS;
  for (const t of vocab) if (t && typeof t.name === 'string') add(t.name, str(t.definition));
  for (const t of DEFAULT_TAGS) add(t.name, t.definition);
  for (const it of items) for (const t of it.tags || []) add(t);
  return out;
}

export function inView(it, view) {
  switch (view) {
    case 'inbox': return it.status !== 'archived' && (it.job !== 'succeeded' || it.status === 'to_analyze');
    case 'favorites': return it.favorite && it.status !== 'archived';
    case 'skills': return it.itemType === 'skill' && it.status !== 'archived';
    case 'archived': return it.status === 'archived';
    default: return it.status !== 'archived';
  }
}

export function haystack(it, categoryLabel = (c) => c) {
  return [it.repo, it.skillName, it.skillPath, it.tagline, it.intro, it.problem, it.description, it.note,
    ...(it.tags || []), ...(it.suggestedTags || []), ...(it.keywords || []), categoryLabel(it.category), ITEM_TYPE_LABEL[it.itemType]]
    .filter(Boolean).join('\n').toLowerCase();
}

// Every whitespace-separated term must appear somewhere (AND); every selected tag must be on the item.
export function filterItems(items, { view = 'all', tags = [], query = '', categoryLabel } = {}) {
  const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((it) => inView(it, view)
    && tags.every((t) => (it.tags || []).includes(t))
    && (!terms.length || ((h) => terms.every((term) => h.includes(term)))(haystack(it, categoryLabel))));
}

export function sortItems(items, by = 'captured') {
  const k = by === 'analyzed' ? (it) => time(it.analyzedAt) : (it) => time(it.capturedAt);
  return [...items].sort((a, b) => k(b) - k(a) || a.repo.localeCompare(b.repo));
}

export function viewCounts(items) {
  const out = {};
  for (const v of Object.keys(VIEWS)) out[v] = items.filter((it) => inView(it, v)).length;
  return out;
}

export function tagCounts(items) {
  const m = new Map();
  for (const it of items) if (it.status !== 'archived') for (const t of it.tags || []) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

// Marks each candidate that is already collected (entry or capture with the same key).
export function markDuplicates(candidates, items) {
  const byKey = new Map(items.map((it) => [it.key, it]));
  return candidates.map((c) => ({ ...c, duplicate: byKey.get(c.key) || null }));
}

// Pure edit of user.json: only the given fields of one key change.
export function patchUser(doc, key, patch, now = new Date().toISOString()) {
  const base = doc && typeof doc === 'object' && doc.items && typeof doc.items === 'object' ? doc : { schema_version: 1, items: {} };
  const prev = userItem(base, key) || {};
  const next = { ...prev };
  if ('tags' in patch) next.tags = cleanTags(patch.tags);
  if ('note' in patch) next.note = String(patch.note ?? '').slice(0, NOTE_MAX);
  if ('favorite' in patch) next.favorite = patch.favorite === true;
  if ('status' in patch) { if (patch.status === null) delete next.status; else if (Object.hasOwn(USER_STATUS, patch.status)) next.status = patch.status; }
  next.updated_at = now;
  const items = { ...base.items };
  if (patch.remove) delete items[key]; else items[key] = next;
  return { schema_version: 1, ...base, items, updated_at: now };
}

export const BACKUP_FORMAT = 'github-collective-hub-backup';

// A portable backup: the user's own data plus enough of each item to queue it again elsewhere.
export function exportBackup({ library, index, user, items, now = new Date().toISOString() }) {
  return {
    format: BACKUP_FORMAT, version: 1, exported_at: now, library: library || '',
    user: user && typeof user === 'object' ? user : { schema_version: 1, items: {} },
    items: (items || []).map((it) => ({ key: it.key, item_type: it.itemType, repo: it.repo, ref: it.ref || null,
      path: it.itemType === 'skill' ? it.skillPath || '' : null, captured_at: it.capturedAt || it.firstSeen || '', sources: it.sources || [] })),
    index: index && typeof index === 'object' ? index : null,
  };
}

// What an import would do: user entries merge per key (newer updated_at wins); items missing from
// the library are offered for queueing. Nothing is written here.
export function planImport(backup, { user, items }) {
  if (!backup || backup.format !== BACKUP_FORMAT || backup.version !== 1) throw new Error('不是 GitHub Collective Hub 的備份檔');
  const incoming = backup.user && backup.user.items && typeof backup.user.items === 'object' ? backup.user.items : {};
  let merged = user && user.items ? user : { schema_version: 1, items: {} };
  let updated = 0, kept = 0;
  for (const [key, u] of Object.entries(incoming)) {
    if (!u || typeof u !== 'object' || !/^(repository|skill):/.test(key)) continue;
    const cur = userItem(merged, key);
    if (cur && time(cur.updated_at) >= time(u.updated_at)) { kept += 1; continue; }
    merged = patchUser(merged, key, { tags: u.tags ?? [], note: u.note ?? '', favorite: u.favorite === true, status: u.status ?? null }, str(u.updated_at) || undefined);
    updated += 1;
  }
  const have = new Set((items || []).map((it) => it.key));
  const toQueue = (Array.isArray(backup.items) ? backup.items : []).filter((b) => b && typeof b.repo === 'string'
    && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(b.repo) && !have.has(keyOf({ item_type: b.item_type, repo: b.repo, path: b.path ?? '' })))
    .map((b) => ({ item_type: b.item_type === 'skill' ? 'skill' : 'repository', repo: b.repo, ref: typeof b.ref === 'string' ? b.ref : null,
      path: b.item_type === 'skill' ? str(b.path) : null }));
  return { user: merged, updated, kept, toQueue };
}

// Coupled with entry.py _SECRET: a token pasted into shared text must never reach the library's git history.
const SECRET = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,})/g;
export const REDACTED = '［已遮蔽的 token］';
export const maskSecrets = (s) => str(s).replace(SECRET, REDACTED);

// A capture v2 document (docs/collective-plan.md §3.1). Lengths are capped here and again by items.py.
export function makeCapture(target, ctx = {}, capturedAt) {
  const isSkill = target.item_type === 'skill';
  const clean = (v, n) => maskSecrets(str(v).slice(0, n));
  const url = (v) => (/^https?:\/\/[^\s<>"']+$/.test(str(v)) && !maskSecrets(v).includes(REDACTED) ? str(v).slice(0, 500) : '');
  return {
    v: 2, item_type: isSkill ? 'skill' : 'repository', url: `https://github.com/${target.repo}`,
    target: { repo: target.repo, ref: isSkill ? target.ref || null : null, path: isSkill ? target.path || '' : null },
    source_url: url(target.source_url), captured_at: capturedAt,
    source: SOURCES.includes(ctx.source) ? ctx.source : str(ctx.source).slice(0, 40), post_url: url(ctx.post_url),
    share_text: clean(ctx.share_text, 4000), transcript: clean(ctx.transcript, 8000),
    note: clean(ctx.note, 500), tags: cleanTags(ctx.tags), reanalyze: Boolean(ctx.reanalyze), client: 'collective@1',
  };
}
