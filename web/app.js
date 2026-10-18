'use strict';

const CFG_KEY = 'repobox.cfg';
const RESERVED_OWNERS = new Set([
  'about', 'apps', 'codespaces', 'collections', 'copilot', 'enterprise', 'explore', 'features',
  'issues', 'join', 'login', 'logout', 'marketplace', 'new', 'notifications', 'orgs',
  'organizations', 'pricing', 'pulls', 'search', 'security', 'settings', 'site', 'sponsors',
  'topics', 'trending',
]);
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO_SEG_RE = /^[A-Za-z0-9._-]+/;
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
// Only these link wrappers are unwrapped; any other host carrying a GitHub URL in its
// query (e.g. evil.example/?next=github.com/a/b) is rejected.
const WRAPPERS = new Map([
  ['l.threads.com', 'u'], ['l.threads.net', 'u'], ['l.facebook.com', 'u'], ['l.instagram.com', 'u'],
]);
// Bare (scheme-less) candidates must not follow URL characters, so a path or query segment
// like evil.example/github.com/a/b never starts a candidate.
const CANDIDATE_RE = /https?:\/\/[^\s<>"'()]+|(?<![\w.@\/:?=&%-])(?:www\.)?github\.com\/[^\s<>"'()]+/gi;

const $ = (id) => document.getElementById(id);

function repoFromUrl(candidate, depth = 0) {
  let url;
  try { url = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (GITHUB_HOSTS.has(host)) {
    if (url.username || url.password) return null;
    const [owner = '', repoSeg = ''] = url.pathname.split('/').slice(1);
    if (!OWNER_RE.test(owner) || RESERVED_OWNERS.has(owner.toLowerCase())) return null;
    const m = repoSeg.match(REPO_SEG_RE);
    const repo = m ? m[0].replace(/\.+$/, '').replace(/\.git$/i, '') : '';
    if (!repo) return null;
    return { owner, repo, url: `https://github.com/${owner}/${repo}` };
  }
  const param = WRAPPERS.get(host);
  if (param && depth < 2) {
    const target = url.searchParams.get(param);
    if (target) return repoFromUrl(target, depth + 1);
  }
  return null;
}

function findGitHubRepo(...texts) {
  for (const raw of texts) {
    if (!raw) continue;
    for (const m of raw.matchAll(CANDIDATE_RE)) {
      const hit = repoFromUrl(m[0]);
      if (hit) return hit;
    }
  }
  return null;
}

function detectSource(host) {
  if (!host) return '';
  if (/(^|\.)threads\.(com|net)$/.test(host)) return 'threads';
  if (/(^|\.)(x|twitter)\.com$|^t\.co$/.test(host)) return 'x';
  if (/(^|\.)youtube\.com$|^youtu\.be$/.test(host)) return 'youtube';
  return host;
}

function loadCfg() {
  try { return JSON.parse(localStorage.getItem(CFG_KEY)) || null; } catch { return null; }
}

function saveCfg(cfg) {
  try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); return true; } catch { return false; }
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

function makeId(d) {
  const rnd = crypto.getRandomValues(new Uint16Array(1))[0].toString(16).padStart(4, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${rnd}`;
}

function isoLocal(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

function b64utf8(s) {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

const HISTORY_KEY = 'repobox.history';
const HISTORY_MAX = 20;

function setStatus(text, cls = '') {
  $('status').textContent = text;
  $('block').dataset.state = cls || 'idle';
}

function setRepo(name) { $('block-repo').textContent = name || '—'; }
function setHint(text) { $('hint').textContent = text || ''; }
function clearActions() { $('block-actions').replaceChildren(); }

function addAction(label, onClick, primary = false) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = primary ? 'btn small primary' : 'btn small';
  btn.textContent = label;
  btn.onclick = () => { clearActions(); onClick(); };
  $('block-actions').append(btn);
}

function hhmm(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

async function submit(hit, ctx = {}) {
  const cfg = loadCfg();
  setRepo(`${hit.owner}/${hit.repo}`);
  clearActions();
  if (!cfg || !cfg.repo || !cfg.token) {
    setStatus('還沒連結', 'err');
    setHint('先連結收藏庫，連結後按「重試」。');
    addAction('重試', () => submit(hit, ctx), true);
    openDrawer();
    return;
  }
  setStatus('送出中', 'busy');
  setHint('');
  const now = new Date();
  const id = makeId(now);
  const capture = {
    v: 1, url: hit.url, captured_at: isoLocal(now), source: ctx.source || '',
    page_url: ctx.page_url || '', note: '', client: 'pwa@1',
  };
  try {
    const res = await fetch(`https://api.github.com/repos/${cfg.repo}/contents/inbox/${id}.json`, {
      method: 'PUT',
      headers: ghHeaders(cfg),
      body: JSON.stringify({
        message: `capture: ${hit.owner}/${hit.repo}`,
        content: b64utf8(JSON.stringify(capture, null, 2) + '\n'),
      }),
    });
    const totalMs = Math.round(performance.now());
    if (res.ok) {
      setStatus('已收', 'ok');
      $('timing').textContent = `${(totalMs / 1000).toFixed(1)} 秒`;
      $('clock').textContent = hhmm(now);
      setHint('分析約需 3–8 分鐘，完成後會出現在最近收藏。');
      addHistory({ id, repo: `${hit.owner}/${hit.repo}`, at: now.toISOString(), state: 'pending' });
      renderRecent();
      if (window.opener) setTimeout(() => window.close(), 1500);
    } else {
      const body = await res.json().catch(() => ({}));
      failWith(`GitHub 回應 ${res.status}${body.message ? `：${body.message}` : ''}`, hit, ctx);
    }
  } catch (e) {
    failWith(`連不到 GitHub（${e.message}）`, hit, ctx);
  }
}

