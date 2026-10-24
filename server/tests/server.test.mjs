// Server: OAuth sign-in (state, PKCE, allowed id), session cookie, CSRF, the library proxy allowlist,
// static files, and that no secret ever reaches a response or the log. GitHub is a mock fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { readConfig } from '../config.mjs';
import { createApp } from '../app.mjs';
import { checkRequest } from '../proxy.mjs';
import { SESSION_IDLE_MS, SESSION_ABSOLUTE_MS } from '../session.mjs';

const PUBLIC = 'http://localhost:9999';
const SECRETS = { GITHUB_CLIENT_SECRET: 'client-secret-0123456789abcdef', SESSION_SECRET: 's'.repeat(48), LIBRARY_TOKEN: 'github_pat_LIBRARYTOKEN0123456789' };
const ENV = { GITHUB_CLIENT_ID: 'Iv1.testclient', ALLOWED_GITHUB_ID: '64090020', PUBLIC_URL: PUBLIC, GITHUB_API_URL: 'http://127.0.0.1:1',
  GITHUB_OAUTH_URL: 'http://127.0.0.1:2', ...SECRETS };
const LIB = 'Eddycollab/github-library-collection-';
const OAUTH_TOKEN = 'gho_SIGNINTOKEN0123456789';

// A stand-in for github.com and api.github.com.
function mockGitHub({ userId = 64090020 } = {}) {
  const gh = { calls: [], revoked: [], challenge: null, userId };
  gh.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    const headers = init.headers || {};
    gh.calls.push({ method, url: url.href, auth: headers.Authorization || '', body: init.body ? JSON.parse(init.body) : null });
    const reply = (status, data, extra = {}) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...extra } });
    if (url.pathname === '/login/oauth/access_token') {
      const b = JSON.parse(init.body);
      const pkce = crypto.createHash('sha256').update(b.code_verifier || '').digest('base64url');
      if (b.code !== 'good-code' || pkce !== gh.challenge || b.client_secret !== SECRETS.GITHUB_CLIENT_SECRET) return reply(200, { error: 'bad_verification_code' });
      return reply(200, { access_token: OAUTH_TOKEN, scope: '', token_type: 'bearer' });
    }
    if (url.pathname === '/user') return headers.Authorization === `Bearer ${OAUTH_TOKEN}` ? reply(200, { id: gh.userId, login: 'Eddycollab' }) : reply(401, {});
    if (url.pathname === '/applications/Iv1.testclient/token' && method === 'DELETE') { gh.revoked.push(JSON.parse(init.body).access_token); return reply(204); }
    if (url.pathname.startsWith('/repos/')) return reply(200, { path: url.pathname, query: url.search }, { 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': '1700000000' });
    return reply(404, {});
  };
  return gh;
}

