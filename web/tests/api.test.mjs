import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiBase, loadUser, saveUser, writeCapture, loadIndex, loadInbox, requeueFailed, errorText, GitHubError, removeEntry, b64utf8 } from '../lib/library.mjs';
import { patchUser } from '../lib/collection.mjs';
import { createVoice, normalizeSpokenLinks } from '../lib/voice.mjs';
import { loadCfg, loadHistory } from '../lib/config.mjs';
import { extractTargets } from '../lib/github-url.mjs';

const CFG = { repo: 'me/lib', token: 'tok' };
const strip = (url) => url.replace('https://api.github.com/repos/me/lib', '');

test('apiBase only honours a loopback mock from a loopback page', () => {
  assert.equal(apiBase({ api: 'http://127.0.0.1:9' }, { hostname: '127.0.0.1' }), 'http://127.0.0.1:9');
  assert.equal(apiBase({ api: 'http://127.0.0.1:9' }, { hostname: 'me.github.io' }), 'https://api.github.com');
  assert.equal(apiBase({ api: 'https://evil.example' }, { hostname: 'localhost' }), 'https://api.github.com');
  assert.equal(apiBase({}, { hostname: 'localhost' }), 'https://api.github.com');
});

test('saveUser re-reads and re-applies the patch on a 409, keeping the other device\'s edit', async () => {
  let remote = { schema_version: 1, items: { a: { note: 'from phone', updated_at: '2026-01-01' } } }, sha = 's1', puts = 0;
  const fetchImpl = async (url, opts = {}) => {
    const path = strip(url);
    if (path === '/contents/user.json' && (!opts.method || opts.method === 'GET')) return new Response(JSON.stringify({ sha, content: b64utf8(JSON.stringify(remote)) }), { status: 200 });
    if (path === '/contents/user.json' && opts.method === 'PUT') {
      puts += 1;
      const body = JSON.parse(opts.body);
      if (puts === 1) { remote = { ...remote, items: { ...remote.items, c: { note: 'raced in' } } }; sha = 's2'; return new Response('{}', { status: 409 }); }
      assert.equal(body.sha, 's2');
      remote = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
      return new Response('{}', { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  await saveUser(CFG, (doc) => patchUser(doc, 'b', { favorite: true }), 'x', fetchImpl);
  assert.equal(puts, 2);
  assert.deepEqual(Object.keys(remote.items).sort(), ['a', 'b', 'c']);
  assert.equal(remote.items.a.note, 'from phone');
});

test('loadUser: missing file is an empty doc, bad JSON is bad-data', async () => {
  assert.deepEqual((await loadUser(CFG, async () => new Response('{}', { status: 404 }))).doc, { schema_version: 1, items: {} });
  const bad = await loadUser(CFG, async () => new Response(JSON.stringify({ sha: 'x', content: b64utf8('nope') }), { status: 200 }));
  assert.equal(bad.state, 'bad-data');
});

test('writeCapture retries with a fresh id when the file already exists', async () => {
  const seen = [];
  const fetchImpl = async (url) => { seen.push(strip(url)); return new Response('{}', { status: seen.length === 1 ? 422 : 201 }); };
  let n = 0;
  const id = await writeCapture(CFG, { v: 2 }, 'o/r', fetchImpl, () => new Date(2026, 9, 24, 10, 0, n++));
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
  assert.match(id, /^20261024-100001-[0-9a-f]{8}$/);
  await assert.rejects(writeCapture(CFG, {}, 'x', async () => new Response('{}', { status: 403 })), (e) => e.status === 403);
});

test('rate limiting is told apart from missing permission', async () => {
  const limited = await loadIndex(CFG, async () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' } }));
  assert.equal(limited.state, 'rate-limit');
  const denied = await loadIndex(CFG, async () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '4000' } }));
  assert.equal(denied.state, 'auth');
  assert.match(errorText(new GitHubError(403, true, 1800000000000), '收藏'), /用量已達上限/);
  assert.match(errorText(new GitHubError(403), '收藏'), /寫入權限/);
  assert.match(errorText(null, '收藏'), /連不到/);
});

test('loadInbox lists queued and failed captures; requeue writes a new capture then deletes the failed record', async () => {
  const cap = { v: 2, url: 'https://github.com/o/r', captured_at: '2026-10-24T00:00:00Z' };
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const p = strip(url); calls.push(`${opts.method || 'GET'} ${p}`);
    if (p === '/contents/inbox') return new Response(JSON.stringify([{ type: 'file', name: '20261024-000000-0001.json', path: 'inbox/20261024-000000-0001.json', sha: 'q' },
      { type: 'dir', name: 'failed', path: 'inbox/failed' }, { type: 'file', name: '.gitkeep', path: 'inbox/.gitkeep' }]), { status: 200 });
    if (p === '/contents/inbox/failed') return new Response(JSON.stringify([{ type: 'file', name: '20261023-000000-0002.json', path: 'inbox/failed/20261023-000000-0002.json', sha: 'f' }]), { status: 200 });
    if (p === '/contents/inbox/20261024-000000-0001.json') return new Response(JSON.stringify(cap), { status: 200 });
    if (p === '/contents/inbox/failed/20261023-000000-0002.json' && (opts.method || 'GET') === 'GET') return new Response(JSON.stringify({ error: 'boom', failed_at: 'x', capture: cap }), { status: 200 });
    return new Response('{}', { status: opts.method === 'PUT' ? 201 : 200 });
  };
  const inbox = await loadInbox(CFG, fetchImpl);
  assert.equal(inbox.queued.length, 1);
  assert.deepEqual([inbox.failed[0].error, inbox.failed[0].sha], ['boom', 'f']);
  calls.length = 0;
  await requeueFailed(CFG, inbox.failed[0], fetchImpl);
  assert.match(calls[0], /^PUT \/contents\/inbox\/\d{8}-\d{6}-[0-9a-f]{8}\.json$/);
  assert.equal(calls[1], 'DELETE /contents/inbox/failed/20261023-000000-0002.json');
});

test('removeEntry also drops the item from user.json in the same commit', async () => {
  const user = { schema_version: 1, items: { 'repository:old/one': { note: 'x' }, keep: { note: 'y' } } };
  const fetchImpl = async (url, opts = {}) => {
    const p = strip(url);
    const ok = (b) => new Response(JSON.stringify(b), { status: 200 });
    if (p === '') return ok({ default_branch: 'main' });
    if (p === '/git/ref/heads/main') return ok({ object: { sha: 'c1' } });
    if (p === '/git/commits/c1') return ok({ tree: { sha: 't1' } });
    if (p === '/git/trees/t1') return ok({ tree: [{ path: 'library', type: 'tree', sha: 'l1' }] });
    if (p === '/git/trees/l1') return ok({ tree: [{ path: 'old__one.md' }, { path: 'old__one.json' }] });
    if (p === '/contents/index.json?ref=c1' || p === '/contents/README.md?ref=c1') return new Response('{}', { status: 404 });
    if (p === '/contents/user.json?ref=c1') return new Response(JSON.stringify(user), { status: 200 });
    if (p === '/git/trees') { fetchImpl.tree = JSON.parse(opts.body).tree; return ok({ sha: 't2' }); }
    if (p === '/git/commits') return ok({ sha: 'c2' });
    if (opts.method === 'PATCH') return ok({});
    return new Response('{}', { status: 404 });
  };
  assert.equal(await removeEntry(CFG, 'old__one', 'Old/One', fetchImpl, { key: 'repository:old/one' }), 'ok');
  const u = JSON.parse(fetchImpl.tree.find((t) => t.path === 'user.json').content);
  assert.deepEqual(Object.keys(u.items), ['keep']);
});

test('settings and history move from repobox.* to collective.*', () => {
  const m = new Map([['repobox.cfg', JSON.stringify({ repo: 'me/lib', token: 't' })], ['repobox.history', JSON.stringify([{ id: '1', repo: 'a/b' }])]]);
  const store = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  assert.equal(loadCfg(store).repo, 'me/lib');
  assert.equal(loadHistory(store).length, 1);
  assert.ok(!m.has('repobox.cfg') && m.has('collective.cfg'));
});

class FakeRecognizer {
  static last = null;
  constructor() { FakeRecognizer.last = this; }
  start() {}
  stop() { this.onend(); }
  abort() { this.onerror({ error: 'aborted' }); this.onend(); }
  say(text, isFinal) { this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal })] }); }
}

