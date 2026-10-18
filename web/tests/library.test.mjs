import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStem, stemOf, mergeLibrary, specRows, ghRaw, loadIndex, STATE_TEXT } from '../lib/library.mjs';

const CFG = { repo: 'me/lib', token: 'tok' };
const fakeFetch = (routes) => async (url, opts) => {
  fakeFetch.calls.push({ url, opts });
  const r = routes[url.replace('https://api.github.com/repos/me/lib', '')];
  if (r === 'net') throw new TypeError('network');
  if (!r) return new Response('{"message":"Not Found"}', { status: 404 });
  return new Response(r.body ?? '', { status: r.status });
};
fakeFetch.calls = [];

test('parseStem accepts safe stems and rejects everything else', () => {
  assert.equal(parseStem('#owner__repo'), 'owner__repo');
  assert.equal(parseStem('#a-b__c.d'), 'a-b__c.d');
  for (const bad of ['#../x', '#a/b', '#A__B', '', '#', '#%E0%A4%A', '#' + 'a'.repeat(100) + '__' + 'b'.repeat(100), '#no-separator']) {
    assert.equal(parseStem(bad), null, bad);
  }
});

test('stemOf takes the stem from a library md path', () => {
  assert.equal(stemOf('library/owner__repo.md'), 'owner__repo');
  assert.equal(stemOf('library/../x.md'), null);
  assert.equal(stemOf('README.md'), null);
});

const INDEX = { entries: [
  { repo: 'Old/One', md: 'library/old__one.md', intro: 'i1', category: 'other', last_seen: '2026-10-01T00:00:00+00:00' },
  { repo: 'New/Two', md: 'library/new__two.md', intro: 'i2', category: 'dev-tool', last_seen: '2026-10-09T00:00:00+08:00' },
  { repo: 'Bad/Path', md: 'library/../evil.md', intro: 'x', category: 'other', last_seen: '2026-10-10T00:00:00+00:00' },
] };

test('mergeLibrary orders entries and puts unindexed pending/failed first', () => {
  const history = [
    { id: 'p1', repo: 'Fresh/Repo', lib: 'me/lib', at: '2026-10-19T01:00:00Z', state: 'pending' },
    { id: 'f1', repo: 'Broken/Repo', lib: 'me/lib', at: '2026-10-19T02:00:00Z', state: 'failed' },
    { id: 'p2', repo: 'new/two', lib: 'me/lib', at: '2026-10-19T03:00:00Z', state: 'pending' },
    { id: 'd1', repo: 'Done/Repo', lib: 'me/lib', at: '2026-10-19T04:00:00Z', state: 'done' },
    { id: 'o1', repo: 'Other/Lib', lib: 'someone/else', at: '2026-10-19T05:00:00Z', state: 'pending' },
  ];
  const items = mergeLibrary(INDEX, history, 'me/lib');
  assert.deepEqual(items.map((i) => i.kind + ':' + (i.stem || i.id)), ['failed:f1', 'pending:p1', 'entry:new__two', 'entry:old__one']);
});

test('mergeLibrary with no index still lists local pending items', () => {
  const items = mergeLibrary(null, [{ id: 'p1', repo: 'A/B', lib: 'me/lib', at: '2026-10-19T00:00:00Z', state: 'pending' }], 'me/lib');
  assert.deepEqual(items.map((i) => i.kind), ['pending']);
});

test('specRows splits labelled requirement lines', () => {
  assert.deepEqual(specRows(['平台：Windows', '費用: 免費', '不需安裝']), [['平台', 'Windows'], ['費用', '免費'], [null, '不需安裝']]);
});

test('ghRaw sends the raw accept header and reports status', async () => {
  fakeFetch.calls = [];
  const f = fakeFetch({ '/contents/library/a__b.json': { status: 401, body: '{}' } });
  const r = await ghRaw(CFG, 'library/a__b.json', f);
  assert.equal(r.status, 401);
  const { url, opts } = fakeFetch.calls[0];
  assert.equal(url, 'https://api.github.com/repos/me/lib/contents/library/a__b.json');
  assert.equal(opts.headers.Authorization, 'Bearer tok');
  assert.equal(opts.headers.Accept, 'application/vnd.github.raw+json');
  assert.equal(opts.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.deepEqual(await ghRaw(CFG, 'x', fakeFetch({ '/contents/x': 'net' })), { status: 0, text: null });
});

test('loadIndex maps every outcome to a state', async () => {
  const idx = (status, body) => ({ '/contents/index.json': { status, body } });
  const cases = [
    [idx(200, JSON.stringify(INDEX)), 'ok'],
    [idx(200, '{broken'), 'bad-data'],
    [idx(200, '{"entries": {}}'), 'bad-data'],
    [idx(401), 'auth'], [idx(403), 'auth'], [idx(503), 'unavailable'], [{ '/contents/index.json': 'net' }, 'unavailable'],
    [{ '': { status: 200, body: '{}' } }, 'empty'],
    [{}, 'no-repo'],
    [{ '': { status: 401 } }, 'auth'], [{ '': { status: 403 } }, 'auth'],
    [{ '': { status: 429 } }, 'unavailable'], [{ '': { status: 503 } }, 'unavailable'], [{ '': 'net' }, 'unavailable'],
  ];
  for (const [routes, want] of cases) {
    const got = await loadIndex(CFG, fakeFetch(routes));
    assert.equal(got.state, want, JSON.stringify(routes));
    assert.ok(STATE_TEXT[got.state] || got.state === 'ok');
  }
});

test('mergeLibrary drops malformed index entries instead of throwing', () => {
  const index = { entries: [null, 5, 'x', { repo: 3, md: 'library/a__b.md' }, { repo: 'A/B', md: 7 }, ...INDEX.entries] };
  const items = mergeLibrary(index, [], 'me/lib');
  assert.deepEqual(items.map((i) => i.stem), ['new__two', 'old__one']);
});
