'use strict';

const CFG_KEY = 'repobox.cfg';
const RESERVED_OWNERS = new Set([
  'about', 'apps', 'codespaces', 'collections', 'copilot', 'enterprise', 'explore', 'features',
  'issues', 'join', 'login', 'logout', 'marketplace', 'new', 'notifications', 'orgs',
  'organizations', 'pricing', 'pulls', 'search', 'security', 'settings', 'site', 'sponsors',
  'topics', 'trending',
]);
const REPO_RE = /(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]+)/g;

const $ = (id) => document.getElementById(id);

// Wrapped links (l.threads.com/?u=..., t.co landing pages) carry the target URL-encoded,
// so decode before matching.
function findGitHubRepo(...texts) {
  for (const raw of texts) {
    if (!raw) continue;
    let s = raw;
    for (let i = 0; i < 2; i++) {
      try { const d = decodeURIComponent(s); if (d === s) break; s = d; } catch { break; }
    }
    for (const m of s.matchAll(REPO_RE)) {
      const owner = m[1];
      const repo = m[2].replace(/\.+$/, '').replace(/\.git$/, '');
      if (!repo || RESERVED_OWNERS.has(owner.toLowerCase())) continue;
      return { owner, repo, url: `https://github.com/${owner}/${repo}` };
    }
  }
  return null;
}

function detectSource(ref) {
  let host = '';
  try { host = new URL(ref).hostname; } catch { return ''; }
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

  const cfg = loadCfg();
  if (cfg) { $('repo').value = cfg.repo || ''; $('token').value = cfg.token ? '********' : ''; }
  $('settings').onsubmit = (e) => {
    e.preventDefault();
    const repo = $('repo').value.trim();
    const tokenInput = $('token').value.trim();
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) { setStatus('repo 格式應為 owner/name', 'err'); return; }
    const token = tokenInput === '********' ? (cfg && cfg.token) : tokenInput;
    if (!token) { setStatus('請貼上 token', 'err'); return; }
    if (saveCfg({ repo, token })) setStatus('設定已儲存', 'ok');
    else setStatus('無法儲存（瀏覽器封鎖了本地儲存）', 'err');
    $('token').value = '********';
  };

  $('add').onsubmit = (e) => {
    e.preventDefault();
    const hit = findGitHubRepo($('add-url').value);
    if (!hit) { setStatus('沒找到 GitHub repo 網址', 'err'); return; }
    submit(hit, { source: 'manual' });
  };

  const base = location.origin + location.pathname;
  $('bookmarklet').href = "javascript:void(window.open('" + base +
    "?url='+encodeURIComponent(location.href)+'&ref='+encodeURIComponent(document.referrer)," +
    "'repobox','width=420,height=360'))";

  const p = new URLSearchParams(location.search);
  const shared = { title: p.get('title'), text: p.get('text'), url: p.get('url'), ref: p.get('ref') };
  if (!shared.title && !shared.text && !shared.url) return;
  history.replaceState(null, '', base);
  $('received').textContent = JSON.stringify(shared, null, 2);
  const hit = findGitHubRepo(shared.url, shared.text, shared.title);
  if (!hit) { setStatus('分享內容裡沒找到 GitHub repo 網址', 'err'); return; }
  submit(hit, { source: detectSource(shared.ref || '') });
}

init();
