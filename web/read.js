'use strict';

import { prepareSvg, rejectedNotice, wire, draft, mountLightbox } from './lib/diagram.mjs';
import { parseStem, stemOf, ghRaw, loadIndex, loadUser, saveUser, loadInbox, writeCapture, requeueFailed, removeEntry, specRows,
  categoryLabel, useTransport, errorText, isoLocal, STATE_TEXT } from './lib/library.mjs';
import { patchUser, userItem, captureTarget, makeCapture, cleanTag, tagVocabulary, buildItems, ITEM_TYPE_LABEL, USER_STATUS, SOURCE_LABEL } from './lib/collection.mjs';
import { repoKey, skillKey, skillUrl } from './lib/github-url.mjs';
import { loadCfg, isDemo, addHistory, DEMO_REPO } from './lib/config.mjs';
import { demoTransport } from './lib/demo.mjs';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const lightbox = mountLightbox($('lightbox'));

// Coupled with app.js: demo mode flags the stored settings and swaps the transport.
function libCfg() {
  const cfg = loadCfg();
  useTransport(isDemo(cfg) ? demoTransport : null);
  return isDemo(cfg) ? { repo: DEMO_REPO, token: '', demo: true } : cfg;
}

function showMessage(text) {
  for (const id of ['tblock', 'read']) $(id).hidden = true;
  $('msg').replaceChildren(el('p', null, text));
  $('msg').hidden = false;
  document.title = 'GitHub Collective Hub';
}

const pad = (n) => String(n).padStart(2, '0');
function day(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function lastSeen(rec) {
  const times = (Array.isArray(rec.sightings) ? rec.sightings : []).map((s) => s && s.at).filter(Boolean);
  if (times.length) return times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
  return rec.last_seen || rec.analyzed_at || '';
}
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []);
const text = (v) => (typeof v === 'string' ? v : '');
const safeHttps = (u) => (/^https:\/\/[^\s]+$/.test(text(u)) ? u : '');

function cell(label, value) { const d = el('div', 'cell'); d.append(el('span', 'lbl', label), el('span', 'val', value)); return d; }
function section(title, ...kids) { const s = el('section', 'sec'); s.append(el('h2', null, title), ...kids); return s; }
function ul(items) { const u = el('ul'); items.forEach((x) => u.append(el('li', null, x))); return u; }

function specTable(lines, extra = []) {
  const t = el('table', 'spec'); const body = el('tbody'); t.append(body);
  for (const [label, value] of [...specRows(lines), ...extra]) {
    const tr = el('tr');
    if (label) tr.append(el('th', null, label), el('td', null, value));
    else { const td = el('td', null, value); td.colSpan = 2; tr.append(td); }
    body.append(tr);
  }
  return t;
}

function kv(rows) {
  const dl = el('dl', 'kv');
  for (const [k, v] of rows) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    const dd = el('dd');
    if (v instanceof Node) dd.append(v); else if (Array.isArray(v)) dd.append(ul(v)); else dd.textContent = v;
    dl.append(el('dt', null, k), dd);
  }
  return dl;
}

// --- page state

const page = { cfg: null, stem: null, rec: null, key: null, user: null, inbox: null, legacy: false };

const isSkill = (rec) => rec.item_type === 'skill';
function keyOfRecord(rec, stem) {
  if (text(rec.key)) return rec.key;
  if (isSkill(rec)) return skillKey(text(rec.repo), text((rec.skill && rec.skill.path) || (rec.target && rec.target.path)));
  return text(rec.repo) ? repoKey(rec.repo) : `repository:${stem}`;
}

// --- tabs

