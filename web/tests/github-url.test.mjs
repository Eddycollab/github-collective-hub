import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGitHubUrl, extractTargets, resolveRef, chooseSplit, keyOf, validPath, validRef, skillDirs, skillUrl, cleanSourceUrl } from '../lib/github-url.mjs';

test('repo URLs normalize: .git, trailing slash, tracking params and case all give one key', () => {
  const forms = ['https://github.com/Owner/Repo', 'https://github.com/Owner/Repo.git', 'https://github.com/owner/repo/',
    'https://github.com/Owner/Repo?utm_source=threads&fbclid=x', 'github.com/Owner/Repo#readme', 'https://www.github.com/Owner/Repo/issues/3',
    'https://l.threads.com/?u=https%3A%2F%2Fgithub.com%2FOwner%2FRepo%3Futm_source%3Dthreads'];
  const keys = new Set(forms.map((f) => keyOf(parseGitHubUrl(f))));
  assert.deepEqual([...keys], ['repository:owner/repo']);
  assert.equal(parseGitHubUrl('https://github.com/Owner/Repo.git').url, 'https://github.com/Owner/Repo');
  const r = extractTargets(forms.join('\n'));
  assert.equal(r.items.length, 1);
  assert.equal(r.duplicates, forms.length - 1);
});

test('non-GitHub hosts, reserved owners and credentials are rejected', () => {
  for (const bad of ['https://evil.example/?next=github.com/a/b', 'https://github.com/settings/profile', 'https://github.com/topics/ai',
    'https://user:pw@github.com/a/b', 'https://github.com.evil.example/a/b', 'https://gist.github.com/a/b', 'https://github.com/a']) {
    assert.equal(parseGitHubUrl(bad), null, bad);
  }
  assert.deepEqual(extractTargets('see evil.example/github.com/a/b').items, []);
});

test('SKILL.md blob links become skill targets with the folder as path', () => {
  const t = parseGitHubUrl('https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md?plain=1');
  assert.equal(t.item_type, 'skill');
  assert.equal(t.ref, 'main');
  assert.equal(t.path, 'skills/pdf');
  assert.equal(t.verified, true);
  assert.equal(keyOf(t), 'skill:anthropics/skills:skills/pdf');
  const root = parseGitHubUrl('https://github.com/o/r/blob/main/SKILL.md');
  assert.equal(root.path, '');
  assert.equal(keyOf(root), 'skill:o/r:');
  const raw = parseGitHubUrl('https://raw.githubusercontent.com/o/r/main/a/b/SKILL.md');
  assert.deepEqual([raw.item_type, raw.ref, raw.path], ['skill', 'main', 'a/b']);
});

test('slash-containing branches are never guessed from fixed URL segments', async () => {
  const t = parseGitHubUrl('https://github.com/o/r/tree/feature/new-ui/skills/demo');
  assert.equal(t.item_type, 'skill');
  assert.equal(t.verified, false);
  assert.ok(t.refOptions.length >= 3, 'every cut is offered');
  assert.deepEqual(t.refOptions.map((o) => o.ref), ['feature', 'feature/new-ui', 'feature/new-ui/skills', 'feature/new-ui/skills/demo']);
  const resolved = await resolveRef(t, async (prefix) => {
    assert.equal(prefix, 'feature');
    return ['feature', 'feature/new-ui', 'featurette'];
  });
  assert.deepEqual([resolved.ref, resolved.path, resolved.refOptions], ['feature/new-ui', 'skills/demo', null]);
  assert.equal(resolved.key, 'skill:o/r:skills/demo');
  await assert.rejects(resolveRef(t, async () => ['other']), (e) => e.code === 'ref-not-found');
  const picked = chooseSplit(t, 1);
  assert.deepEqual([picked.ref, picked.path], ['feature/new-ui', 'skills/demo']);
});

test('a 40-hex sha is taken as the ref without asking', () => {
  const sha = 'a'.repeat(40);
  const t = parseGitHubUrl(`https://github.com/o/r/blob/${sha}/skills/x/SKILL.md`);
  assert.deepEqual([t.ref, t.path, t.refOptions], [sha, 'skills/x', null]);
});

test('tree of a bare ref and non-skill blobs stay repositories', () => {
  assert.equal(parseGitHubUrl('https://github.com/o/r/tree/main').item_type, 'repository');
  assert.equal(parseGitHubUrl('https://github.com/o/r/blob/main/README.md').item_type, 'repository');
});

test('share text: three URLs with one duplicate gives two candidates, posts are noted', () => {
  const text = '推薦三個：https://github.com/a/one 、https://github.com/b/two.git，還有 github.com/a/one/ 很好用！原文 https://www.threads.com/@x/post/ABC';
  const r = extractTargets(text);
  assert.deepEqual(r.items.map((i) => i.repo), ['a/one', 'b/two']);
  assert.equal(r.duplicates, 1);
  assert.deepEqual(r.posts, [{ platform: 'threads', url: 'https://www.threads.com/@x/post/ABC' }]);
});

test('only a Threads link: no targets, one post', () => {
  const r = extractTargets('https://www.threads.com/@someone/post/DAbc123');
  assert.equal(r.items.length, 0);
  assert.equal(r.posts[0].platform, 'threads');
});

test('path and ref grammar', () => {
  assert.ok(validPath('skills/pdf') && validPath('') && validPath('a b/c'));
  for (const p of ['../x', 'a//b', 'a/./b', 'a\\b', '/a']) assert.ok(!validPath(p), p);
  assert.ok(validRef('feature/x') && validRef('v1.2.0'));
  for (const r of ['', '-x', 'a..b', 'a//b', 'x.lock']) assert.ok(!validRef(r), r);
});

test('skillDirs lists folders holding SKILL.md, optionally under a folder', () => {
  const tree = [{ type: 'blob', path: 'SKILL.md' }, { type: 'blob', path: 'skills/a/SKILL.md' }, { type: 'blob', path: 'skills/b/SKILL.md' },
    { type: 'blob', path: 'skills/b/notes.md' }, { type: 'tree', path: 'skills' }, { type: 'blob', path: 'docs/NOT-SKILL.md' }];
  assert.deepEqual(skillDirs(tree), ['', 'skills/a', 'skills/b']);
  assert.deepEqual(skillDirs(tree, 'skills'), ['skills/a', 'skills/b']);
});

test('skillUrl and cleanSourceUrl', () => {
  assert.equal(skillUrl({ repo: 'o/r', ref: 'feature/x', path: 'a b' }), 'https://github.com/o/r/blob/feature/x/a%20b/SKILL.md');
  assert.equal(cleanSourceUrl('https://github.com/o/r.git?utm_source=x#y'), 'https://github.com/o/r');
});
