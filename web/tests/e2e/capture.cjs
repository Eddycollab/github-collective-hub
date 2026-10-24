// Collection page end to end against an in-memory GitHub: capture entry points, duplicates, skills,
// user.json edits, failure recovery, index states, demo mode and the phone layout.
// Run: PW_CORE=/path/to/playwright-core node web/tests/e2e/capture.cjs   (exit 1 on any mismatch)
const { chromium } = require(process.env.PW_CORE || 'playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const serve = require('./serve.cjs');
const DEMO = path.resolve(__dirname, '../../demo');
const read = (p) => fs.readFileSync(path.join(DEMO, p), 'utf8');
const SHOTS = process.env.SHOTS || '';
const TOKEN = 'e2e-secret-token';

// A tiny GitHub: contents GET/PUT/DELETE with sha checks, directory listings, matching-refs and trees
// for public repos being collected. `faults` injects one-off responses by "METHOD path".
function github(seed = {}) {
  const files = new Map(Object.entries(seed));
  let n = 0;
  const sha = () => `sha${++n}`;
  const shas = new Map([...files.keys()].map((k) => [k, sha()]));
  const state = { files, shas, puts: [], deletes: [], faults: new Map(), calls: [], repos: {} };
  state.handle = (method, url, body) => {
    const u = new URL(url);
    state.calls.push(`${method} ${u.pathname}${u.search}`);
    const fault = state.faults.get(`${method} ${u.pathname}`);
    if (fault && fault.times > 0) { fault.times -= 1; return fault.res; }
    const lib = '/repos/me/lib';
    if (!u.pathname.startsWith(lib)) {
      const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(u.pathname);
      const repo = m && state.repos[m[1].toLowerCase()];
      if (!repo) return { status: 404, body: { message: 'Not Found' } };
      const rest = m[2] || '';
      if (rest === '') return { status: 200, body: { full_name: m[1], private: false, default_branch: repo.default_branch } };
      const mr = /^\/git\/matching-refs\/(heads|tags)\/(.+)$/.exec(rest);
      if (mr) return { status: 200, body: (repo[mr[1]] || []).filter((r) => r.startsWith(decodeURIComponent(mr[2]))).map((r) => ({ ref: `refs/${mr[1]}/${r}` })) };
      if (rest.startsWith('/git/trees/')) return { status: 200, body: { tree: repo.tree.map((p) => ({ path: p, type: 'blob' })), truncated: false } };
      return { status: 404, body: { message: 'Not Found' } };
    }
    const rest = u.pathname.slice(lib.length);
    if (rest === '') return { status: 200, body: { full_name: 'me/lib', private: true, default_branch: 'main' } };
    if (rest.startsWith('/actions/')) return { status: 403, body: { message: 'Resource not accessible' } };
    const m = /^\/contents\/(.+)$/.exec(rest);
    if (!m) return { status: 404, body: {} };
    const p = decodeURIComponent(m[1]);
    if (method === 'GET') {
      if (files.has(p)) return { status: 200, raw: files.get(p), body: { sha: shas.get(p), content: Buffer.from(files.get(p)).toString('base64') } };
      const kids = [...files.keys()].filter((k) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes('/'));
      const dirs = new Set([...files.keys()].filter((k) => k.startsWith(`${p}/`) && k.slice(p.length + 1).includes('/')).map((k) => k.slice(p.length + 1).split('/')[0]));
      if (kids.length || dirs.size) return { status: 200, body: [...kids.map((k) => ({ type: 'file', name: k.split('/').pop(), path: k, sha: shas.get(k) })), ...[...dirs].map((d) => ({ type: 'dir', name: d, path: `${p}/${d}` }))] };
      return { status: 404, body: { message: 'Not Found' } };
    }
    if (method === 'PUT') {
      const b = JSON.parse(body);
      if (files.has(p) && b.sha !== shas.get(p)) return { status: files.has(p) && !b.sha ? 422 : 409, body: { message: 'conflict' } };
      files.set(p, Buffer.from(b.content, 'base64').toString('utf8')); shas.set(p, sha());
      state.puts.push(p);
      return { status: 201, body: { content: { sha: shas.get(p) } } };
    }
    if (method === 'DELETE') {
      const b = JSON.parse(body);
      if (!files.has(p) || b.sha !== shas.get(p)) return { status: 409, body: {} };
      files.delete(p); state.deletes.push(p);
      return { status: 200, body: {} };
    }
    return { status: 405, body: {} };
  };
  return state;
}

const libSeed = () => ({
  'index.json': read('index.json').replaceAll('collective-demo', 'acme'),
  'user.json': read('user.json').replaceAll('collective-demo', 'acme'),
  'inbox/failed/20261024-070000-0000d002.json': read('inbox/failed/20261024-070000-0000d002.json').replaceAll('collective-demo', 'acme'),
});

(async () => {
  const { base: B, close } = await serve();
  const browser = await chromium.launch(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {});
  const failures = [];
  const expect = (label, cond, detail) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : ` — ${detail}`}`); if (!cond) failures.push(label); };

  const open = async ({ gh = github(libSeed()), vp = { width: 1280, height: 860 }, cfg = { repo: 'me/lib', token: TOKEN, nonce: 'n' }, history, init } = {}) => {
    const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 600, hasTouch: vp.width < 600, acceptDownloads: true });
    if (init) await ctx.addInitScript(init);
    const errors = [], logs = [];
    await ctx.route('https://api.github.com/**', (r) => {
      const req = r.request();
      const res = gh.handle(req.method(), req.url(), req.postData());
      if (res === 'net') return r.abort();
      // GitHub exposes its rate-limit headers to browsers through CORS; the mock does the same.
      return r.fulfill({ status: res.status, headers: { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-ratelimit-remaining, x-ratelimit-reset', ...(res.headers || {}) }, contentType: 'application/json',
        body: res.raw !== undefined && /raw/.test(req.headers().accept || '') ? res.raw : JSON.stringify(res.body) });
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { logs.push(m.text()); if (m.type() === 'error' && !/40[1349]|422|429|503|Failed to load/.test(m.text())) errors.push(m.text()); });
    page.on('dialog', (d) => d.accept());
    await page.goto(B);
    await page.evaluate(([c, h]) => { if (c) localStorage.setItem('collective.cfg', JSON.stringify(c)); if (h) localStorage.setItem('collective.history', JSON.stringify(h)); }, [cfg, history]);
    await page.reload(); await page.waitForTimeout(900);
    return { ctx, page, gh, errors, logs };
  };
  const done = async (label, o, shot) => {
    if (SHOTS && shot) await o.page.screenshot({ path: path.join(SHOTS, `${shot}.png`), fullPage: false });
    const leaked = o.logs.filter((l) => l.includes(TOKEN)).length;
    expect(`${label}: no page errors, token never logged`, o.errors.length === 0 && leaked === 0, `${o.errors.join(' | ')} leaked=${leaked}`);
    await o.ctx.close();
  };
  const cards = (page) => page.$$eval('#recent .card', (cs) => cs.map((c) => c.textContent.replace(/\s+/g, ' ').trim()));
  const capture = (gh, p) => JSON.parse(gh.files.get(p));
  const newCaptures = (gh) => gh.puts.filter((p) => /^inbox\/\d{8}-\d{6}-[0-9a-f]{8}\.json$/.test(p));

  // 1. The list: entries, a failed capture, views, tags, search, sort, layout.
  let o = await open();
  let rows = await cards(o.page);
  expect('(1) lists entries plus the failed capture, archived hidden', rows.length === 5 && rows.some((r) => r.includes('acme/missing-repo') && r.includes('分析失敗')) && !rows.some((r) => r.includes('classroom-kit')), rows.join(' / '));
  const nav = await o.page.$$eval('#views button', (bs) => bs.map((b) => b.textContent));
  expect('(1) sidebar views with counts', nav.join('|') === '所有收藏5|靈感收件匣1|我的最愛1|Skills 專區2|封存1', nav.join('|'));
  await o.page.click('#tag-filter button:has-text("簡報類")');
  await o.page.click('#tag-filter button:has-text("AI 工具")');
  rows = await cards(o.page);
  expect('(1) two selected tags narrow to items carrying both', rows.length === 1 && rows[0].includes('acme/slide-forge'), rows.join(' / '));
  await o.page.click('#active-tags button >> nth=0'); await o.page.click('#active-tags button >> nth=0');
  await o.page.fill('#q', 'meeting-notes');
  rows = await cards(o.page);
  expect('(1) search finds a skill by name', rows.length === 1 && rows[0].includes('Skill'), rows.join(' / '));
  await o.page.fill('#q', '研習簡報');
  expect('(1) search finds notes', (await cards(o.page)).length === 1, 'notes');
  await o.page.fill('#q', '');
  await o.page.click('#views button:has-text("Skills 專區")');
  expect('(1) Skills 專區 lists both skills of one repo', (await cards(o.page)).filter((r) => r.includes('acme/agent-skills')).length === 2, (await cards(o.page)).join(' / '));
  await o.page.click('#views button:has-text("所有收藏")');
  await o.page.click('#layout button:has-text("列表")');
  expect('(1) list layout', (await o.page.getAttribute('#recent', 'class')) === 'list', 'class');
  await o.page.selectOption('#sort', 'analyzed');
  rows = await cards(o.page);
  expect('(1) 最近分析 puts the newest analysis first', rows[0].includes('meeting-notes') || rows[0].includes('逐字稿'), rows[0]);
  await done('(1)', o, 'hub-list');

  // 2. Paste one repo URL: one capture v2; the .git / slash / tracking variants are flagged as duplicates.
  o = await open();
  await o.page.click('#open-add');
  await o.page.fill('#add-url', 'https://github.com/Fresh/Repo.git?utm_source=threads');
  await o.page.click('#add-submit'); await o.page.waitForTimeout(800);
  let caps = newCaptures(o.gh);
  const c0 = caps[0] && capture(o.gh, caps[0]);
  expect('(2) a plain repo URL is written as one normalized capture', caps.length === 1 && c0.v === 2 && c0.url === 'https://github.com/Fresh/Repo' && c0.item_type === 'repository', JSON.stringify(c0));
  await o.page.waitForTimeout(1600);
  rows = await cards(o.page);
  expect('(2) it shows as waiting for analysis', rows.some((r) => r.includes('Fresh/Repo') && r.includes('等待分析')), rows.join(' / '));
  await o.page.click('#open-add');
  await o.page.fill('#add-url', 'github.com/fresh/repo/?fbclid=1');
  await o.page.click('#add-submit'); await o.page.waitForTimeout(500);
  const dupRow = await o.page.textContent('#cands');
  expect('(2) the same repo again is a duplicate and is not written', newCaptures(o.gh).length === 1 && dupRow.includes('已在收藏中') && !(await o.page.isChecked('#cand-0')), dupRow);
  await o.page.click('#add-close');
  await done('(2)', o);

  // 3. Share text with three links, one repeated: two candidates, both collected; tags and text kept.
  o = await open();
  await o.page.click('#open-add');
  await o.page.click('#add-dialog [data-pane="share"]');
  await o.page.fill('#share-text', '推薦 https://github.com/a1/one 和 https://github.com/b2/two.git 還有 github.com/a1/one/ 都很棒');
  await o.page.fill('#post-url', 'https://www.threads.com/@x/post/ABC');
  await o.page.click('#find');
  await o.page.click('#add-tags button:has-text("程式類")');
  const btn = (await o.page.textContent('#add-submit')).trim();
  await o.page.click('#add-submit'); await o.page.waitForTimeout(900);
  caps = newCaptures(o.gh).map((p) => capture(o.gh, p));
  expect('(3) three links with one repeat: two captures', btn === '收藏 2 筆' && caps.length === 2 && caps.map((c) => c.target.repo).sort().join() === 'a1/one,b2/two', `${btn} ${JSON.stringify(caps.map((c) => c.url))}`);
  expect('(3) share text, post URL, source and tags travel with each capture', caps.every((c) => c.share_text.includes('推薦') && c.post_url === 'https://www.threads.com/@x/post/ABC' && c.source === 'threads' && c.tags[0] === '程式類'), JSON.stringify(caps[0]));
  await done('(3)', o, 'hub-share');

  // 4. Only a Threads link, and a transcript with no valid URL: ask for more, write nothing.
  o = await open();
  await o.page.click('#open-add');
  await o.page.click('#add-dialog [data-pane="share"]');
  await o.page.fill('#share-text', 'https://www.threads.com/@someone/post/DAbc123');
  await o.page.click('#find');
  const m1 = await o.page.textContent('#add-msg');
  await o.page.click('#add-dialog [data-pane="voice"]');
  await o.page.fill('#transcript', '朋友推薦一個叫 slide forge 的專案，說很好用');
  await o.page.click('#find');
  const m2 = await o.page.textContent('#add-msg');
  expect('(4) Threads-only asks for the post text', m1.includes('讀不到貼文內容') && newCaptures(o.gh).length === 0, m1);
  expect('(4) transcript without a URL asks for one and never guesses', m2.includes('不會依專案名稱猜測') && (await o.page.$$('#cands .cand')).length === 0, m2);
  await o.page.fill('#transcript', '他說 git hub 點 com 斜線 acme 斜線 voice-tool');
  await o.page.click('#voice-normalize'); await o.page.click('#find');
  expect('(4) spoken link words become a candidate only after the person converts and confirms', (await o.page.textContent('#cands')).includes('acme/voice-tool'), await o.page.textContent('#cands'));
  await done('(4)', o);

  // 5. Microphone: unsupported browser and a denied permission both explain themselves.
  o = await open({ init: () => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; } });
  await o.page.click('#open-add'); await o.page.click('#add-dialog [data-pane="voice"]');
  expect('(5) no SpeechRecognition: start disabled with a paste-instead message', (await o.page.isDisabled('#voice-start')) && (await o.page.textContent('#voice-state')).includes('不支援'), await o.page.textContent('#voice-state'));
  await done('(5) unsupported', o);
  o = await open({ init: () => { window.SpeechRecognition = class { start() { setTimeout(() => { this.onerror({ error: 'not-allowed' }); this.onend(); }, 50); } stop() {} abort() {} }; } });
  await o.page.click('#open-add'); await o.page.click('#add-dialog [data-pane="voice"]');
  await o.page.click('#voice-start'); await o.page.waitForTimeout(300);
  expect('(5) denied microphone says how to allow it', (await o.page.textContent('#voice-state')).includes('權限被拒絕') && !(await o.page.isDisabled('#voice-start')), await o.page.textContent('#voice-state'));
  await done('(5) denied', o);

  // 6. Skills: list SKILL.md in a repo and collect two; a slash branch resolves against real refs.
  const gh6 = github(libSeed());
  gh6.repos['tools/kit'] = { default_branch: 'main', heads: ['main', 'feature', 'feature/new-ui'], tags: [], tree: ['README.md', 'skills/pdf/SKILL.md', 'skills/pptx/SKILL.md', 'skills/new/SKILL.md'] };
  o = await open({ gh: gh6 });
  await o.page.click('#open-add');
  await o.page.fill('#add-url', 'https://github.com/tools/kit');
  await o.page.click('#find');
  await o.page.click('#cands button:has-text("列出 SKILL.md")'); await o.page.waitForTimeout(500);
  await o.page.check('#cand-0'); await o.page.check('#cand-1');
  await o.page.click('#add-submit'); await o.page.waitForTimeout(900);
  caps = newCaptures(o.gh).map((p) => capture(o.gh, p));
  expect('(6) two SKILL.md in one repo become two skill captures', caps.length === 2 && caps.every((c) => c.item_type === 'skill' && c.target.ref === 'main') && caps.map((c) => c.target.path).sort().join() === 'skills/new,skills/pdf', JSON.stringify(caps.map((c) => c.target)));
  await o.page.click('#open-add');
  await o.page.fill('#add-url', 'https://github.com/tools/kit/tree/feature/new-ui/skills/pptx');
  await o.page.click('#find'); await o.page.waitForTimeout(700);
  const cand = await o.page.textContent('#cands');
  expect('(6) a slash branch is resolved from the refs, not URL segments', cand.includes('路徑：skills/pptx') && cand.includes('來源 ref：feature/new-ui') && cand.includes('已確認有 SKILL.md'), cand);
  await o.page.click('#add-close');
  await done('(6)', o, 'hub-skills');

  // 7. Favorite writes user.json with its sha and survives a concurrent edit (409 -> re-read -> retry).
  o = await open();
  o.gh.faults.set('PUT /repos/me/lib/contents/user.json', { times: 1, res: { status: 409, body: { message: 'sha mismatch' } } });
  await o.page.click('.card:has-text("acme/hakka-tts") .fav'); await o.page.waitForTimeout(800);
  const user = JSON.parse(o.gh.files.get('user.json'));
  expect('(7) favorite saved after a conflict, other notes intact', user.items['repository:acme/hakka-tts'].favorite === true && user.items['repository:acme/hakka-tts'].status === 'in_use'
    && user.items['repository:acme/slide-forge'].note.includes('研習'), JSON.stringify(user.items['repository:acme/hakka-tts']));
  await done('(7)', o);

  // 8. A failed capture can be re-queued: new inbox file, failed record removed.
  o = await open();
  await o.page.click('.card:has-text("acme/missing-repo")');
  const capText = await o.page.textContent('#cap-body');
  await o.page.click('#cap-actions button:has-text("重新排入分析")'); await o.page.waitForTimeout(800);
  expect('(8) failed capture shows its error and re-queues', capText.includes('Not Found') && newCaptures(o.gh).length === 1 && o.gh.deletes.includes('inbox/failed/20261024-070000-0000d002.json'), `${capText} puts=${o.gh.puts} dels=${o.gh.deletes}`);
  await done('(8)', o);

  // 9. Write failures are reported and retryable; rate limiting is named as such.
  o = await open();
  o.gh.faults.set('PUT /repos/me/lib/contents/inbox', { times: 0 });
  await o.page.route(/contents\/inbox\/\d/, (r) => (r.request().method() === 'PUT' ? r.fulfill({ status: 403, headers: { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-ratelimit-remaining, x-ratelimit-reset', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1900000000' }, body: '{}' }) : r.fallback()));
  await o.page.click('#open-add'); await o.page.fill('#add-url', 'https://github.com/rate/limited'); await o.page.click('#add-submit'); await o.page.waitForTimeout(700);
  const rl = await o.page.textContent('#add-msg');
  await o.page.unroute(/contents\/inbox\/\d/);
  await o.page.click('#add-submit'); await o.page.waitForTimeout(700);
  expect('(9) rate limit is explained, and pressing 收藏 again succeeds', rl.includes('用量已達上限') && newCaptures(o.gh).length === 1, `${rl} puts=${o.gh.puts}`);
  await done('(9)', o);

  // 10. index.json outcomes keep local pending items visible (upstream history shape, migrated key).
  for (const [label, fault, want] of [['no index (empty)', null, ''], ['token revoked', { status: 401, body: {} }, 'token 失效'],
    ['rate limited', { status: 403, headers: { 'x-ratelimit-remaining': '0' }, body: {} }, '用量已達上限'], ['bad index', 'bad', '格式錯誤']]) {
    const gh = github({});
    if (fault === 'bad') gh.files.set('index.json', '{oops'); else if (fault) gh.faults.set('GET /repos/me/lib/contents/index.json', { times: 99, res: fault });
    o = await open({ gh, cfg: null, init: () => {
      if (!localStorage.getItem('collective.cfg')) {
        localStorage.setItem('repobox.cfg', JSON.stringify({ repo: 'me/lib', token: 'e2e-secret-token', nonce: 'n' }));
        localStorage.setItem('repobox.history', JSON.stringify([{ id: 'p1', repo: 'Fresh/Repo', lib: 'me/lib', at: new Date().toISOString(), state: 'pending' }]));
      }
    } });
    rows = await cards(o.page);
    const note = (await o.page.textContent('#lib-note')).trim();
    expect(`(10) ${label}: upstream pending item still listed, note "${want}"`, rows.some((r) => r.includes('Fresh/Repo')) && (want ? note.includes(want) : note === ''), `${rows.join(' / ')} | ${note}`);
    await done(`(10) ${label}`, o);
  }

  // 11. Demo mode: fictional data, a banner, and every write refused without a request.
  o = await open({ cfg: null });
  await o.page.click('#drawer-demo'); await o.page.waitForTimeout(900);
  rows = await cards(o.page);
  const banner = await o.page.textContent('#banner');
  await o.page.click('.card:has-text("collective-demo/hakka-tts") .fav'); await o.page.waitForTimeout(300);
  await o.page.click('#open-add'); await o.page.fill('#add-url', 'https://github.com/x/y'); await o.page.click('#add-submit'); await o.page.waitForTimeout(300);
  const demoMsg = await o.page.textContent('#add-msg');
  expect('(11) demo shows sample items with a banner and refuses writes', rows.length === 6 && banner.includes('示範資料') && demoMsg.includes('示範模式') && o.gh.puts.length === 0 && !o.gh.calls.some((c) => !c.startsWith('GET')), `${rows.length} ${banner} ${demoMsg} ${o.gh.calls.filter((c) => !c.startsWith('GET'))}`);
  await done('(11)', o, 'hub-demo');

  // 12. Phone: no sideways scroll, sidebar off-canvas, FAB opens the add sheet.
  o = await open({ vp: { width: 390, height: 844 } });
  const ph = await o.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth, side: document.querySelector('#side').getBoundingClientRect().right, fab: getComputedStyle(document.querySelector('#fab')).display !== 'none' }));
  await o.page.click('#fab');
  const sheet = await o.page.isVisible('#add-dialog');
  await o.page.click('#add-close');
  await o.page.click('#menu'); await o.page.waitForTimeout(400);
  const sideOpen = await o.page.evaluate(() => document.querySelector('#side').getBoundingClientRect().left >= 0);
  expect('(12) phone layout: no sideways scroll, hidden sidebar, FAB, menu', ph.sw === ph.w && ph.side <= 0 && ph.fab && sheet && sideOpen, JSON.stringify({ ...ph, sheet, sideOpen }));
  await done('(12)', o, 'hub-phone');

  // 13. Backup: export downloads JSON with no token; import previews before writing.
  o = await open();
  await o.page.click('#open-backup');
  const [dl] = await Promise.all([o.page.waitForEvent('download'), o.page.click('#bk-export')]);
  const file = await dl.path();
  const backup = fs.readFileSync(file, 'utf8');
  const bj = JSON.parse(backup);
  expect('(13) export holds user data and targets, never the token', bj.format === 'github-collective-hub-backup' && bj.items.length === 6 && !backup.includes(TOKEN), `${bj.items && bj.items.length}`);
  bj.user.items['repository:acme/slide-forge'] = { note: '匯入的新筆記', tags: ['設計資源'], favorite: true, updated_at: '2099-01-01T00:00:00Z' };
  bj.items.push({ key: 'repository:new/one', item_type: 'repository', repo: 'new1/one', ref: null, path: null });
  const tmp = path.join(path.dirname(file), 'edited.json'); fs.writeFileSync(tmp, JSON.stringify(bj));
  await o.page.setInputFiles('#bk-file', tmp); await o.page.waitForTimeout(300);
  const prev = await o.page.textContent('#bk-preview');
  const putsBefore = o.gh.puts.length;
  await o.page.click('#bk-apply'); await o.page.waitForTimeout(900);
  const u2 = JSON.parse(o.gh.files.get('user.json'));
  expect('(13) import previews, then merges notes and queues missing items', putsBefore === 0 && prev.includes('1 筆會更新') && u2.items['repository:acme/slide-forge'].note === '匯入的新筆記' && newCaptures(o.gh).length >= 1, `${prev} ${o.gh.puts}`);
  await done('(13)', o);

  await browser.close(); close();
  console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall collection-page checks passed');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