function tabs(rec, legacy) {
  const views = {};
  const highlights = list(rec.highlights), stack = list(rec.stack), summary = text(rec.summary), fit = list(rec.fit);
  if (!legacy && isSkill(rec)) views['Skill 資訊'] = () => skillInfo(rec);
  if (!legacy && fit.length) views['應用建議'] = () => { const d = el('div'); d.append(el('h3', null, 'AI 推論，不是來源事實'), ul(fit)); return d; };
  if (!legacy && highlights.length) views['值得借鏡'] = () => ul(highlights);
  if (!legacy && summary) views['技術摘要'] = () => el('p', null, summary);
  if (!legacy && stack.length) views['技術棧'] = () => { const d = el('div', 'stack'); stack.forEach((s) => d.append(el('span', null, s))); return d; };
  views['來源'] = () => sources(rec);
  views['我的筆記'] = () => notesPanel();
  const names = Object.keys(views);
  const box = el('div', 'more'); const seg = el('div', 'seg'); seg.setAttribute('role', 'tablist');
  const panel = el('div', 'panel'); panel.setAttribute('role', 'tabpanel');
  const fade = () => panel.classList.toggle('has-more', panel.scrollTop + panel.clientHeight < panel.scrollHeight - 4);
  panel.addEventListener('scroll', fade);
  const show = (name) => {
    panel.replaceChildren(views[name]());
    panel.scrollTop = 0;
    seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.textContent === name)));
    requestAnimationFrame(fade);
  };
  page.showTab = show;
  for (const name of names) {
    const b = el('button', null, name); b.type = 'button'; b.setAttribute('role', 'tab'); b.onclick = () => show(name);
    seg.append(b);
  }
  box.append(seg, panel);
  show(names[0]);
  return box;
}

