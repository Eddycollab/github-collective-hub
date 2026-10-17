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

function setStatus(text, cls = '') {
  const el = $('status');
  el.textContent = text;
  el.className = cls;
}

async function submit(hit, ctx = {}) {
  const cfg = loadCfg();
  if (!cfg || !cfg.repo || !cfg.token) { setStatus('請先在下方設定 repo 與 token', 'err'); return; }
  setStatus(`送出中：${hit.owner}/${hit.repo}`);
  const now = new Date();
  const id = makeId(now);
  const capture = {
    v: 1, url: hit.url, captured_at: isoLocal(now), source: ctx.source || '',
    page_url: ctx.page_url || '', note: '', client: 'pwa-phase0',
  };
  const t0 = performance.now();
  try {
    const res = await fetch(`https://api.github.com/repos/${cfg.repo}/contents/inbox/${id}.json`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        message: `capture: ${hit.owner}/${hit.repo}`,
        content: b64utf8(JSON.stringify(capture, null, 2) + '\n'),
      }),
    });
    const apiMs = Math.round(performance.now() - t0);
    const totalMs = Math.round(performance.now());
    if (res.ok) {
      setStatus(`已收：${hit.owner}/${hit.repo}`, 'ok');
      $('timing').textContent = `API ${apiMs} ms；從開啟頁面到已收 ${totalMs} ms`;
      if (window.opener) setTimeout(() => window.close(), 1500);
    } else {
      const body = await res.json().catch(() => ({}));
      setStatus(`失敗：HTTP ${res.status} ${body.message || ''}`, 'err');
      showRetry(hit, ctx);
    }
  } catch (e) {
    setStatus(`失敗（網路或 CORS）：${e.message}`, 'err');
    showRetry(hit, ctx);
  }
}

function showRetry(hit, ctx) {
  const btn = document.createElement('button');
  btn.textContent = '重試';
  btn.onclick = () => { btn.remove(); submit(hit, ctx); };
  $('status').after(btn);
}

function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  let cfg = loadCfg();
  if (cfg) { $('repo').value = cfg.repo || ''; $('token').value = cfg.token ? '********' : ''; }
  const base = location.origin + location.pathname;
  renderBookmarklet(base, cfg);

  $('settings').onsubmit = (e) => {
    e.preventDefault();
    const repo = $('repo').value.trim();
    const tokenInput = $('token').value.trim();
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) { setStatus('repo 格式應為 owner/name', 'err'); return; }
    const token = tokenInput === '********' ? (cfg && cfg.token) : tokenInput;
    if (!token) { setStatus('請貼上 token', 'err'); return; }
    const next = { repo, token, nonce: (cfg && cfg.nonce) || randomHex(16) };
    if (!saveCfg(next)) { setStatus('無法儲存（瀏覽器封鎖了本地儲存）', 'err'); return; }
    cfg = next;
    setStatus('設定已儲存', 'ok');
    $('token').value = '********';
    renderBookmarklet(base, cfg);
  };

  $('add').onsubmit = (e) => {
    e.preventDefault();
    const hit = findGitHubRepo($('add-url').value);
    if (!hit) { setStatus('沒找到 GitHub repo 網址', 'err'); return; }
    submit(hit, { source: 'manual' });
  };

  handleIncoming(base, cfg);
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
  if (!hit) { setStatus('分享內容裡沒找到 GitHub repo 網址', 'err'); return; }
  const ctx = { source: detectSource(shared.ref || '') };
  if (trusted) { submit(hit, ctx); return; }
  setStatus(`要收下 ${hit.owner}/${hit.repo} 嗎？`);
  const btn = document.createElement('button');
  btn.textContent = '確認收藏';
  btn.onclick = () => { btn.remove(); submit(hit, ctx); };
  $('status').after(btn);
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