async function start(opts = {}) {
  const gh = mockGitHub(opts);
  const logs = [];
  let clock = Date.parse('2026-10-24T10:00:00Z');
  const app = createApp(readConfig({ ...ENV, ...(opts.env || {}) }), { fetchImpl: gh.fetch, now: () => clock, log: (l) => logs.push(l) });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const responses = [];
  const req = async (path, { method = 'GET', cookie = '', headers = {}, body } = {}) => {
    const r = await fetch(base + path, { method, redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    responses.push(text + JSON.stringify([...r.headers]));
    return { status: r.status, headers: r.headers, text, json: () => JSON.parse(text), setCookie: r.headers.getSetCookie() };
  };
  return { gh, logs, req, responses, tick: (ms) => { clock += ms; }, close: () => new Promise((r) => server.close(r)) };
}

const cookieValue = (setCookie, name) => { const c = setCookie.find((x) => x.startsWith(`${name}=`)); return c ? c.split(';')[0] : ''; };

// Runs the whole sign-in; returns the session cookie and CSRF token.
async function signIn(t) {
  const login = await t.req('/auth/login');
  const loc = new URL(login.headers.get('location'));
  t.gh.challenge = loc.searchParams.get('code_challenge');
  const oauth = cookieValue(login.setCookie, 'ch_oauth');
  const cb = await t.req(`/auth/callback?code=good-code&state=${loc.searchParams.get('state')}`, { cookie: oauth });
  const session = cookieValue(cb.setCookie, 'ch_session');
  const info = (await t.req('/api/session', { cookie: session })).json();
  return { cb, session, csrf: info.csrf, info };
}

const noSecrets = (t) => {
  const all = [...t.responses, ...t.logs].join('\n');
  for (const s of [...Object.values(SECRETS), OAUTH_TOKEN]) assert.ok(!all.includes(s), 'a secret reached a response or the log');
};

test('config: required variables are named, values never echoed; non-loopback overrides refused', () => {
  assert.throws(() => readConfig({}), /missing environment variables: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, SESSION_SECRET, ALLOWED_GITHUB_ID, LIBRARY_TOKEN, PUBLIC_URL/);
  assert.throws(() => readConfig({ ...ENV, SESSION_SECRET: 'short' }), (e) => /SESSION_SECRET/.test(e.message) && !e.message.includes('short'));
  assert.throws(() => readConfig({ ...ENV, ALLOWED_GITHUB_ID: 'Eddycollab' }), /numeric/);
  assert.throws(() => readConfig({ ...ENV, PUBLIC_URL: 'http://example.com' }), /https/);
  assert.throws(() => readConfig({ ...ENV, GITHUB_API_URL: 'https://evil.example' }), /localhost/);
  const cfg = readConfig({ ...ENV, GITHUB_API_URL: '', GITHUB_OAUTH_URL: '', PUBLIC_URL: 'https://hub.example.app/' });
  assert.deepEqual([cfg.apiUrl, cfg.oauthUrl, cfg.libraryRepo, cfg.publicUrl, cfg.secure, cfg.allowedId],
    ['https://api.github.com', 'https://github.com', LIB, 'https://hub.example.app', true, 64090020]);
});

test('login redirect: no scopes, S256 PKCE, random state, HttpOnly SameSite=Lax handshake cookie', async () => {
  const t = await start();
  const r = await t.req('/auth/login');
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'http://127.0.0.1:2/login/oauth/authorize');
  assert.equal(loc.searchParams.get('scope'), null, 'identity only: no scope requested');
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  assert.match(loc.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.match(loc.searchParams.get('state'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(loc.searchParams.get('redirect_uri'), `${PUBLIC}/auth/callback`);
  const c = r.setCookie.find((x) => x.startsWith('ch_oauth='));
  assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Lax/); assert.match(c, /Max-Age=600/);
  const again = new URL((await t.req('/auth/login')).headers.get('location'));
  assert.notEqual(again.searchParams.get('state'), loc.searchParams.get('state'));
  await t.close();
});

test('https deployment uses __Host- cookies with Secure', async () => {
  const t = await start({ env: { PUBLIC_URL: 'https://hub.example.app' } });
  const r = await t.req('/auth/login');
  assert.match(r.setCookie[0], /^__Host-ch_oauth=.*; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=600$/);
  assert.match(r.headers.get('strict-transport-security'), /max-age=/);
  await t.close();
});

test('callback: the allowed id gets a session; the sign-in token is revoked and never stored', async () => {
  const t = await start();
  const { cb, session, info } = await signIn(t);
  assert.equal(cb.status, 303);
  assert.equal(cb.headers.get('location'), '/');
  assert.ok(session.startsWith('ch_session='));
  const c = cb.setCookie.find((x) => x.startsWith('ch_session='));
  assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Lax/); assert.match(c, new RegExp(`Max-Age=${SESSION_ABSOLUTE_MS / 1000}`));
  assert.ok(cb.setCookie.some((x) => /^ch_oauth=; .*Max-Age=0/.test(x)), 'handshake cookie cleared');
  assert.deepEqual([info.authenticated, info.login, info.repo], [true, 'Eddycollab', LIB]);
  assert.match(info.csrf, /^[A-Za-z0-9_-]{43}$/);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(t.gh.revoked, [OAUTH_TOKEN]);
  assert.ok(!session.includes(OAUTH_TOKEN) && !Buffer.from(session.split('=')[1].split('.')[0], 'base64url').toString().includes('gho_'));
  noSecrets(t);
  await t.close();
});

test('callback: a different GitHub account is refused by id, even with the same login name', async () => {
  const t = await start({ userId: 999 });
  const login = await t.req('/auth/login');
  const loc = new URL(login.headers.get('location'));
  t.gh.challenge = loc.searchParams.get('code_challenge');
  const cb = await t.req(`/auth/callback?code=good-code&state=${loc.searchParams.get('state')}`, { cookie: cookieValue(login.setCookie, 'ch_oauth') });
  assert.equal(cb.status, 403);
  assert.ok(!cb.setCookie.some((x) => x.startsWith('ch_session=') && !/Max-Age=0/.test(x)));
  assert.ok(t.logs.some((l) => l.includes('refused sign-in for GitHub user id 999')));
  await t.close();
});

test('callback: wrong state, missing or expired handshake, bad PKCE verifier and denial all fail without a session', async () => {
  const t = await start();
  const login = await t.req('/auth/login');
  const loc = new URL(login.headers.get('location'));
  const oauth = cookieValue(login.setCookie, 'ch_oauth');
  t.gh.challenge = loc.searchParams.get('code_challenge');
  const state = loc.searchParams.get('state');
  const cases = [
    [`/auth/callback?code=good-code&state=${state}x`, oauth, 400],
    [`/auth/callback?code=good-code&state=${state}`, '', 400],
    [`/auth/callback?code=good-code&state=${state}`, oauth.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), 400],
    ['/auth/callback?error=access_denied', oauth, 400],
  ];
  for (const [path, cookie, status] of cases) {
    const r = await t.req(path, { cookie });
    assert.equal(r.status, status, path);
    assert.ok(!r.setCookie.some((x) => x.startsWith('ch_session=')), path);
  }
  t.gh.challenge = 'not-the-challenge';
  assert.equal((await t.req(`/auth/callback?code=good-code&state=${state}`, { cookie: oauth })).status, 502, 'PKCE verifier mismatch');
  t.gh.challenge = loc.searchParams.get('code_challenge');
  t.tick(11 * 60 * 1000);
  assert.equal((await t.req(`/auth/callback?code=good-code&state=${state}`, { cookie: oauth })).status, 400, 'handshake expired');
  await t.close();
});

test('private API needs a session; tampered, idle-expired and absolute-expired sessions are rejected', async () => {
  const t = await start();
  assert.equal((await t.req(`/api/gh/repos/${LIB}/contents/index.json`)).status, 401);
  assert.deepEqual((await t.req('/api/session')).json(), { server: 'collective', authenticated: false });
  const { session } = await signIn(t);
  assert.equal((await t.req(`/api/gh/repos/${LIB}/contents/index.json`, { cookie: session })).status, 200);
  const [name, value] = session.split('=');
  const [body, sig] = value.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), uid: 1 })).toString('base64url');
  assert.equal((await t.req(`/api/gh/repos/${LIB}`, { cookie: `${name}=${forged}.${sig}` })).status, 401, 'tampered');
  t.tick(SESSION_IDLE_MS + 1000);
  assert.equal((await t.req(`/api/gh/repos/${LIB}`, { cookie: session })).status, 401, 'idle');
  await t.close();

  const t2 = await start();
  let s2 = (await signIn(t2)).session;
  // Stay active (each call refreshes the idle timer) until the absolute limit passes.
  for (let gone = 0; gone < SESSION_ABSOLUTE_MS; gone += SESSION_IDLE_MS / 2) {
    t2.tick(SESSION_IDLE_MS / 2);
    const r = await t2.req(`/api/gh/repos/${LIB}`, { cookie: s2 });
    if (r.status !== 200) { assert.ok(gone + SESSION_IDLE_MS / 2 >= SESSION_ABSOLUTE_MS, `ended early at ${gone}`); s2 = null; break; }
    s2 = cookieValue(r.setCookie, 'ch_session') || s2;
  }
  assert.equal(s2, null, 'absolute expiry reached');
  await t2.close();
});