function skillInfo(rec) {
  const s = rec.skill && typeof rec.skill === 'object' ? rec.skill : {};
  const res = rec.resolved && typeof rec.resolved === 'object' ? rec.resolved : {};
  const tools = list(rec.compatible_tools);
  const path = text(s.path) || text(rec.target && rec.target.path);
  const ref = text(rec.target && rec.target.ref) || text(res.ref);
  const d = el('div');
  d.append(kv([
    ['名稱', text(s.name)], ['說明', text(s.description)], ['路徑', path || '(根目錄)'], ['來源 ref', ref || '預設分支'],
    ['分析版本', text(res.commit_sha) ? text(res.commit_sha).slice(0, 12) : ''],
    ['觸發情境', list(rec.triggers)], ['輸入', list(rec.inputs)], ['輸出', list(rec.outputs)],
    ['適用工具', tools.length ? `${tools.join('、')}（來源有標示）` : '未確認（來源沒有明確寫，不代表通用）'],
    ['依賴', list(rec.dependencies)], ['權限需求', list(rec.permissions)], ['安裝說明', list(rec.install)],
    ['授權', text(s.license) || text(rec.license) || '來源未標示'],
  ]));
  d.append(el('p', 'warnbox', '收藏不會安裝或執行這個 skill；skill 內容只被當成資料分析。安裝前請自行檢查它的指令與腳本。'));
  const url = safeHttps(s.url) || (text(rec.repo) && !isDemo(loadCfg()) ? skillUrl({ repo: rec.repo, ref: text(res.commit_sha) || ref, path }) : '');
  if (url) { const a = el('a', null, '在 GitHub 看 SKILL.md ↗'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; d.append(a); }
  return d;
}

function sources(rec) {
  const d = el('div');
  const sightings = (Array.isArray(rec.sightings) ? rec.sightings : []).filter((s) => s && typeof s === 'object');
  if (!sightings.length) d.append(el('p', null, '沒有收藏紀錄。'));
  for (const s of [...sightings].reverse()) {
    const box = el('div', 'sighting');
    box.append(el('p', null, `${day(s.at)} · ${SOURCE_LABEL[s.source] || text(s.source) || '未標示來源'}`));
    const post = safeHttps(s.post_url);
    if (post) { const a = el('a', null, '原貼文 ↗'); a.href = post; a.target = '_blank'; a.rel = 'noopener noreferrer'; box.append(a); }
    if (text(s.share_text)) box.append(el('p', null, `分享文字：${s.share_text}`));
    if (text(s.transcript)) box.append(el('p', null, `逐字稿：${s.transcript}`));
    if (text(s.note)) box.append(el('p', null, `備註：${s.note}`));
    if (list(s.tags).length) box.append(el('p', null, `當時標籤：${list(s.tags).join('、')}`));
    d.append(box);
  }
  return d;
}

// --- notes, manual tags, AI suggestions (user.json only)

function currentUser() { return userItem(page.user, page.key) || {}; }
function effectiveTags() {
  const u = currentUser();
  return Array.isArray(u.tags) ? list(u.tags) : list(page.rec.capture_tags);
}

async function editUser(patch, message, say) {
  if (isDemo(loadCfg())) { say(STATE_TEXT.demo, true); return false; }
  try {
    page.user = await saveUser(page.cfg, (doc) => patchUser(doc, page.key, patch), message);
    say('已儲存。');
    return true;
  } catch (e) { say(errorText(e, '儲存'), true); return false; }
}

function notesPanel() {
  const d = el('div');
  const say = (t, err) => { msg.textContent = t; msg.style.color = err ? 'var(--err)' : ''; };
  const msg = el('p', 'cap');
  let tags = effectiveTags();
  d.append(el('h3', null, '我的筆記（重新分析不會覆寫）'));
  const note = el('textarea'); note.rows = 4; note.maxLength = 2000; note.value = text(currentUser().note);
  note.setAttribute('aria-label', '我的筆記');
  d.append(note);
  d.append(el('h3', null, '手動標籤'));
  const mine = el('div', 'tag-row');
  const vocabRow = el('div', 'tag-row');
  const paint = () => {
    mine.replaceChildren(...(tags.length ? tags.map((t) => { const b = el('button', 'mine', `${t} ×`); b.type = 'button'; b.onclick = () => { tags = tags.filter((x) => x !== t); paint(); }; return b; }) : [el('span', null, '還沒有標籤')]));
    vocabRow.replaceChildren(...page.vocab.filter((v) => !tags.includes(v.name)).map((v) => { const b = el('button', null, `＋ ${v.name}`); b.type = 'button'; b.title = v.definition || v.name; b.onclick = () => { tags = [...tags, v.name]; paint(); }; return b; }));
  };
  const add = el('div', 'row'); const inp = el('input'); inp.placeholder = '自訂新標籤'; inp.maxLength = 20; inp.setAttribute('aria-label', '自訂新標籤');
  const addBtn = el('button', 'btnish', '加入'); addBtn.type = 'button';
  const addTag = () => { const t = cleanTag(inp.value); if (t && !tags.includes(t)) tags = [...tags, t]; inp.value = ''; paint(); };
  addBtn.onclick = addTag; inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } };
  add.append(inp, addBtn);
  d.append(mine, vocabRow, add);
  const suggested = list(page.rec.suggested_tags);
  if (suggested.length) {
    d.append(el('h3', null, 'AI 建議標籤（推論，按一下採用）'));
    const row = el('div', 'tag-row');
    for (const t of suggested) {
      const b = el('button', null, tags.includes(t) ? `✓ ${t}` : `採用 ${t}`); b.type = 'button';
      b.onclick = () => { if (!tags.includes(t)) tags = [...tags, t]; paint(); b.textContent = `✓ ${t}`; };
      row.append(b);
    }
    d.append(row);
  }
  const save = el('div', 'row'); const sb = el('button', 'btnish primary', '儲存筆記與標籤'); sb.type = 'button';
  sb.onclick = async () => { sb.disabled = true; await editUser({ note: note.value, tags }, `collective: notes for ${page.rec.repo || page.stem}`, say); sb.disabled = false; };
  save.append(sb, msg);
  d.append(save);
  paint();
  return d;
}

// --- action bar: favorite, status, re-analysis, archive

