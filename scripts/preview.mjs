// Local preview: serves web/ and a small stand-in for the GitHub API backed by a local folder, so the
// whole page (capture, edit, archive, remove, backup) works without a GitHub token. No Actions run
// here: captures wait in inbox/ until you run `python scripts/fixture_analyze.py --library <folder>`.
//
//   node scripts/preview.mjs [--library .preview/collection] [--port 8080] [--api-port 8787] [--offline]
//
// Requests about other (public) repositories, used to list SKILL.md and resolve branches, are passed to
// api.github.com without any token unless --offline is given.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const LIB = path.resolve(ROOT, arg('--library', '.preview/collection'));
const PORT = Number(arg('--port', 8080)), API_PORT = Number(arg('--api-port', 8787));
const OFFLINE = process.argv.includes('--offline');
const REPO = 'local/collection';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function seed() {
  if (fs.existsSync(path.join(LIB, 'inbox'))) return;
  fs.mkdirSync(LIB, { recursive: true });
  for (const name of ['tags.yml', 'taxonomy.yml', 'README.md']) fs.copyFileSync(path.join(ROOT, 'library-template', name), path.join(LIB, name));
  fs.mkdirSync(path.join(LIB, 'inbox'), { recursive: true });
}

const inside = (rel) => { const p = path.resolve(LIB, rel); return p === LIB || p.startsWith(LIB + path.sep) ? p : null; };
const blobSha = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
function headSha() {
  const h = crypto.createHash('sha1');
  const walk = (dir) => { for (const n of fs.readdirSync(dir).sort()) { const p = path.join(dir, n); if (fs.statSync(p).isDirectory()) walk(p); else h.update(path.relative(LIB, p)).update(fs.readFileSync(p)); } };
  walk(LIB);
  return h.digest('hex');
}
const pending = new Map();

function apiHeaders(extra = {}) {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, PUT, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Accept, Content-Type, X-GitHub-Api-Version', 'Access-Control-Expose-Headers': 'x-ratelimit-remaining, x-ratelimit-reset', 'Cache-Control': 'no-store', ...extra };
}

function library(method, rest, query, body, accept) {
  if (rest === '') return [200, { full_name: REPO, private: true, default_branch: 'main' }];
  if (rest.startsWith('/actions/')) return [403, { message: 'not available in local preview' }];
  if (method === 'GET' && rest === '/git/ref/heads/main') return [200, { object: { sha: headSha() } }];
  let m = /^\/git\/commits\/([0-9a-f]+)$/.exec(rest);
  if (method === 'GET' && m) return [200, { tree: { sha: `root-${m[1]}` } }];
  m = /^\/git\/trees\/(root|library)-[0-9a-f]+$/.exec(rest);
  if (method === 'GET' && m) {
    const dir = m[1] === 'root' ? LIB : path.join(LIB, 'library');
    const tree = fs.existsSync(dir) ? fs.readdirSync(dir).map((n) => ({ path: n, type: fs.statSync(path.join(dir, n)).isDirectory() ? 'tree' : 'blob', sha: `library-${headSha()}` })) : [];
    return [200, { tree }];
  }
  if (method === 'POST' && rest === '/git/trees') { const id = crypto.randomUUID(); pending.set(id, { base: null, tree: body.tree }); return [201, { sha: id }]; }
  if (method === 'POST' && rest === '/git/commits') { const t = pending.get(body.tree); if (!t) return [422, {}]; t.base = body.parents[0]; return [201, { sha: body.tree }]; }
  if (method === 'PATCH' && rest === '/git/refs/heads/main') {
    const t = pending.get(body.sha);
    if (!t || t.base !== headSha()) return [422, { message: 'Update is not a fast forward' }];
    for (const e of t.tree) { const p = inside(e.path); if (!p) continue; if (e.sha === null) fs.rmSync(p, { force: true }); else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, e.content); } }
    pending.delete(body.sha);
    return [200, {}];
  }
  m = /^\/contents\/(.+)$/.exec(rest);
  if (!m) return [404, { message: 'Not Found' }];
  const rel = decodeURIComponent(m[1]);
  const p = inside(rel);
  if (!p) return [404, { message: 'Not Found' }];
  const exists = fs.existsSync(p);
  if (method === 'GET') {
    if (!exists) return [404, { message: 'Not Found' }];
    if (fs.statSync(p).isDirectory()) {
      return [200, fs.readdirSync(p).map((n) => { const q = path.join(p, n); const dir = fs.statSync(q).isDirectory();
        return { name: n, path: `${rel}/${n}`, type: dir ? 'dir' : 'file', sha: dir ? null : blobSha(fs.readFileSync(q)) }; })];
    }
    const buf = fs.readFileSync(p);
    return /raw/.test(accept) ? [200, buf, true] : [200, { name: path.basename(p), path: rel, sha: blobSha(buf), content: buf.toString('base64'), encoding: 'base64' }];
  }
  if (method === 'PUT') {
    if (exists && body.sha !== blobSha(fs.readFileSync(p))) return [exists && !body.sha ? 422 : 409, { message: 'sha mismatch' }];
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const buf = Buffer.from(body.content, 'base64');
    fs.writeFileSync(p, buf);
    return [exists ? 200 : 201, { content: { path: rel, sha: blobSha(buf) } }];
  }
  if (method === 'DELETE') {
    if (!exists || body.sha !== blobSha(fs.readFileSync(p))) return [409, { message: 'sha mismatch' }];
    fs.rmSync(p);
    return [200, {}];
  }
  return [405, {}];
}