function failWith(message, hit, ctx) {
  setStatus('沒收到', 'err');
  setHint(message);
  addAction('重試', () => submit(hit, ctx), true);
}

function ghHeaders(cfg) {
  return {
    Authorization: `Bearer ${cfg.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function loadHistory() {
  try {
    const h = JSON.parse(localStorage.getItem(HISTORY_KEY));
    return Array.isArray(h) ? h.filter((x) => x && typeof x.id === 'string' && typeof x.repo === 'string') : [];
  } catch { return []; }
}

function saveHistory(h) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, HISTORY_MAX))); } catch { /* storage blocked */ }
}

function addHistory(item) { saveHistory([item, ...loadHistory().filter((x) => x.id !== item.id)]); }

const STATE_LABEL = { pending: '分析中', done: '已分析', failed: '失敗' };

function ago(iso) {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 1) return '剛剛';
  if (mins < 60) return `${mins} 分鐘前`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours} 小時前` : `${Math.round(hours / 24)} 天前`;
}

function itemLink(cfg, item) {
  if (!cfg) return null;
  const base = `https://github.com/${cfg.repo}`;
  if (item.state === 'done') return `${base}/blob/main/library/${item.repo.replace('/', '__').toLowerCase()}.md`;
  if (item.state === 'failed') return `${base}/blob/main/inbox/failed/${item.id}.json`;
  return `${base}/actions`;
}

function renderRecent() {
  const cfg = loadCfg();
  const list = $('recent');
  const items = loadHistory();
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '收藏過的 repo 會列在這裡。';
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(...items.map((item) => {
    const li = document.createElement('li');
    const href = itemLink(cfg, item);
    const row = document.createElement(href ? 'a' : 'span');
    if (href) { row.href = href; row.target = '_blank'; row.rel = 'noopener'; }
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.repo;
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = ago(item.at);
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.dataset.s = item.state;
    tag.textContent = STATE_LABEL[item.state] || item.state;
    row.append(name, tag, when);
    li.append(row);
    return li;
  }));
}

// Coupled with publish.py: processed captures move to inbox/done/ or inbox/failed/ under the same name.
async function refreshStates() {
  const cfg = loadCfg();
  const items = loadHistory();
  if (!cfg || !cfg.token || !items.some((x) => x.state === 'pending')) return;
  const names = async (dir) => {
    try {
      const res = await fetch(`https://api.github.com/repos/${cfg.repo}/contents/inbox/${dir}`, { headers: ghHeaders(cfg) });
      const data = res.ok ? await res.json() : [];
      return new Set(Array.isArray(data) ? data.map((f) => f && f.name) : []);
    } catch { return new Set(); }
  };
  const [done, failed] = await Promise.all([names('done'), names('failed')]);
  let changed = false;
  for (const item of items) {
    if (item.state !== 'pending') continue;
    const next = done.has(`${item.id}.json`) ? 'done' : failed.has(`${item.id}.json`) ? 'failed' : 'pending';
    if (next !== item.state) { item.state = next; changed = true; }
  }
  if (changed) { saveHistory(items); renderRecent(); }
}

function openDrawer() {
  const d = $('drawer');
  if (!d.open) { if (d.showModal) d.showModal(); else d.setAttribute('open', ''); }
}

function closeDrawer() { const d = $('drawer'); if (d.open) d.close ? d.close() : d.removeAttribute('open'); }

function renderConn(cfg) {
  const ok = Boolean(cfg && cfg.repo && cfg.token);
  $('conn').dataset.ok = ok ? '1' : '0';
  $('conn').querySelector('span').textContent = ok ? cfg.repo.split('/')[1] : '尚未設定';
  $('library').href = ok ? `https://github.com/${cfg.repo}` : '#';
}

function drawerMessage(text, isError) {
  const p = $('drawer').querySelector('p');
  p.textContent = text;
  p.style.color = isError ? 'var(--err)' : '';
}

async function captureFromClipboard() {
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch {
    setStatus('讀不到剪貼簿', 'err');
    setHint('瀏覽器沒有給剪貼簿權限。把連結貼到下面的欄位，再按「收藏」。');
    $('add-url').focus();
    return;
  }
  const hit = findGitHubRepo(text);
  if (!hit) {
    setRepo('');
    setStatus('沒找到連結', 'err');
    setHint('剪貼簿裡沒有 GitHub repo 連結。先在 Threads 或 GitHub 複製連結再按一次。');
    return;
  }
  submit(hit, { source: 'clipboard' });
}

function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  let cfg = loadCfg();
  if (cfg) { $('repo').value = cfg.repo || ''; $('token').value = cfg.token ? '********' : ''; }
  const base = location.origin + location.pathname;
  renderBookmarklet(base, cfg);
  renderConn(cfg);
  renderRecent();

  $('conn').onclick = openDrawer;
  $('drawer-close').onclick = closeDrawer;
  $('drawer').addEventListener('click', (e) => {
    const r = $('drawer').getBoundingClientRect();
    const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    if (e.target === $('drawer') && outside) closeDrawer();
  });
  $('library').onclick = (e) => { if (!loadCfg()) { e.preventDefault(); openDrawer(); } };
  $('paste').onclick = captureFromClipboard;

  $('settings').onsubmit = (e) => {
    e.preventDefault();
    const repo = $('repo').value.trim();
    const tokenInput = $('token').value.trim();
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) { drawerMessage('收藏庫格式應為「帳號/repo 名稱」。', true); return; }
    const token = tokenInput === '********' ? (cfg && cfg.token) : tokenInput;
    if (!token) { drawerMessage('請貼上 token。', true); return; }
    const next = { repo, token, nonce: (cfg && cfg.nonce) || randomHex(16) };
    if (!saveCfg(next)) { drawerMessage('無法儲存：這個瀏覽器封鎖了本機儲存。', true); return; }
    cfg = next;
    $('token').value = '********';
    drawerMessage('已儲存。', false);
    renderBookmarklet(base, cfg);
    renderConn(cfg);
    renderRecent();
    setTimeout(closeDrawer, 600);
  };

  $('add').onsubmit = (e) => {
    e.preventDefault();
    const hit = findGitHubRepo($('add-url').value);
    if (!hit) { setRepo(''); setStatus('沒找到連結', 'err'); setHint('這段文字裡沒有 GitHub repo 連結。'); return; }
    $('add-url').value = '';
    submit(hit, { source: 'manual' });
  };

  if (!cfg || !cfg.token) openDrawer();
  handleIncoming(base, cfg);
  refreshStates();
}

