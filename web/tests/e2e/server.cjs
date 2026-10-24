// Server mode end to end: the real server (server/index.mjs) with a mock github.com (OAuth) and the local
// preview's mock API as the library. Signs in through the OAuth redirect, captures, reads, checks CSRF,
// the HttpOnly session and that no token reaches the browser or the server log, then signs out.
// Run: PW_CORE=/path/to/playwright-core [PW_CHROME=...] node web/tests/e2e/server.cjs   (exit 1 on any mismatch)
const { chromium } = require(process.env.PW_CORE || 'playwright-core');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '../../..');
const LIB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'collective-server-e2e-'));
const SECRETS = { GITHUB_CLIENT_SECRET: `cs-${crypto.randomBytes(12).toString('hex')}`, SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
  LIBRARY_TOKEN: `github_pat_E2E${crypto.randomBytes(12).toString('hex')}` };
const OAUTH_TOKEN = `gho_E2E${crypto.randomBytes(12).toString('hex')}`;
const freePort = () => new Promise((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const [webPort, apiPort, ghPort, port] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
  const procs = [];
  const logs = [];
  const run = (args, env = {}) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env } });
    p.stdout.on('data', (d) => logs.push(String(d))); p.stderr.on('data', (d) => logs.push(String(d)));
    procs.push(p);
    return p;
  };
  // The library: preview's mock GitHub API over a temporary folder.
  run(['scripts/preview.mjs', '--library', LIB_DIR, '--port', String(webPort), '--api-port', String(apiPort), '--offline']);

  // github.com + the parts of api.github.com the sign-in uses; /repos/* goes on to the preview mock.
  const gh = { challenge: null, tokenRequests: [], revoked: [], libraryAuth: new Set() };
  const mock = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    let raw = ''; for await (const c of req) raw += c;
    const reply = (status, data, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(data === undefined ? '' : JSON.stringify(data)); };
    if (u.pathname === '/login/oauth/authorize') {
      gh.challenge = u.searchParams.get('code_challenge');
      gh.scope = u.searchParams.get('scope');
      const back = new URL(u.searchParams.get('redirect_uri'));
      back.search = new URLSearchParams({ code: 'e2e-code', state: u.searchParams.get('state') }).toString();
      res.writeHead(302, { Location: back.href }); res.end(); return;
    }
    if (u.pathname === '/login/oauth/access_token') {
      const b = JSON.parse(raw);
      gh.tokenRequests.push(b.code);
      const ok = b.code === 'e2e-code' && crypto.createHash('sha256').update(b.code_verifier).digest('base64url') === gh.challenge && b.client_secret === SECRETS.GITHUB_CLIENT_SECRET;
      return reply(200, ok ? { access_token: OAUTH_TOKEN, scope: '' } : { error: 'bad_verification_code' });
    }
    if (u.pathname === '/user') return req.headers.authorization === `Bearer ${OAUTH_TOKEN}` ? reply(200, { id: 64090020, login: 'Eddycollab' }) : reply(401, {});
    if (u.pathname.startsWith('/applications/') && req.method === 'DELETE') { gh.revoked.push(JSON.parse(raw).access_token); return reply(204); }
    if (u.pathname.startsWith('/repos/')) {
      gh.libraryAuth.add(req.headers.authorization || '');
      const up = await fetch(`http://127.0.0.1:${apiPort}${u.pathname}${u.search}`, { method: req.method, headers: { accept: req.headers.accept || '', 'content-type': 'application/json' }, body: raw || undefined });
      res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json' }); res.end(Buffer.from(await up.arrayBuffer())); return;
    }
    reply(404, { message: 'Not Found' });
  });
  await new Promise((r) => mock.listen(ghPort, '127.0.0.1', r));

  const origin = `http://127.0.0.1:${port}`;
  run(['server/index.mjs'], { PORT: String(port), PUBLIC_URL: origin, GITHUB_CLIENT_ID: 'Iv1.e2e', ALLOWED_GITHUB_ID: '64090020',
    LIBRARY_REPO: 'local/collection', GITHUB_API_URL: `http://127.0.0.1:${ghPort}`, GITHUB_OAUTH_URL: `http://127.0.0.1:${ghPort}`, ...SECRETS });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${origin}/healthz`)).ok) break; } catch { /* starting */ } await wait(100); }

  const browser = await chromium.launch(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {});
  const failures = [];
  const expect = (label, cond, detail) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : ` — ${detail}`}`); if (!cond) failures.push(label); };
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    const errors = [], requests = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // Expected API answers (an empty library has no index.json / user.json yet; refusals are tested on purpose)
    // are fine; a missing page resource is not.
    page.on('console', (m) => { const at = (m.location() && m.location().url) || ''; if (m.type() === 'error' && !(/40[134]/.test(m.text()) && at.includes('/api/'))) errors.push(`${m.text()} ${at}`); });
    page.on('request', (r) => requests.push({ url: r.url(), auth: r.headers().authorization || '' }));

    await page.goto(`${origin}/`); await wait(800);
    const before = await page.evaluate(() => ({ conn: document.querySelector('#conn span').textContent, account: !document.getElementById('account').hidden,
      tokenFields: !document.getElementById('token-fields').hidden, signin: !document.getElementById('signin').hidden }));
    expect('(a) signed out: sign-in offered, no token fields', before.conn.includes('GitHub 登入') && before.account && !before.tokenFields && before.signin, JSON.stringify(before));

    await page.click('#signin');
    await page.waitForURL(`${origin}/`); await wait(1200);
    const conn = await page.textContent('#conn span');
    expect('(b) GitHub sign-in round trip lands signed in', conn === 'local/collection', conn);
    expect('(b) no OAuth scope was requested', gh.scope === null, String(gh.scope));
    expect('(b) the sign-in token was revoked after the id check', gh.revoked.length === 1 && gh.revoked[0] === OAUTH_TOKEN, JSON.stringify(gh.revoked.length));
    const cookies = await ctx.cookies();
    const session = cookies.find((c) => c.name === 'ch_session');
    expect('(c) session cookie is HttpOnly and SameSite=Lax', session && session.httpOnly && session.sameSite === 'Lax', JSON.stringify(session && { h: session.httpOnly, s: session.sameSite }));
    const visible = await page.evaluate(() => ({ cookie: document.cookie, storage: JSON.stringify({ ...localStorage }) }));
    expect('(c) page script sees neither the session nor any token', !visible.cookie.includes('ch_session') && !/github_pat_|gho_|token/.test(visible.storage), JSON.stringify(visible));

    await page.click('#open-add');
    await page.fill('#add-url', 'https://github.com/abi/screenshot-to-code');
    await page.click('#add-submit'); await wait(1500);
    const inbox = fs.existsSync(path.join(LIB_DIR, 'inbox')) ? fs.readdirSync(path.join(LIB_DIR, 'inbox')).filter((n) => n.endsWith('.json')) : [];
    const cap = inbox.length ? JSON.parse(fs.readFileSync(path.join(LIB_DIR, 'inbox', inbox[0]), 'utf8')) : {};
    expect('(d) capture written to inbox/ through the server', inbox.length === 1 && cap.url === 'https://github.com/abi/screenshot-to-code', JSON.stringify(inbox));
    expect('(d) the server used the library token; the browser never sent one',
      gh.libraryAuth.size === 1 && gh.libraryAuth.has(`Bearer ${SECRETS.LIBRARY_TOKEN}`) && requests.every((r) => !r.auth), JSON.stringify([...gh.libraryAuth].map((a) => a.slice(0, 12))));
    expect('(d) every browser request stays on this origin (apart from the sign-in redirect)',
      requests.every((r) => r.url.startsWith(origin) || r.url.startsWith(`http://127.0.0.1:${ghPort}/login/oauth/authorize`)), requests.map((r) => r.url).filter((u) => !u.startsWith(origin)).join(' '));

    const csrf = await page.evaluate(async () => {
      const put = (headers) => fetch('/api/gh/repos/local/collection/contents/inbox/20261024-120000-abcdef01.json', { method: 'PUT', headers, body: JSON.stringify({ message: 'x', content: 'e30K' }) }).then((r) => r.status);
      const wf = await fetch('/api/session').then((r) => r.json()).then((s) => fetch('/api/gh/repos/local/collection/contents/.github/workflows/x.yml', { method: 'PUT', headers: { 'X-CSRF-Token': s.csrf }, body: JSON.stringify({ message: 'x', content: 'e30K' }) }).then((r) => r.status));
      return { noToken: await put({}), workflow: wf };
    });
    expect('(e) a write without the CSRF token is refused', csrf.noToken === 403, JSON.stringify(csrf));
    expect('(e) writing outside inbox/, user.json and entries is refused', csrf.workflow === 403, JSON.stringify(csrf));

    const py = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['scripts/fixture_analyze.py', '--library', LIB_DIR], { cwd: ROOT, env: { ...process.env, PYTHONUTF8: '1' }, encoding: 'utf8' });
    await page.reload(); await wait(1500);
    const card = await page.locator('a.card').first().getAttribute('href').catch(() => null);
    expect('(f) analyzed entry is listed', py.status === 0 && Boolean(card), `${py.status} ${py.stderr}`);
    if (card) {
      await page.goto(`${origin}/${card}`); await wait(1500);
      const h1 = await page.textContent('h1').catch(() => '');
      expect('(f) reading page loads the entry through the server', h1.includes('screenshot-to-code'), h1);
      await page.goto(`${origin}/`); await wait(1000);
    }

    await page.click('#conn'); await wait(200);
    await page.click('#signout'); await page.waitForLoadState('load'); await wait(1200);
    const after = await page.evaluate(async () => ({ conn: document.querySelector('#conn span').textContent,
      api: await fetch('/api/gh/repos/local/collection/contents/index.json').then((r) => r.status) }));
    expect('(g) signing out ends the session', after.conn.includes('GitHub 登入') && after.api === 401, JSON.stringify(after));
    expect('(h) no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  } finally {
    await browser.close();
    for (const p of procs) p.kill();
    mock.close();
    await wait(300);
    const text = logs.join('');
    const leaked = [...Object.values(SECRETS), OAUTH_TOKEN, 'e2e-code'].filter((s) => text.includes(s));
    expect('(i) no secret, token or OAuth code in the server log', leaked.length === 0, `${leaked.length} leaked`);
    fs.rmSync(LIB_DIR, { recursive: true, force: true });
    console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall server-mode checks passed');
    process.exit(failures.length ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(1); });