function actionBar(rec) {
  const bar = el('div', 'acts');
  const say = el('p', 'say'); say.setAttribute('role', 'status');
  const tell = (t, err) => { say.textContent = t; say.className = `say${err ? ' err' : ''}`; };
  const u = currentUser();
  const fav = el('button', null, u.favorite ? '♥ 已加入最愛' : '♡ 加入最愛'); fav.type = 'button'; fav.setAttribute('aria-pressed', String(Boolean(u.favorite)));
  fav.onclick = async () => {
    const next = !currentUser().favorite; fav.disabled = true;
    if (await editUser({ favorite: next }, `collective: ${next ? 'favorite' : 'unfavorite'} ${rec.repo}`, tell)) {
      fav.textContent = next ? '♥ 已加入最愛' : '♡ 加入最愛'; fav.setAttribute('aria-pressed', String(next));
    }
    fav.disabled = false;
  };
  const sel = el('select'); sel.setAttribute('aria-label', '使用狀態');
  for (const [k, v] of Object.entries(USER_STATUS)) { const o = el('option', null, `狀態：${v}`); o.value = k; sel.append(o); }
  sel.value = Object.hasOwn(USER_STATUS, u.status) ? u.status : 'analyzed';
  sel.onchange = async () => { const prev = currentUser().status || 'analyzed'; if (!(await editUser({ status: sel.value }, `collective: status ${rec.repo}`, tell))) sel.value = prev; };
  const re = el('button', null, '重新分析'); re.type = 'button';
  re.onclick = () => reanalyze(rec, re, tell);
  bar.append(fav, sel, re, say);
  return bar;
}

async function reanalyze(rec, btn, tell) {
  const cfg = page.cfg;
  if (isDemo(loadCfg())) { tell(STATE_TEXT.demo, true); return; }
  const target = isSkill(rec)
    ? { item_type: 'skill', repo: text(rec.repo), ref: text(rec.target && rec.target.ref) || null, path: text((rec.target && rec.target.path) ?? (rec.skill && rec.skill.path)) }
    : { item_type: 'repository', repo: text(rec.repo) };
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(target.repo)) { tell('這筆缺少 repo 資訊，無法重新分析。', true); return; }
  if (!confirm('重新分析這筆收藏？會用你的 Claude 額度與 Actions 分鐘數；你的筆記、標籤、最愛與狀態不會被改動。')) return;
  btn.disabled = true;
  try {
    const now = new Date();
    const capture = makeCapture(target, { source: 'other', reanalyze: true }, isoLocal(now));
    const id = await writeCapture(cfg, capture, `reanalyze ${target.repo}`);
    addHistory({ id, repo: target.repo, key: page.key, lib: cfg.repo, at: now.toISOString(), state: 'pending', capture });
    tell('已排入重新分析，約 3–8 分鐘後完成；完成後重新整理這頁。');
  } catch (e) { tell(errorText(e, '排入重新分析'), true); btn.disabled = false; }
}

// Queued / failed captures for this key (a re-analysis or a repeat share in progress).
function jobNotice() {
  if (!page.inbox) return null;
  const mine = (c) => { const t = captureTarget(c.capture); return t && t.key === page.key; };
  const failed = page.inbox.failed.filter(mine).sort((a, b) => (a.id < b.id ? 1 : -1))[0];
  const queued = page.inbox.queued.filter(mine);
  if (queued.length) return el('p', 'job', queued.some((c) => c.capture.reanalyze) ? '重新分析排隊中，完成後內容會更新。' : '有一筆新的分享正在記錄中。');
  if (!failed) return null;
  const p = el('p', 'job failed', `最近一次處理失敗：${failed.error || '未知錯誤'}`);
  const retry = el('button', 'linkish', '重新排入'); retry.type = 'button';
  retry.onclick = async () => {
    if (isDemo(loadCfg())) { p.textContent = STATE_TEXT.demo; return; }
    retry.disabled = true;
    try { await requeueFailed(page.cfg, failed); p.className = 'job'; p.textContent = '已重新排入，完成後內容會更新。'; }
    catch (e) { retry.disabled = false; p.append(` ${errorText(e, '重新排入')}`); }
  };
  p.append(retry);
  return p;
}

// Only the notice changes when the inbox arrives, so an open tab and unsaved notes survive.
function updateJob() {
  const col = $('col');
  const old = col.querySelector('.job');
  const job = jobNotice();
  if (old) old.remove();
  if (job) col.querySelector('.acts').after(job);
}