const api = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, apiHeaders()); res.end(); return; }
  const u = new URL(req.url, 'http://x');
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { res.writeHead(400, apiHeaders()); res.end('{}'); return; }
  const prefix = `/repos/${REPO}`;
  if (u.pathname === prefix || u.pathname.startsWith(`${prefix}/`)) {
    const [status, out, isRaw] = library(req.method, u.pathname.slice(prefix.length), u.searchParams, body, req.headers.accept || '');
    res.writeHead(status, apiHeaders(isRaw ? { 'Content-Type': 'application/octet-stream' } : {}));
    res.end(isRaw ? out : JSON.stringify(out));
    console.log(`api ${req.method} ${u.pathname} -> ${status}`);
    return;
  }
  // Public repositories being collected: read-only, never with a token.
  if (req.method !== 'GET' || OFFLINE || !/^\/repos\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+(\/|$)/.test(u.pathname)) {
    res.writeHead(404, apiHeaders()); res.end(JSON.stringify({ message: OFFLINE ? 'offline preview' : 'Not Found' })); return;
  }
  try {
    const up = await fetch(`https://api.github.com${u.pathname}${u.search}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'collective-hub-preview' } });
    res.writeHead(up.status, apiHeaders({ 'x-ratelimit-remaining': up.headers.get('x-ratelimit-remaining') || '', 'x-ratelimit-reset': up.headers.get('x-ratelimit-reset') || '' }));
    res.end(await up.text());
  } catch { res.writeHead(502, apiHeaders()); res.end(JSON.stringify({ message: 'cannot reach api.github.com' })); }
});

const web = http.createServer((req, res) => {
  if (req.method === 'POST') { res.writeHead(404); res.end(); return; }
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.resolve(WEB, rel);
  if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

seed();
api.listen(API_PORT, '127.0.0.1', () => web.listen(PORT, '127.0.0.1', () => {
  console.log(`GitHub Collective Hub 本機預覽
  網頁：        http://127.0.0.1:${PORT}/
  收藏庫資料夾：${LIB}
  在網頁的「連結收藏庫」填：
    收藏庫 ${REPO}
    token  任意文字（例如 local-preview；不會送到 GitHub）
    本機模擬 API http://127.0.0.1:${API_PORT}
  模擬一次分析（fixture，非 Claude）：python scripts/fixture_analyze.py --library "${LIB}"
  ${OFFLINE ? '離線模式：不會查詢公開 repo。' : '列出 SKILL.md／解析分支時，會不帶 token 查詢 api.github.com 的公開資料。'}`);
}));