test('writes need the CSRF token and a same-origin Origin; logout revokes the session', async () => {
  const t = await start();
  const { session, csrf } = await signIn(t);
  const put = (headers) => t.req(`/api/gh/repos/${LIB}/contents/inbox/20261024-120000-abcdef01.json`, { method: 'PUT', cookie: session, headers, body: { message: 'capture', content: 'e30K' } });
  assert.equal((await put({ Origin: PUBLIC })).status, 403, 'no csrf header');
  assert.equal((await put({ Origin: PUBLIC, 'X-CSRF-Token': 'x'.repeat(43) })).status, 403, 'wrong csrf');
  assert.equal((await put({ Origin: 'https://evil.example', 'X-CSRF-Token': csrf })).status, 403, 'cross-origin');
  assert.equal((await put({ 'X-CSRF-Token': csrf })).status, 403, 'no Origin');
  const ok = await put({ Origin: PUBLIC, 'X-CSRF-Token': csrf });
  assert.equal(ok.status, 200);
  const sent = t.gh.calls.at(-1);
  assert.deepEqual([sent.method, sent.url, sent.auth], ['PUT', `http://127.0.0.1:1/repos/${LIB}/contents/inbox/20261024-120000-abcdef01.json`, `Bearer ${SECRETS.LIBRARY_TOKEN}`]);
  assert.equal(ok.headers.get('x-ratelimit-remaining'), '4999');

  assert.equal((await t.req('/auth/logout', { method: 'POST', cookie: session, headers: { Origin: PUBLIC } })).status, 403, 'logout needs csrf');
  const out = await t.req('/auth/logout', { method: 'POST', cookie: session, headers: { Origin: PUBLIC, 'X-CSRF-Token': csrf } });
  assert.equal(out.status, 200);
  assert.ok(out.setCookie.some((x) => /^ch_session=; .*Max-Age=0/.test(x)));
  assert.equal((await t.req(`/api/gh/repos/${LIB}`, { cookie: session })).status, 401, 'old cookie no longer works');
  assert.equal((await t.req('/api/session', { cookie: session })).json().authenticated, false);
  noSecrets(t);
  await t.close();
});