function renderText(rec, legacy) {
  const parts = [actionBar(rec)];
  const job = jobNotice();
  if (job) parts.push(job);
  const intro = text(rec.intro), problem = text(rec.problem), examples = list(rec.examples), reqs = list(rec.requirements);
  if (intro) {
    // Long intros clamp to four lines and only the first example shows (user call 2026-10-19), so the tabs keep room.
    const lead = el('p', 'lead clamp', intro);
    const kids = [lead];
    const more = el('button', 'linkish', '展開'); more.type = 'button'; more.hidden = true;
    more.onclick = () => { lead.classList.remove('clamp'); more.hidden = true; };
    kids.push(more);
    const measure = () => { if (lead.classList.contains('clamp')) more.hidden = lead.scrollHeight <= lead.clientHeight + 1; };
    new ResizeObserver(measure).observe(lead);
    const first = isSkill(rec) ? list(rec.triggers)[0] : examples[0];
    const egs = el('div', 'egs');
    if (problem) { const p = el('p', 'eg'); p.append(el('b', null, '解決'), el('span', null, problem)); egs.append(p); }
    if (first) { const p = el('p', 'eg'); p.append(el('b', null, isSkill(rec) ? '觸發' : '例如'), el('span', null, first)); egs.append(p); }
    if (egs.childElementCount) kids.push(egs);
    parts.push(section('這是什麼', ...kids));
  }
  const license = isSkill(rec) && rec.skill && text(rec.skill.license) ? text(rec.skill.license) : text(rec.license);
  if (reqs.length) parts.push(section('使用門檻', specTable(reqs, license ? [['授權', license]] : [])));
  parts.push(tabs(rec, legacy));
  if (legacy || !intro) parts.push(el('p', 'note', '這筆是舊格式，重新分析後會有完整內容。'));
  $('col').replaceChildren(...parts);
}

function renderDiagram(cfg, stem, svgRes, rec) {
  const fig = $('fig');
  fig.setAttribute('aria-label', isSkill(rec) ? '使用流程圖' : '架構圖');
  // No diagram: the reading column takes the page instead of sitting beside an empty sheet.
  $('read').classList.toggle('nodia', svgRes.status === 404);
  fig.classList.remove('zoomable'); fig.onclick = null; fig.onkeydown = null; fig.removeAttribute('tabindex'); fig.removeAttribute('role');
  if (svgRes.status === 404) { fig.replaceChildren(el('p', 'nodia', isSkill(rec) ? '這個 skill 沒有流程圖（分析時判斷不需要，或圖沒通過檢查）。' : '這筆沒有架構圖。')); return; }
  if (svgRes.status !== 200) { fig.replaceChildren(el('p', 'nodia', '圖載入失敗，稍後再試。')); return; }
  const svg = prepareSvg(svgRes.text, 'h');
  if (!svg) { fig.replaceChildren(rejectedNotice(document, `https://github.com/${cfg.repo}/blob/main/library/${stem}.svg`)); return; }
  fig.replaceChildren(svg, el('span', 'hint', '點圖放大'));
  fig.classList.add('zoomable');
  fig.setAttribute('role', 'button');
  fig.tabIndex = 0;
  const zoom = () => {
    const big = prepareSvg(svgRes.text, 'v');
    if (!big) return;
    wire(big, lightbox.isDrag);
    lightbox.open(big);
  };
  fig.onclick = zoom;
  fig.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); zoom(); } };
  draft(svg);
}

function removeButton(cfg, stem, repo) {
  const b = el('button', 'rm', '移除'); b.type = 'button';
  b.onclick = async () => {
    if (isDemo(loadCfg())) { alert(STATE_TEXT.demo); return; }
    if (!confirm(`從收藏移除 ${repo}？\n介紹、圖和你的筆記會一起刪掉；之後再收會重新分析。`)) return;
    b.disabled = true; b.textContent = '移除中…';
    try {
      await removeEntry(cfg, stem, repo, undefined, { key: page.key });
      location.replace('./');
    } catch (e) {
      b.disabled = false; b.textContent = '移除';
      alert(errorText(e, '移除'));
    }
  };
  return b;
}

function archiveButton(rec) {
  const archived = currentUser().status === 'archived';
  const b = el('button', 'rm', archived ? '取消封存' : '封存'); b.type = 'button';
  b.style.color = 'var(--mute)';
  b.onclick = async () => {
    b.disabled = true;
    const ok = await editUser({ status: archived ? 'analyzed' : 'archived' }, `collective: ${archived ? 'unarchive' : 'archive'} ${rec.repo}`, (t, err) => { if (err) alert(t); });
    if (ok) render(); else b.disabled = false;
  };
  return b;
}

