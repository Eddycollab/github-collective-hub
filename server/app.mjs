// One service for the page, GitHub sign-in and the library API.
//
// - /auth/login, /auth/callback: GitHub OAuth (no scopes, PKCE S256, signed state cookie). The OAuth
//   token is used once to read the user's id and then revoked; it is never stored or sent to the page.
// - Only ALLOWED_GITHUB_ID gets a session (signed HttpOnly cookie, absolute + idle expiry).
// - /api/gh/...: an allowlisted proxy to the GitHub API with LIBRARY_TOKEN (see proxy.mjs). Every call
//   needs a session; writes also need the X-CSRF-Token header and a same-origin Origin.
// - Everything else is the static page from web/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRequest } from './proxy.mjs';
import { keys as deriveKeys, sign, verify, randomToken, pkceChallenge, safeEqual, csrfToken, parseCookies, cookieNames,
  serializeCookie, Revoked, sessionValid, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, SESSION_REFRESH_MS, OAUTH_TTL_MS } from './session.mjs';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png' };
const BODY_MAX = 5 * 1024 * 1024;
const UA = 'github-collective-hub';
const ACCEPTS = new Set(['application/vnd.github+json', 'application/vnd.github.raw+json']);

const CSP = ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "connect-src 'self'", "font-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'",
  "worker-src 'self'", "manifest-src 'self'"].join('; ');