// Auto-write only when provenance is proven; everything else needs an explicit tap.
// - Share sheet: manifest POST -> service worker stores a single-use handoff -> #s=<id>,
//   accepted only inside the installed app window. A crafted link can only GET, so it
//   cannot mint a handoff id.
// - Bookmarklet: #k=<nonce>; the bookmarklet runs only on github.com, so no other page
//   ever sees the nonce.
// - Plain ?url= / #url= links: always confirm.
async function handleIncoming(base, cfg) {
  const q = new URLSearchParams(location.search);
  const h = new URLSearchParams(location.hash.slice(1));
  let shared = null;
  let trusted = false;
  if (h.has('s')) {
    // A cross-site form can also POST to ./share, but it lands in a browser tab;
    // only the OS share sheet delivers a POST into the installed app window.
    shared = await takeHandoff(h.get('s'));
    trusted = Boolean(shared) && matchMedia('(display-mode: standalone)').matches;
  } else if (h.has('url')) {
    shared = { url: h.get('url'), ref: h.get('ref') };
    trusted = Boolean(cfg && cfg.nonce && h.get('k') === cfg.nonce);
  } else if (q.has('url') || q.has('text') || q.has('title')) {
    shared = { title: q.get('title'), text: q.get('text'), url: q.get('url') };
  }
  if (location.search || location.hash) history.replaceState(null, '', base);
  if (!shared) return;
  $('received').textContent = JSON.stringify(shared, null, 2);
  const hit = findGitHubRepo(shared.url, shared.text, shared.title);
  if (!hit) {
    setStatus('沒找到連結', 'err');
    setHint('分享的內容裡沒有 GitHub repo 網址。');
    return;
  }
  const ctx = { source: detectSource(shared.ref || '') };
  if (trusted) { submit(hit, ctx); return; }
  setRepo(`${hit.owner}/${hit.repo}`);
  setStatus('待確認', 'ask');
  setHint('這個連結不是從分享選單或你的書籤來的，確認後才收。');
  addAction('確認收藏', () => submit(hit, ctx), true);
}

// Coupled with sw.js: same cache name and key path; the entry is deleted on first read.
async function takeHandoff(id) {
  if (!/^[0-9a-f-]{36}$/.test(id || '') || !('caches' in self)) return null;
  try {
    const cache = await caches.open('repobox-handoff');
    const key = new URL(`handoff/${id}`, location.href).href;
    const res = await cache.match(key);
    if (!res) return null;
    await cache.delete(key);
    return await res.json();
  } catch { return null; }
}

function randomHex(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function renderBookmarklet(base, cfg) {
  const el = $('bookmarklet');
  if (!cfg || !cfg.nonce) { el.removeAttribute('href'); el.textContent = '（先儲存設定）'; return; }
  el.textContent = '收進 RepoBox';
  el.href = "javascript:(function(){if(location.hostname!=='github.com'){alert('RepoBox: open a GitHub repo page first');return}" +
    "var r='';try{r=new URL(document.referrer).hostname}catch(e){}" +
    "window.open('" + base + "#k=" + cfg.nonce + "&url='+encodeURIComponent(location.href)+'&ref='+encodeURIComponent(r)," +
    "'_blank','width=420,height=360')})()";
}
init();