function renderRecord(cfg, stem, rec, svgRes, legacy) {
  Object.assign(page, { cfg, stem, rec, legacy, key: keyOfRecord(rec, stem) });
  render();
  renderDiagram(cfg, stem, svgRes, rec);
}

function render() {
  const { cfg, stem, rec, legacy } = page;
  const repo = text(rec.repo) || stem;
  const skill = isSkill(rec) ? rec.skill || {} : null;
  const title = skill ? text(skill.name) || text((rec.target || {}).path) || repo : repo;
  const h1 = el('h1', null, title); h1.title = skill ? `${repo} · ${text(skill.path) || ''}` : repo;
  const head = el('div', 'head'); head.append(h1);
  if (text(rec.tagline)) head.append(el('p', 'sub', rec.tagline));
  if (isDemo(loadCfg())) head.append(el('span', 'demo-flag', '示範資料'));
  const parts = [head, cell('類型', ITEM_TYPE_LABEL[isSkill(rec) ? 'skill' : 'repository']), cell('分類', categoryLabel(text(rec.category)) || '—'),
    cell('收藏日', day(lastSeen(rec)))];
  if (/^https:\/\/github\.com\//.test(text(rec.url))) {
    const gh = el('a', 'gh', skill ? `${repo} ↗` : 'GitHub ↗'); gh.href = rec.url; gh.target = '_blank'; gh.rel = 'noopener';
    parts.push(gh);
  }
  parts.push(removeButton(cfg, stem, repo));
  $('tblock').replaceChildren(...parts);
  $('msg').hidden = true;
  $('tblock').hidden = false;
  $('read').hidden = false;
  document.title = `${title} · GitHub Collective Hub`;
  renderText(rec, legacy);
  $('col').querySelector('.acts').append(archiveButton(rec));
}

let generation = 0;

async function load() {
  const gen = ++generation;
  const stem = parseStem(location.hash);
  if (!stem) { showMessage('找不到這筆收藏。'); return; }
  const cfg = libCfg();
  if (!cfg || (!isDemo(cfg) && (!cfg.repo || !cfg.token))) { showMessage('先到收藏頁連結收藏庫。'); return; }
  const [side, svgRes, idx, user] = await Promise.all([
    ghRaw(cfg, `library/${stem}.json`), ghRaw(cfg, `library/${stem}.svg`), loadIndex(cfg), loadUser(cfg),
  ]);
  // A newer navigation (hashchange) or a settings change makes this result stale.
  const now = libCfg();
  if (gen !== generation || parseStem(location.hash) !== stem || !now || now.repo !== cfg.repo) return;
  page.user = user.doc;
  page.vocab = tagVocabulary(idx.index, buildItems({ index: idx.index, user: user.doc }));
  if (side.status === 200) {
    let rec = null;
    try { rec = JSON.parse(side.text); } catch { /* handled below */ }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) { showMessage(STATE_TEXT['bad-data']); return; }
    renderRecord(cfg, stem, rec, svgRes, false);
    loadInbox(cfg).then((inbox) => { if (gen === generation) { page.inbox = inbox; updateJob(); } }).catch(() => {});
    return;
  }
  if (side.status === 401 || side.status === 403) { showMessage(side.limited ? STATE_TEXT['rate-limit'] : STATE_TEXT.auth); return; }
  if (side.status === 404) {
    // Entries written before sidecars existed are still listed in index.json.
    const entry = idx.state === 'ok' ? idx.index.entries.find((e) => e && stemOf(e.md) === stem) : null;
    if (entry) { renderRecord(cfg, stem, entry, svgRes, true); return; }
    showMessage(idx.state === 'auth' || idx.state === 'no-repo' ? STATE_TEXT[idx.state] : '找不到這筆收藏。');
    return;
  }
  showMessage(STATE_TEXT.unavailable);
}

addEventListener('hashchange', load);
load();