function baseHeaders(cfg) {
  return {
    'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin', 'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
    ...(cfg.secure ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const page = (title, body) => `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="/tokens.css"></head><body class="auth-page"><main style="max-width:32rem;margin:15vh auto;padding:0 16px">
<h1>${esc(title)}</h1>${body}</main></body></html>`;

export function createApp(cfg, { fetchImpl = fetch, now = () => Date.now(), log = (line) => console.log(line) } = {}) {
  const k = deriveKeys(cfg.sessionSecret);
  const names = cookieNames(cfg.secure);
  const revoked = new Revoked();

  const send = (res, status, headers, body = '') => {
    res.writeHead(status, { ...baseHeaders(cfg), ...headers });
    res.end(body);
  };
  const json = (res, status, data, extra = {}) => send(res, status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }, JSON.stringify(data));
  const html = (res, status, title, body, extra = {}) => send(res, status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extra }, page(title, body));
  const cookie = (name, value, maxAgeMs) => serializeCookie(name, value, { maxAgeMs, secure: cfg.secure });

  // -> { payload, setCookie } for a valid session, else null. Refreshes the idle timer at most every 10 min.
  function readSession(req) {
    const p = verify(k.session, parseCookies(req.headers.cookie)[names.session]);
    const t = now();
    if (!sessionValid(p, { now: t, allowedId: cfg.allowedId, revoked })) return null;
    if (t - p.seen < SESSION_REFRESH_MS) return { payload: p, setCookie: null };
    const next = { ...p, seen: t };
    return { payload: next, setCookie: cookie(names.session, sign(k.session, next), p.iat + SESSION_ABSOLUTE_MS - t) };
  }

  // --- OAuth

  function login(req, res) {
    const state = randomToken(), verifier = randomToken(48);
    const handshake = sign(k.oauth, { s: state, v: verifier, e: now() + OAUTH_TTL_MS });
    const u = new URL('/login/oauth/authorize', cfg.oauthUrl);
    u.search = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: `${cfg.publicUrl}/auth/callback`, state,
      code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256', allow_signup: 'false' }).toString();
    send(res, 302, { Location: u.href, 'Cache-Control': 'no-store', 'Set-Cookie': cookie(names.oauth, handshake, OAUTH_TTL_MS) });
  }

  async function callback(req, res, url) {
    const clear = cookie(names.oauth, '', 0);
    const retry = '<p><a href="/auth/login">重新登入</a>　<a href="/">回到收藏頁</a></p>';
    const fail = (status, msg) => html(res, status, '登入失敗', `<p>${esc(msg)}</p>${retry}`, { 'Set-Cookie': clear });
    if (url.searchParams.get('error')) return fail(400, 'GitHub 沒有完成授權（可能按了取消）。');
    const hs = verify(k.oauth, parseCookies(req.headers.cookie)[names.oauth]);
    const state = url.searchParams.get('state') || '', code = url.searchParams.get('code') || '';
    if (!hs || typeof hs.s !== 'string' || typeof hs.v !== 'string' || !(hs.e > now())) return fail(400, '登入流程已過期或不是從這裡開始的，請重新登入。');
    if (!state || !safeEqual(state, hs.s) || !/^[A-Za-z0-9_-]{1,100}$/.test(code)) return fail(400, '登入驗證失敗（state 不符），請重新登入。');
    let token = null;
    try {
      const r = await fetchImpl(new URL('/login/oauth/access_token', cfg.oauthUrl), {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: `${cfg.publicUrl}/auth/callback`, code_verifier: hs.v }),
      });
      const data = r.ok ? await r.json() : null;
      token = data && typeof data.access_token === 'string' ? data.access_token : null;
    } catch { /* reported below */ }
    if (!token) return fail(502, 'GitHub 沒有發出登入憑證，請重新登入。');
    let user = null;
    try {
      const r = await fetchImpl(`${cfg.apiUrl}/user`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': UA } });
      user = r.ok ? await r.json() : null;
    } catch { /* reported below */ }
    revokeOAuthToken(token);
    if (!user || !Number.isInteger(user.id)) return fail(502, '讀不到 GitHub 帳號資料，請重新登入。');
    if (user.id !== cfg.allowedId) {
      log(`auth: refused sign-in for GitHub user id ${user.id}`);
      return html(res, 403, '沒有權限', '<p>這個網站只供擁有者使用。</p><p><a href="/">回到首頁</a></p>', { 'Set-Cookie': clear });
    }
    const t = now();
    const session = { sid: randomToken(18), uid: user.id, login: String(user.login || ''), iat: t, seen: t };
    log('auth: signed in');
    send(res, 303, { Location: '/', 'Cache-Control': 'no-store', 'Set-Cookie': [clear, cookie(names.session, sign(k.session, session), SESSION_ABSOLUTE_MS)] });
  }

  // The sign-in token has no scopes and is not needed after the id check: delete it at GitHub.
  function revokeOAuthToken(token) {
    const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
    fetchImpl(`${cfg.apiUrl}/applications/${encodeURIComponent(cfg.clientId)}/token`, {
      method: 'DELETE', headers: { Authorization: `Basic ${basic}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ access_token: token }),
    }).then((r) => { if (r.status !== 204) log(`auth: revoking the sign-in token returned ${r.status}`); })
      .catch(() => log('auth: revoking the sign-in token failed'));
  }

  const sameOrigin = (req) => req.headers.origin === cfg.publicUrl;
  const csrfOk = (req, s) => safeEqual(req.headers['x-csrf-token'] || '', csrfToken(k, s.payload.sid));

  function logout(req, res) {
    const s = readSession(req);
    if (s) {
      if (!sameOrigin(req) || !csrfOk(req, s)) return json(res, 403, { error: 'csrf' });
      revoked.add(s.payload.sid, s.payload.iat + SESSION_ABSOLUTE_MS);
    }
    json(res, 200, { ok: true }, { 'Set-Cookie': cookie(names.session, '', 0) });
  }

  function sessionInfo(req, res) {
    const s = readSession(req);
    if (!s) return json(res, 200, { server: 'collective', authenticated: false });
    json(res, 200, { server: 'collective', authenticated: true, login: s.payload.login, repo: cfg.libraryRepo,
      csrf: csrfToken(k, s.payload.sid), expires_at: new Date(Math.min(s.payload.iat + SESSION_ABSOLUTE_MS, s.payload.seen + SESSION_IDLE_MS)).toISOString() },
    s.setCookie ? { 'Set-Cookie': s.setCookie } : {});
  }

  // --- library proxy

  async function readBody(req) {
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > BODY_MAX) return { tooLarge: true }; chunks.push(c); }
    if (!size) return { body: null };
    try { return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; } catch { return { bad: true }; }
  }

  async function proxy(req, res, url) {
    const s = readSession(req);
    if (!s) return json(res, 401, { message: 'login required' });
    const extra = s.setCookie ? { 'Set-Cookie': s.setCookie } : {};
    const write = req.method !== 'GET' && req.method !== 'HEAD';
    if (write && (!sameOrigin(req) || !csrfOk(req, s))) return json(res, 403, { message: 'csrf check failed' }, extra);
    const b = write ? await readBody(req) : { body: undefined };
    if (b.tooLarge) return json(res, 413, { message: 'body too large' }, extra);
    if (b.bad) return json(res, 400, { message: 'body must be JSON' }, extra);
    const check = checkRequest({ method: req.method, pathname: url.pathname, query: url.searchParams, body: b.body }, cfg.libraryRepo);
    if (!check.ok) { log(`proxy: refused ${req.method} ${url.pathname.slice(0, 200)} (${check.reason})`); return json(res, check.status, { message: check.reason }, extra); }
    const accept = ACCEPTS.has(req.headers.accept) ? req.headers.accept : 'application/vnd.github+json';
    let up;
    try {
      up = await fetchImpl(`${cfg.apiUrl}/repos/${check.repo}${check.rest}${url.search}`, {
        method: req.method, redirect: 'manual',
        headers: { Authorization: `Bearer ${cfg.libraryToken}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': UA,
          ...(b.body ? { 'Content-Type': 'application/json' } : {}) },
        body: b.body ? JSON.stringify(b.body) : undefined,
      });
    } catch { return json(res, 502, { message: 'cannot reach GitHub' }, extra); }
    const out = Buffer.from(await up.arrayBuffer());
    const h = { 'Content-Type': up.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store', ...extra };
    for (const name of ['x-ratelimit-remaining', 'x-ratelimit-reset']) { const v = up.headers.get(name); if (v) h[name] = v; }
    send(res, up.status, h, out);
  }

  // --- static page

  function serveStatic(req, res, url) {
    let rel;
    try { rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'; } catch { return send(res, 400, {}, ''); }
    const file = path.resolve(WEB, rel);
    const type = TYPES[path.extname(file)];
    if (!file.startsWith(WEB + path.sep) || rel.split('/')[0] === 'tests' || !type || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not Found');
    }
    send(res, 200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }, req.method === 'HEAD' ? '' : fs.readFileSync(file));
  }

  return async function handle(req, res) {
    const started = now();
    let url;
    try { url = new URL(req.url, cfg.publicUrl); } catch { return send(res, 400, {}, ''); }
    try {
      const p = url.pathname;
      if (p === '/healthz') send(res, 200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }, 'ok');
      else if (p === '/auth/login' && req.method === 'GET') login(req, res);
      else if (p === '/auth/callback' && req.method === 'GET') await callback(req, res, url);
      else if (p === '/auth/logout' && req.method === 'POST') logout(req, res);
      else if (p === '/api/session' && req.method === 'GET') sessionInfo(req, res);
      else if (p.startsWith('/api/gh/')) await proxy(req, res, url);
      else if (p.startsWith('/api/') || p.startsWith('/auth/')) json(res, 404, { message: 'Not Found' });
      else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
      else send(res, 405, { Allow: 'GET, HEAD' }, '');
    } catch (e) {
      log(`error: ${e && e.name ? e.name : 'Error'} on ${req.method} ${url.pathname.slice(0, 200)}`);
      if (!res.headersSent) json(res, 500, { message: 'internal error' });
    } finally {
      // Paths only: queries carry OAuth codes and state.
      log(`${req.method} ${url.pathname.slice(0, 200)} ${res.statusCode} ${now() - started}ms`);
    }
  };
}
