// Demo mode: a read-only stand-in for the GitHub API that serves web/demo/. Every write is refused,
// so the page can never pretend something was saved or analyzed. The owner `collective-demo` is
// fictional and demo entries carry no GitHub link and no star count.

import { DEMO_REPO } from './config.mjs';

const BASE = new URL('../demo/', import.meta.url);
const PREFIX = `/repos/${DEMO_REPO}`;

function b64(text) {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export async function demoTransport(url, opts = {}) {
  const u = new URL(url);
  const method = (opts.method || 'GET').toUpperCase();
  if (method !== 'GET') return json(405, { message: 'demo mode is read-only' });
  if (!u.pathname.startsWith(PREFIX)) return json(404, { message: 'Not Found' });
  const rest = u.pathname.slice(PREFIX.length);
  if (rest === '') return json(200, { full_name: DEMO_REPO, private: true, default_branch: 'main' });
  if (rest.startsWith('/actions/')) return json(403, { message: 'demo' });
  const m = /^\/contents\/(.+)$/.exec(rest);
  if (!m) return json(404, { message: 'Not Found' });
  const path = decodeURIComponent(m[1]);
  if (!/^[A-Za-z0-9._/-]+$/.test(path) || path.includes('..')) return json(404, { message: 'Not Found' });
  if (path === 'inbox' || path === 'inbox/failed') {
    const res = await fetch(new URL(`${path.replace('/', '-')}.list.json`, BASE));
    return res.ok ? json(200, await res.json()) : json(404, { message: 'Not Found' });
  }
  const res = await fetch(new URL(path, BASE));
  if (!res.ok) return json(404, { message: 'Not Found' });
  const text = await res.text();
  const raw = String((opts.headers || {}).Accept || '').includes('raw');
  return raw ? new Response(text, { status: 200 }) : json(200, { name: path.split('/').pop(), path, sha: 'demo', content: b64(text), encoding: 'base64' });
}