test('proxy allowlist: only what the page does', () => {
  const ok = (method, path, body, query = '') => checkRequest({ method, pathname: `/api/gh/repos/${path}`, query: new URLSearchParams(query), body }, LIB);
  const allowed = [
    ['GET', LIB], ['GET', `${LIB}/contents/index.json`, undefined, 'ref=abc'], ['GET', `${LIB}/contents/user.json`], ['GET', `${LIB}/contents/inbox`],
    ['GET', `${LIB}/contents/inbox/failed/20261024-173056-d9dad555.json`], ['GET', `${LIB}/contents/library/abi__screenshot-to-code.svg`],
    ['GET', `${LIB}/git/ref/heads/main`], ['GET', `${LIB}/git/trees/0e0d1c64e1907e0848c4701153e43c275c751a26`], ['GET', `${LIB}/actions/runs`, undefined, 'status=in_progress&per_page=5'],
    ['PUT', `${LIB}/contents/inbox/20261024-182527-b530ad97.json`, { message: 'm', content: 'e30=' }], ['PUT', `${LIB}/contents/user.json`, { message: 'm', content: 'e30=' }],
    ['DELETE', `${LIB}/contents/inbox/failed/20261024-173056-d9dad555.json`, { message: 'm', sha: 'x' }],
    ['POST', `${LIB}/git/trees`, { base_tree: 't', tree: [{ path: 'library/a__b.md', mode: '100644', type: 'blob', sha: null }, { path: 'index.json', mode: '100644', type: 'blob', content: '{}' }] }],
    ['PATCH', `${LIB}/git/refs/heads/main`, { sha: 'c', force: false }],
    ['GET', 'abi/screenshot-to-code'], ['GET', 'owner/repo/git/matching-refs/heads/feature/x'], ['GET', 'owner/repo/git/trees/feature/x', undefined, 'recursive=1'],
  ];
  for (const a of allowed) assert.equal(ok(...a).ok, true, a.join(' '));
  const refused = [
    ['PUT', `${LIB}/contents/.github/workflows/collective.yml`, { message: 'm', content: 'x' }],
    ['PUT', `${LIB}/contents/library/a__b.md`, { message: 'm', content: 'x' }],
    ['PUT', `${LIB}/contents/inbox/../tags.yml`, { message: 'm', content: 'x' }],
    ['DELETE', `${LIB}/contents/index.json`, { message: 'm', sha: 'x' }],
    ['POST', `${LIB}/git/trees`, { tree: [{ path: '.github/workflows/x.yml', mode: '100644', type: 'blob', content: 'x' }] }],
    ['POST', `${LIB}/git/trees`, { tree: [{ path: 'library/a__b.md', mode: '100755', type: 'blob', content: 'x' }] }],
    ['PATCH', `${LIB}/git/refs/heads/main`, { sha: 'c', force: true }],
    ['GET', `${LIB}/contents/index.json`, undefined, 'evil=1'],
    ['GET', `${LIB}/hooks`], ['POST', `${LIB}/actions/workflows/x/dispatches`, {}], ['DELETE', LIB, {}], ['GET', `${LIB}/collaborators`],
    ['PUT', `owner/repo/contents/inbox/20261024-182527-b530ad97.json`, { message: 'm', content: 'x' }], ['GET', 'owner/repo/contents/README.md'],
    ['GET', 'owner/repo/git/trees/a%2F..%2Fb'],
  ];
  for (const r of refused) assert.equal(ok(...r).ok, false, r.join(' '));
  assert.equal(checkRequest({ method: 'GET', pathname: '/api/gh/user', query: new URLSearchParams(), body: undefined }, LIB).ok, false);
});

