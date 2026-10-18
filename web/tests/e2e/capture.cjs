// Capture page library list: every index.json outcome still shows local pending items.
// Run: PW_CORE=/path/to/playwright-core node web/tests/e2e/capture.cjs   (exit 1 on any mismatch)
const { chromium } = require(process.env.PW_CORE || 'playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const serve = require('./serve.cjs');
const INDEX = fs.readFileSync(path.join(__dirname, 'fixtures/index.json'), 'utf8');

(async () => {
  const { base: B, close } = await serve();
  const browser = await chromium.launch(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {});
  const failures = [];
  const expect = (label, cond, detail) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : ` — ${detail}`}`); if (!cond) failures.push(label); };
  const run = async (label, index, repo, check) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    await ctx.route('https://api.github.com/**', (r) => {
      const u = r.request().url().replace('https://api.github.com/repos/me/lib', '');
      if (u === '/contents/index.json') return index === 'net' ? r.abort() : r.fulfill({ status: index.status, contentType: 'application/json', body: index.body || '{}' });
      if (u === '') return r.fulfill({ status: repo, contentType: 'application/json', body: '{}' });
      return r.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"Not Found"}' });
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(B);
    await page.evaluate(() => {
      localStorage.setItem('repobox.cfg', JSON.stringify({ repo: 'me/lib', token: 't', nonce: 'n' }));
      localStorage.setItem('repobox.history', JSON.stringify([{ id: 'p1', repo: 'Fresh/Repo', lib: 'me/lib', at: new Date().toISOString(), state: 'pending' }]));
    });
    await page.reload(); await page.waitForTimeout(700);
    const rows = await page.$$eval('#recent li', (lis) => lis.map((li) => li.textContent.trim()));
    const note = (await page.textContent('#lib-note')).trim();
    await check({ page, rows, note, label });
    expect(`${label}: no page errors`, errors.length === 0, errors.join(' | '));
    await ctx.close();
  };
  await run('index 200 + pending', { status: 200, body: INDEX }, 200, async ({ page, rows, note, label }) => {
    expect(`${label}: 4 rows, pending first`, rows.length === 4 && rows[0].includes('Fresh/Repo') && rows[0].includes('分析中'), rows.join(' / '));
    expect(`${label}: no error note`, note === '', note);
    const href = await page.getAttribute('#recent li:nth-child(2) a', 'href');
    expect(`${label}: entry links to the reading page`, /^read\.html#[a-z0-9._-]+__[a-z0-9._-]+$/.test(href), href);
    await page.click('#recent li a[href="read.html#xiaopuouo__openchatx-mcp"]');
    await page.waitForTimeout(300);
    expect(`${label}: click opens read.html#stem`, page.url().endsWith('read.html#xiaopuouo__openchatx-mcp'), page.url());
  });
  await run('index 404 + repo 200', { status: 404 }, 200, async ({ rows, note, label }) => {
    expect(`${label}: pending only, no note`, rows.length === 1 && rows[0].includes('Fresh/Repo') && note === '', `${rows} | ${note}`);
  });
  await run('index 404 + repo 404', { status: 404 }, 404, async ({ rows, note, label }) => {
    expect(`${label}: no-repo note + pending`, note.includes('找不到收藏庫') && rows.length === 1, `${rows} | ${note}`);
  });
  await run('index 401', { status: 401 }, 200, async ({ rows, note, label }) => {
    expect(`${label}: auth note + pending`, note.includes('token 失效') && rows.length === 1, `${rows} | ${note}`);
  });
  await run('index 503', { status: 503 }, 200, async ({ rows, note, label }) => {
    expect(`${label}: unavailable note + pending`, note.includes('暫時連不到') && rows.length === 1, `${rows} | ${note}`);
  });
  await run('index bad JSON', { status: 200, body: '{broken' }, 200, async ({ rows, note, label }) => {
    expect(`${label}: bad-data note + pending`, note.includes('格式錯誤') && rows.length === 1, `${rows} | ${note}`);
  });
  await browser.close(); close();
  console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall capture checks passed');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
