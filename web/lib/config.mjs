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

export function loadCfg(store) {
  const cfg = read(CFG_KEY, store);
  return cfg && typeof cfg === 'object' ? cfg : null;
}

export function saveCfg(cfg, store) { return write(CFG_KEY, cfg, store); }

export const isDemo = (cfg) => Boolean(cfg && cfg.demo === true);
export const connected = (cfg) => Boolean(cfg && (isDemo(cfg) || (cfg.repo && cfg.token)));

export function loadHistory(store) {
  const h = read(HISTORY_KEY, store);
  return Array.isArray(h) ? h.filter((x) => x && typeof x.id === 'string' && typeof x.repo === 'string') : [];
}

export function saveHistory(h, store) { write(HISTORY_KEY, h.slice(0, HISTORY_MAX), store); }

export function addHistory(item, store) { saveHistory([item, ...loadHistory(store).filter((x) => x.id !== item.id)], store); }

export function historyFor(cfg, store) { return loadHistory(store).filter((x) => cfg && x.lib === cfg.repo); }