test('a refused proxy call never reaches GitHub', async () => {
  const t = await start();
  const { session, csrf } = await signIn(t);
  const before = t.gh.calls.length;
  const r = await t.req(`/api/gh/repos/${LIB}/contents/.github/workflows/collective.yml`, { method: 'PUT', cookie: session, headers: { Origin: PUBLIC, 'X-CSRF-Token': csrf }, body: { message: 'x', content: 'x' } });
  assert.equal(r.status, 403);
  assert.equal(t.gh.calls.length, before);
  await t.close();
});

test('static page with security headers; tests, traversal and unknown routes are not served', async () => {
  const t = await start();
  const index = await t.req('/');
  assert.equal(index.status, 200);
  assert.match(index.text, /<script type="module" src="app.js">/);
  assert.match(index.headers.get('content-security-policy'), /default-src 'self'.*connect-src 'self'.*frame-ancestors 'none'/);
  assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(index.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await t.req('/lib/config.mjs')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  for (const p of ['/tests/collection.test.mjs', '/..%2fserver/config.mjs', '/%2e%2e/package.json', '/api/unknown', '/auth/nope']) assert.equal((await t.req(p)).status, 404, p);
  assert.equal((await t.req('/', { method: 'POST' })).status, 405);
  assert.equal((await t.req('/healthz')).text, 'ok');
  noSecrets(t);
  await t.close();
});
