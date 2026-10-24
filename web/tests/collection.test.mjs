import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildItems, filterItems, sortItems, viewCounts, tagCounts, markDuplicates, patchUser, exportBackup, planImport,
  makeCapture, normalizeEntry, tagVocabulary, cleanTags } from '../lib/collection.mjs';
import { extractTargets } from '../lib/github-url.mjs';

const demo = (p) => JSON.parse(readFileSync(new URL(`../demo/${p}`, import.meta.url), 'utf8'));
const INDEX = demo('index.json'), USER = demo('user.json');
const QUEUED = [{ id: '20261024-080000-0000d001', at: '2026-10-24T08:00:00+08:00', capture: demo('inbox/20261024-080000-0000d001.json') }];
const FAILED = (() => { const f = demo('inbox/failed/20261024-070000-0000d002.json'); return [{ id: '20261024-070000-0000d002', at: f.failed_at, capture: f.capture, error: f.error }]; })();

test('buildItems joins index, user.json and inbox without duplicating keys', () => {
  const items = buildItems({ index: INDEX, user: USER, queued: QUEUED, failed: FAILED });
  assert.equal(items.length, 7);
  const forge = items.find((i) => i.key === 'repository:collective-demo/slide-forge');
  assert.deepEqual(forge.tags, ['簡報類', 'AI 工具']);
  assert.equal(forge.favorite, true);
  assert.equal(forge.status, 'analyzed');
  assert.equal(forge.job, 'succeeded');
  const tts = items.find((i) => i.repo === 'collective-demo/hakka-tts');
  assert.equal(tts.status, 'in_use');
  assert.deepEqual(tts.tags, ['語音類'], 'capture tags show until the person edits tags');
  const failed = items.find((i) => i.repo === 'collective-demo/missing-repo');
  assert.deepEqual([failed.kind, failed.job, failed.status], ['capture', 'failed', 'to_analyze']);
  assert.match(failed.jobError, /Not Found/);
  const queued = items.find((i) => i.repo === 'collective-demo/voice-notes');
  assert.equal(queued.job, 'queued');
  assert.equal(buildItems({ index: INDEX, user: USER, queued: QUEUED, running: true }).find((i) => i.repo === 'collective-demo/voice-notes').job, 'running');
});

test('two skills in one repo are two items; a re-analysis capture attaches to its entry', () => {
  const re = { id: '20261024-090000-00000001', at: '2026-10-24T09:00:00+08:00', capture: makeCapture({ item_type: 'skill', repo: 'collective-demo/agent-skills', ref: 'main', path: 'skills/pptx-builder' }, { reanalyze: true }, '2026-10-24T09:00:00+08:00') };
  const items = buildItems({ index: INDEX, user: USER, queued: [re] });
  const skills = items.filter((i) => i.itemType === 'skill');
  assert.equal(skills.length, 2);
  const pptx = skills.find((s) => s.skillPath === 'skills/pptx-builder');
  assert.deepEqual([pptx.kind, pptx.job, pptx.jobReanalyze], ['entry', 'queued', true]);
  assert.equal(items.length, 5);
});

test('views, tag filter (all selected tags), search and sorting', () => {
  const items = buildItems({ index: INDEX, user: USER, queued: QUEUED, failed: FAILED });
  const counts = viewCounts(items);
  assert.deepEqual(counts, { all: 6, inbox: 2, favorites: 1, skills: 2, archived: 1 });
  assert.deepEqual(filterItems(items, { tags: ['簡報類', 'AI 工具'] }).map((i) => i.repo), ['collective-demo/slide-forge']);
  assert.deepEqual(filterItems(items, { tags: ['語音類'] }).map((i) => i.repo).sort(),
    ['collective-demo/agent-skills', 'collective-demo/hakka-tts', 'collective-demo/voice-notes']);
  assert.equal(filterItems(items, { query: 'meeting-notes' }).length, 1, 'skill name is searchable');
  assert.equal(filterItems(items, { query: '研習簡報' }).length, 1, 'notes are searchable');
  assert.equal(filterItems(items, { query: '語音類 客語' }).length, 1, 'terms combine with AND');
  assert.equal(filterItems(items, { view: 'archived' })[0].repo, 'collective-demo/classroom-kit');
  assert.equal(filterItems(items, { query: 'classroom' }).length, 0, 'archived items stay out of 所有收藏');
  assert.equal(sortItems(items)[0].repo, 'collective-demo/voice-notes');
  assert.equal(sortItems(items.filter((i) => i.analyzedAt), 'analyzed')[0].skillPath, 'skills/meeting-notes');
  assert.equal(tagCounts(items).get('語音類'), 3);
});

