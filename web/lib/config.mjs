// Per-browser settings and history. Upstream stored them under repobox.*; they move to collective.*
// on first read so an existing device keeps its token and pending captures.

export const CFG_KEY = 'collective.cfg';
export const HISTORY_KEY = 'collective.history';
const LEGACY = { [CFG_KEY]: 'repobox.cfg', [HISTORY_KEY]: 'repobox.history' };
const HISTORY_MAX = 40;
export const DEMO_REPO = 'demo/collective';

function read(key, store = globalThis.localStorage) {
  try {
    let raw = store.getItem(key);
    if (raw === null && LEGACY[key]) {
      raw = store.getItem(LEGACY[key]);
      if (raw !== null) { store.setItem(key, raw); store.removeItem(LEGACY[key]); }
    }
    return raw === null ? null : JSON.parse(raw);
  } catch { return null; }
}

function write(key, value, store = globalThis.localStorage) {
  try { store.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

// Served by the Collective server (server/): the library and the GitHub token live on the server and
// the browser only holds a session cookie. null = a static page (GitHub Pages, local preview).
let server = null;

// GET /api/session -> { authenticated, login, repo, csrf } when this page is served by the server.
export async function probeServer(fetchImpl = (...a) => fetch(...a)) {
  try {
    const r = await fetchImpl('/api/session', { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok || !/application\/json/.test(r.headers.get('content-type') || '')) return null;
    const d = await r.json();
    return d && d.server === 'collective' ? d : null;
  } catch { return null; }
}

export function setServer(info) {
  server = info ? { authenticated: Boolean(info.authenticated), login: String(info.login || ''), repo: String(info.repo || ''), csrf: String(info.csrf || '') } : null;
}
export const serverInfo = () => server;

export function loadCfg(store) {
  const cfg = read(CFG_KEY, store);
  const local = cfg && typeof cfg === 'object' ? cfg : null;
  if (!server) return local;
  // Server mode: only per-device preferences come from storage; never a token or a repo.
  const keep = { ...(local && local.nonce ? { nonce: local.nonce } : {}), ...(local && local.demo === true ? { demo: true } : {}) };
  return server.authenticated ? { ...keep, server: true, repo: server.repo, login: server.login, csrf: server.csrf } : { ...keep, server: true };
}

export function saveCfg(cfg, store) {
  if (!server || !cfg) return write(CFG_KEY, cfg, store);
  return write(CFG_KEY, { ...(cfg.nonce ? { nonce: cfg.nonce } : {}), ...(cfg.demo === true ? { demo: true } : {}) }, store);
}

export const isDemo = (cfg) => Boolean(cfg && cfg.demo === true);
// Whether the library can be read and written: a token on a static page, a session in server mode.
export const hasAccess = (cfg) => Boolean(cfg && cfg.repo && (cfg.server ? cfg.csrf : cfg.token));
export const connected = (cfg) => Boolean(cfg && (isDemo(cfg) || hasAccess(cfg)));

export function loadHistory(store) {
  const h = read(HISTORY_KEY, store);
  return Array.isArray(h) ? h.filter((x) => x && typeof x.id === 'string' && typeof x.repo === 'string') : [];
}

export function saveHistory(h, store) { write(HISTORY_KEY, h.slice(0, HISTORY_MAX), store); }

export function addHistory(item, store) { saveHistory([item, ...loadHistory(store).filter((x) => x.id !== item.id)], store); }

export function historyFor(cfg, store) { return loadHistory(store).filter((x) => cfg && x.lib === cfg.repo); }