test('voice: stop keeps the text, cancel drops it, denial and unsupported report clearly', () => {
  const texts = [], states = [];
  const v = createVoice({ Recognizer: FakeRecognizer, onText: (t, done) => texts.push([t, done]), onState: (s, why) => states.push([s, why]) });
  v.start('前文：');
  FakeRecognizer.last.say('github 點 com', true);
  v.stop();
  assert.deepEqual(texts.at(-1), ['前文：github 點 com', true]);
  assert.deepEqual(states.map((s) => s[0]), ['listening', 'idle']);
  texts.length = 0;
  v.start();
  FakeRecognizer.last.say('不要這段', false);
  v.cancel();
  assert.ok(!texts.some(([, done]) => done), 'a cancelled session never delivers final text');
  v.start();
  FakeRecognizer.last.onerror({ error: 'not-allowed' });
  assert.deepEqual(states.at(-1), ['error', 'denied']);
  const none = []; createVoice({ Recognizer: null, onState: (s, why) => none.push(why) }).start();
  assert.deepEqual(none, ['unsupported']);
});

test('spoken links are rewritten conservatively and never invent a repo', () => {
  const t = normalizeSpokenLinks('請看 git hub 點 com 斜線 anthropics 斜線 skills');
  assert.equal(t, '請看 github.com/anthropics/skills');
  assert.deepEqual(extractTargets(t).items.map((i) => i.repo), ['anthropics/skills']);
  assert.deepEqual(extractTargets(normalizeSpokenLinks('那個叫 slide forge 的專案很好用')).items, []);
});