test('markDuplicates flags candidates already collected', () => {
  const items = buildItems({ index: INDEX, user: USER });
  const { items: cands } = extractTargets('https://github.com/collective-demo/slide-forge.git https://github.com/other/thing');
  const marked = markDuplicates(cands, items);
  assert.equal(marked[0].duplicate.repo, 'collective-demo/slide-forge');
  assert.equal(marked[1].duplicate, null);
});

test('patchUser only touches the given fields; tags are cleaned', () => {
  const doc = patchUser(USER, 'repository:collective-demo/slide-forge', { note: '新筆記' }, '2026-10-24T00:00:00Z');
  const it = doc.items['repository:collective-demo/slide-forge'];
  assert.deepEqual([it.note, it.favorite, it.tags], ['新筆記', true, ['簡報類', 'AI 工具']]);
  const t = patchUser(doc, 'k', { tags: [' 程式類 ', '程式類', '<b>', 'x'.repeat(21), '新標籤'] });
  assert.deepEqual(t.items.k.tags, ['程式類', 'b', '新標籤']);
  assert.ok(!('k' in patchUser(t, 'k', { remove: true }).items));
  assert.deepEqual(cleanTags(['a', 'a', '']), ['a']);
});

test('backup round trip: newer edits win, missing items are offered for queueing', () => {
  const items = buildItems({ index: INDEX, user: USER });
  const backup = JSON.parse(JSON.stringify(exportBackup({ library: 'me/lib', index: INDEX, user: USER, items, now: '2026-10-24T00:00:00Z' })));
  const plan = planImport(backup, { user: { schema_version: 1, items: {} }, items: items.slice(0, 2) });
  assert.equal(plan.updated, 3);
  assert.equal(plan.toQueue.length, items.length - 2);
  const newer = patchUser(USER, 'repository:collective-demo/slide-forge', { note: '比較新' }, '2030-01-01T00:00:00Z');
  const p2 = planImport(backup, { user: newer, items });
  assert.equal(p2.user.items['repository:collective-demo/slide-forge'].note, '比較新');
  assert.equal(p2.toQueue.length, 0);
  assert.throws(() => planImport({ format: 'other' }, { user: USER, items }));
});

test('makeCapture builds capture v2 with capped fields', () => {
  const c = makeCapture({ item_type: 'skill', repo: 'o/r', ref: null, path: 'skills/x', source_url: 'https://github.com/o/r/tree/main/skills/x' },
    { source: 'threads', share_text: 'x'.repeat(5000), tags: ['程式類'], note: 'n' }, '2026-10-24T10:00:00+08:00');
  assert.deepEqual(c.target, { repo: 'o/r', ref: null, path: 'skills/x' });
  assert.equal(c.v, 2);
  assert.equal(c.url, 'https://github.com/o/r');
  assert.equal(c.share_text.length, 4000);
  assert.equal(makeCapture({ item_type: 'repository', repo: 'o/r', path: 'ignored' }, {}, 'x').target.path, null);
  const leaky = makeCapture({ item_type: 'repository', repo: 'o/r' }, { share_text: `my token ghp_${'a'.repeat(36)} oops`,
    note: `github_pat_${'b'.repeat(30)}`, post_url: 'javascript:alert(1)' }, 'x');
  assert.ok(!JSON.stringify(leaky).includes('aaaaaaaaaaaa') && !JSON.stringify(leaky).includes('bbbbbbbbbbbb'), 'tokens are masked');
  assert.match(leaky.share_text, /已遮蔽的 token/);
  assert.equal(leaky.post_url, '', 'only http(s) post links are kept');
});

test('upstream v1 index rows still load as repositories', () => {
  const e = normalizeEntry({ repo: 'Old/One', md: 'library/old__one.md', intro: 'i', category: 'other', last_seen: '2026-10-01T00:00:00+00:00' });
  assert.deepEqual([e.itemType, e.key, e.stem], ['repository', 'repository:old/one', 'old__one']);
  assert.equal(normalizeEntry({ repo: 'x', md: 'library/../x.md' }), null);
  assert.deepEqual(tagVocabulary(null).map((t) => t.name).slice(0, 3), ['簡報類', '程式類', '語音類']);
});
