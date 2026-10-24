'use strict';

import { loadIndex, loadUser, saveUser, loadInbox, writeCapture, requeueFailed, deleteFile, listMatchingRefs, findSkills, actionsRunning,
  useTransport, apiBase, errorText, categoryLabel, isoLocal, STATE_TEXT } from './lib/library.mjs';
import { buildItems, filterItems, sortItems, viewCounts, tagCounts, tagVocabulary, markDuplicates, patchUser, makeCapture, exportBackup,
  planImport, cleanTag, ITEM_TYPE_LABEL, USER_STATUS, VIEWS, SOURCE_LABEL } from './lib/collection.mjs';
import { extractTargets, resolveRef, chooseSplit, skillDirs, keyOf } from './lib/github-url.mjs';
import { loadCfg, saveCfg, isDemo, connected, addHistory, historyFor, loadHistory, saveHistory, DEMO_REPO } from './lib/config.mjs';
import { createVoice, recognizerClass, normalizeSpokenLinks, VOICE_TEXT } from './lib/voice.mjs';
import { demoTransport } from './lib/demo.mjs';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const PREFS_KEY = 'collective.prefs';
const POLL_MS = 60000;

// --- settings

// Demo mode keeps the real settings and only flags them, so leaving it restores the connection.
function libCfg() {
  const cfg = loadCfg();
  return isDemo(cfg) ? { repo: DEMO_REPO, token: '', demo: true } : cfg;
}

function applyTransport() { useTransport(isDemo(loadCfg()) ? demoTransport : null); }

function loadPrefs() {
  try { const p = JSON.parse(localStorage.getItem(PREFS_KEY)); return p && typeof p === 'object' ? p : {}; } catch { return {}; }
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ sort: ui.sort, layout: ui.layout })); } catch { /* storage blocked */ }
}

function detectSource(host) {
  if (!host) return '';
  if (/(^|\.)threads\.(com|net)$/.test(host)) return 'threads';
  if (/(^|\.)github\.com$/.test(host)) return 'github';
  if (/(^|\.)(x|twitter)\.com$|^t\.co$/.test(host)) return 'x';
  if (/(^|\.)youtube\.com$|^youtu\.be$/.test(host)) return 'youtube';
  return 'other';
}

const labelOf = (t) => (t.item_type === 'skill' || t.itemType === 'skill' ? `${t.repo} · ${(t.path ?? t.skillPath) || '(根目錄)'}` : t.repo);

// --- status line (one line under the search box; carries confirm / retry buttons)

function setStatus(text, cls = '') { $('status').textContent = text; $('block').dataset.state = cls || 'idle'; }
function setRepo(name) { $('block-repo').textContent = name || ''; }
function setHint(text) { $('hint').textContent = text || ''; }
function clearActions() { $('block-actions').replaceChildren(); }
function addAction(label, onClick, primary = false) {
  const btn = el('button', primary ? 'btn small primary' : 'btn small', label);
  btn.type = 'button';
  btn.onclick = () => { clearActions(); onClick(); };
  $('block-actions').append(btn);
}

// --- library state

const lib = { state: 'ok', index: null, user: null, userState: 'ok', inbox: { queued: [], failed: [] }, running: false, repo: null };
const ui = { view: 'all', tags: [], query: '', sort: 'captured', layout: 'cards' };
let items = [];
let libSeq = 0;
let libReady = null;

// Only the latest request for the currently configured repo may update the list.
function loadLib() {
  libReady = (async () => {
    const cfg = libCfg();
    const seq = ++libSeq;
    if (!connected(cfg)) { Object.assign(lib, { state: 'ok', index: null, user: null, inbox: { queued: [], failed: [] }, repo: null }); render(); return; }
    if (lib.repo !== cfg.repo) { Object.assign(lib, { state: 'ok', index: null, user: null, inbox: { queued: [], failed: [] }, repo: cfg.repo }); render(); }
    const [idx, user, inbox] = await Promise.all([loadIndex(cfg), loadUser(cfg), loadInbox(cfg).catch(() => null)]);
    const running = inbox && inbox.queued.length && !isDemo(cfg) ? await actionsRunning(cfg) : false;
    const now = libCfg();
    if (seq !== libSeq || !now || now.repo !== cfg.repo) return;
    Object.assign(lib, { state: idx.state, index: idx.index, reset: idx.reset, user: user.doc, userState: user.state, running: Boolean(running), repo: cfg.repo });
    if (inbox) { lib.inbox = inbox; syncHistory(cfg, inbox, idx.index); }
    render();
    schedulePoll();
  })();
  return libReady;
}

// A capture this device sent is done once it has left inbox/ (publish moves it to done/ or failed/).
// A capture younger than 30 s that is not listed yet stays pending, unless the index already shows its
// entry updated since (then publish has handled it).
function syncHistory(cfg, inbox, index) {
  const queued = new Set(inbox.queued.map((c) => c.id)), failed = new Set(inbox.failed.map((c) => c.id));
  const seen = new Map();
  for (const e of index && Array.isArray(index.entries) ? index.entries : []) {
    if (e && typeof e.key === 'string') seen.set(e.key, Math.max(Date.parse(e.last_seen) || 0, Date.parse(e.analyzed_at) || 0));
  }
  const all = loadHistory();
  let changed = false;
  for (const h of all) {
    if (h.lib !== cfg.repo || h.state !== 'pending' || queued.has(h.id)) continue;
    const handled = failed.has(h.id) || (h.key && (seen.get(h.key) || 0) >= Date.parse(h.at) - 1000);
    if (!handled && Date.now() - Date.parse(h.at) < 30000) continue;
    h.state = failed.has(h.id) ? 'failed' : 'done';
    changed = true;
  }
  if (changed) saveHistory(all);
}

// --- rendering

function render() {
  const cfg = libCfg();
  items = connected(cfg) ? buildItems({ index: lib.index, user: lib.user, queued: lib.inbox.queued, failed: lib.inbox.failed, running: lib.running, history: historyFor(cfg) }) : [];
  renderConn();
  renderBanner(cfg);
  renderNav();
  renderTagFilter();
  renderList(cfg);
}

function renderConn() {
  const cfg = loadCfg();
  const demo = isDemo(cfg), ok = Boolean(cfg && cfg.repo && cfg.token);
  $('conn').dataset.ok = demo ? 'demo' : ok ? '1' : '0';
  $('conn').querySelector('span').textContent = demo ? '示範模式' : ok ? cfg.repo : '尚未連結收藏庫';
  $('library').href = !demo && ok ? `https://github.com/${cfg.repo}` : '#';
  $('library').hidden = demo || !ok;
}

function renderBanner(cfg) {
  const b = $('banner');
  if (isDemo(cfg)) {
    const exit = el('button', 'linkish', '離開示範模式'); exit.type = 'button'; exit.onclick = () => setDemo(false);
    b.replaceChildren('示範資料：以下是虛構的範例收藏（collective-demo），沒有連到 GitHub，不會寫入、同步或分析。', ' ', exit);
    b.hidden = false;
  } else if (cfg && apiBase(cfg) !== 'https://api.github.com') {
    b.textContent = `本機模擬 API（${apiBase(cfg)}）：資料寫在暫存資料夾，不會同步到 GitHub，也沒有 Actions 分析，收藏會停在「等待分析」。`;
    b.hidden = false;
  } else b.hidden = true;
  const notes = [];
  if (connected(cfg) && lib.state !== 'ok' && lib.state !== 'empty') {
    notes.push(STATE_TEXT[lib.state] + (lib.state === 'rate-limit' && lib.reset ? `（約 ${new Date(lib.reset).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })} 重設）` : ''));
  }
  if (connected(cfg) && lib.userState === 'bad-data') notes.push('user.json 格式錯誤：筆記、標籤與最愛暫時無法顯示或儲存。請到收藏庫修正或從備份匯入。');
  $('lib-note').textContent = notes.join(' ');
}

function renderNav() {
  const counts = viewCounts(items);
  const nav = $('views');
  nav.replaceChildren(...Object.entries(VIEWS).map(([key, label]) => {
    const b = el('button'); b.type = 'button';
    b.setAttribute('aria-pressed', String(ui.view === key));
    b.append(el('span', null, label), el('span', null, String(counts[key] ?? 0)));
    b.onclick = () => { ui.view = key; closeSide(); render(); };
    return b;
  }));
}

function renderTagFilter() {
  const counts = tagCounts(items);
  const vocab = tagVocabulary(lib.index, items);
  $('tag-filter').replaceChildren(...vocab.map((t) => {
    const b = el('button'); b.type = 'button'; b.title = t.definition || t.name;
    b.setAttribute('aria-pressed', String(ui.tags.includes(t.name)));
    b.append(el('span', null, t.name), el('span', null, String(counts.get(t.name) || 0)));
    b.onclick = () => { ui.tags = ui.tags.includes(t.name) ? ui.tags.filter((x) => x !== t.name) : [...ui.tags, t.name]; render(); };
    return b;
  }));
}

function jobLabel(it) {
  if (it.job === 'succeeded') return null;
  if (it.kind === 'entry') {
    if (it.job === 'failed') return it.jobReanalyze ? '重新分析失敗' : '最近一次更新失敗';
    return it.jobReanalyze ? '等待重新分析' : '記錄分享中';
  }
  return { queued: '等待分析', running: '分析中', failed: '分析失敗' }[it.job];
}

function card(it, demo) {
  const isEntry = it.kind === 'entry';
  const node = el(isEntry ? 'a' : 'div', `card${it.kind === 'capture' ? ' capture' : ''}${it.job === 'failed' ? ' failed' : ''}`);
  if (isEntry) node.href = `read.html#${it.stem}`;
  else { node.tabIndex = 0; node.setAttribute('role', 'button'); node.onclick = () => openCapture(it); node.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCapture(it); } }; }
  const meta = el('div', 'meta');
  meta.append(el('span', `pill type${it.itemType === 'skill' ? ' skill' : ''}`, ITEM_TYPE_LABEL[it.itemType]));
  const job = jobLabel(it);
  if (job) meta.append(el('span', `pill job-${it.job}`, job));
  if (it.status === 'in_use' || it.status === 'archived') meta.append(el('span', 'pill', USER_STATUS[it.status]));
  if (demo) meta.append(el('span', 'pill demo', '示範'));
  const title = it.itemType === 'skill' ? (it.skillName || it.tagline || it.skillPath || it.repo) : (it.tagline || it.repo);
  node.append(meta, el('h3', 'tl', title), el('p', 'rp', labelOf(it)));
  const sub = it.itemType === 'skill' && it.tagline && it.tagline !== title ? it.tagline : it.intro;
  if (sub) node.append(el('p', 'intro', sub));
  if (it.job === 'failed' && it.jobError) node.append(el('p', 'err', it.jobError));
  if (it.tags.length) { const t = el('div', 'tags'); for (const tag of it.tags) t.append(el('span', null, tag)); node.append(t); }
  const fav = el('button', 'fav', it.favorite ? '♥' : '♡'); fav.type = 'button';
  fav.setAttribute('aria-pressed', String(it.favorite)); fav.setAttribute('aria-label', it.favorite ? '移出我的最愛' : '加入我的最愛');
  fav.onclick = (e) => { e.preventDefault(); e.stopPropagation(); toggleFavorite(it); };
  node.append(fav);
  return node;
}

function renderList(cfg) {
  $('view-title').textContent = VIEWS[ui.view];
  const shown = sortItems(filterItems(items, { view: ui.view, tags: ui.tags, query: ui.query, categoryLabel }), ui.sort);
  $('view-count').textContent = connected(cfg) ? `${shown.length} 筆` : '';
  $('active-tags').replaceChildren(...ui.tags.map((t) => {
    const b = el('button', null, `${t} ×`); b.type = 'button'; b.setAttribute('aria-label', `取消篩選 ${t}`);
    b.onclick = () => { ui.tags = ui.tags.filter((x) => x !== t); render(); };
    return b;
  }));
  $('recent').className = ui.layout === 'list' ? 'list' : '';
  if (!connected(cfg)) {
    const p = el('p', 'empty', '連結你的私人收藏庫之後，收藏會列在這裡。也可以先用示範資料看看介面。');
    const go = el('button', 'btn small primary', '連結收藏庫'); go.type = 'button'; go.onclick = openDrawer;
    const demo = el('button', 'btn small', '以示範資料瀏覽'); demo.type = 'button'; demo.onclick = () => setDemo(true);
    const box = el('div'); box.append(p, go, ' ', demo);
    $('recent').replaceChildren(box);
    return;
  }
  if (!shown.length) {
    const text = items.length ? '沒有符合條件的收藏。' : lib.state === 'empty' || lib.state === 'ok' ? STATE_TEXT.empty : '目前讀不到收藏。';
    $('recent').replaceChildren(el('p', 'empty', text));
    return;
  }
  const demo = isDemo(cfg);
  $('recent').replaceChildren(...shown.map((it) => card(it, demo)));
}

// --- user edits (user.json only; the pipeline never writes it)

async function editUser(key, patch, message) {
  const cfg = libCfg();
  if (isDemo(cfg)) { setStatus('示範模式', 'err'); setHint(STATE_TEXT.demo); return false; }
  const before = lib.user;
  lib.user = patchUser(lib.user, key, patch);
  render();
  try {
    lib.user = await saveUser(cfg, (doc) => patchUser(doc, key, patch), message);
    render();
    return true;
  } catch (e) {
    lib.user = before;
    render();
    setStatus('沒存到', 'err'); setRepo(''); setHint(errorText(e, '儲存'));
    return false;
  }
}

function toggleFavorite(it) { editUser(it.key, { favorite: !it.favorite }, `collective: ${it.favorite ? 'unfavorite' : 'favorite'} ${it.repo}`); }

// --- capturing

async function sendCapture(cfg, target, ctx) {
  const now = new Date();
  const capture = makeCapture(target, ctx, isoLocal(now));
  const id = await writeCapture(cfg, capture, labelOf(target));
  addHistory({ id, repo: target.repo, key: keyOf(target), lib: cfg.repo, at: now.toISOString(), state: 'pending', capture });
  return id;
}

function needsConnection(cfg, retry) {
  if (isDemo(cfg)) { setStatus('示範模式', 'err'); setHint(STATE_TEXT.demo); return true; }
  if (!cfg || !cfg.repo || !cfg.token) {
    setStatus('還沒連結', 'err');
    setHint('先連結收藏庫，連結後按「重試」。');
    addAction('重試', retry, true);
    openDrawer();
    return true;
  }
  return false;
}

async function submitOne(target, ctx) {
  const cfg = libCfg();
  setRepo(labelOf(target));
  clearActions();
  if (needsConnection(cfg, () => submitOne(target, ctx))) return;
  setStatus('送出中', 'busy');
  setHint('');
  try {
    await sendCapture(cfg, target, ctx);
    setStatus('已收', 'ok');
    setHint('分析約需 3–8 分鐘，完成後會出現在收藏裡。');
    render();
    loadLib();
    if (window.opener) setTimeout(() => window.close(), 1500);
  } catch (e) {
    setStatus('沒收到', 'err');
    setHint(errorText(e, '收藏'));
    addAction('重試', () => submitOne(target, ctx), true);
  }
}

// --- add dialog

const add = { pane: 'url', cands: [], tags: [], busy: false };
let voice = null;

function openAdd({ pane = 'url', text = '', postUrl = '', source = '', transcript = '', autoFind = false } = {}) {
  const d = $('add-dialog');
  add.cands = []; add.tags = []; $('cands').replaceChildren(); addMsg('');
  $('add-url').value = pane === 'url' ? text : '';
  $('share-text').value = pane === 'share' ? text : '';
  $('post-url').value = postUrl;
  $('transcript').value = transcript;
  $('add-note').value = '';
  $('add-source').value = source && SOURCE_LABEL[source] && ['github', 'threads', 'voice', 'friend', 'other'].includes(source) ? source : pane === 'voice' ? 'voice' : pane === 'share' ? 'threads' : 'github';
  showPane(pane);
  renderAddTags();
  updateSubmit();
  if (!d.open) d.showModal ? d.showModal() : d.setAttribute('open', '');
  closeSide();
  if (autoFind) findCandidates();
  else setTimeout(() => (pane === 'url' ? $('add-url') : pane === 'share' ? $('share-text') : $('voice-start')).focus(), 0);
}

function closeAdd() { if (voice) voice.cancel(); const d = $('add-dialog'); if (d.open) d.close ? d.close() : d.removeAttribute('open'); }

function showPane(pane) {
  add.pane = pane;
  for (const b of document.querySelectorAll('#add-dialog [role="tab"]')) b.setAttribute('aria-selected', String(b.dataset.pane === pane));
  for (const p of document.querySelectorAll('#add [data-pane]')) p.hidden = p.dataset.pane !== pane;
}

function addMsg(text, cls = '') { const m = $('add-msg'); m.textContent = text; m.className = `msg ${cls}`; }

function paneText() {
  if (add.pane === 'share') return [$('share-text').value, $('post-url').value];
  if (add.pane === 'voice') return [$('transcript').value];
  return [$('add-url').value];
}

function renderAddTags() {
  const vocab = tagVocabulary(lib.index, items);
  for (const t of add.tags) if (!vocab.some((v) => v.name === t)) vocab.push({ name: t, definition: '' });
  $('add-tags').replaceChildren(...vocab.map((t) => {
    const b = el('button', null, t.name); b.type = 'button'; b.title = t.definition || t.name;
    b.setAttribute('aria-pressed', String(add.tags.includes(t.name)));
    b.onclick = () => { add.tags = add.tags.includes(t.name) ? add.tags.filter((x) => x !== t.name) : [...add.tags, t.name]; renderAddTags(); };
    return b;
  }));
}

function findCandidates() {
  const texts = paneText();
  const r = extractTargets(...texts);
  if (add.pane === 'share' && !$('post-url').value && r.posts.length) $('post-url').value = r.posts[0].url;
  if (!r.items.length) {
    add.cands = []; renderCands();
    if (r.posts.length) addMsg(`只找到 ${r.posts[0].platform === 'threads' ? 'Threads' : '社群'}貼文網址。這個網頁讀不到貼文內容，請把貼文文字貼到「分享文字」，裡面要有 GitHub 網址。`, 'err');
    else if (add.pane === 'voice') addMsg('逐字稿裡沒有有效的 GitHub 網址。請補上完整網址（例如 github.com/owner/repo）；不會依專案名稱猜測是哪個 repo。', 'err');
    else addMsg('沒有找到 GitHub 網址。', 'err');
    return;
  }
  add.cands = markDuplicates(r.items, items).map((c) => ({ ...c, checked: !c.duplicate, note: '' }));
  const dups = add.cands.filter((c) => c.duplicate).length;
  addMsg(`找到 ${add.cands.length} 個 GitHub 網址${r.duplicates ? `（文字裡另有 ${r.duplicates} 個重複網址已合併）` : ''}${dups ? `，其中 ${dups} 個已在收藏中` : ''}。確認後按「收藏」。`);
  if (add.pane === 'voice') addMsg(`${$('add-msg').textContent} ${VOICE_TEXT.urlWarning}`);
  renderCands();
  resolveCandidates();
}

// Online checks for skill links: the real ref when the branch name has slashes, and whether the folder holds SKILL.md.
async function resolveCandidates() {
  const cfg = libCfg();
  const online = cfg && cfg.token && !isDemo(cfg);
  for (const c of [...add.cands]) {
    if (c.item_type !== 'skill' || c.checkedRemote) continue;
    c.checkedRemote = true;
    if (!online) { c.note = isDemo(cfg) ? '示範模式不會連到 GitHub 驗證。' : '尚未連結收藏庫，無法先確認；分析時會檢查 SKILL.md。'; continue; }
    try {
      if (c.refOptions) Object.assign(c, await resolveRef(c, (prefix) => listMatchingRefs(cfg, c.repo, prefix)));
      if (!c.verified) {
        const found = await findSkills(cfg, c.repo, c.ref);
        const dirs = skillDirs(found.entries, c.path);
        if (dirs.includes(c.path)) { c.verified = true; c.note = '已確認有 SKILL.md'; }
        else if (dirs.length) { replaceWithSkills(c, dirs, c.ref); continue; }
        else { c.checked = false; c.note = `這個資料夾裡找不到 SKILL.md${found.truncated ? '（repo 太大，清單不完整）' : ''}。`; }
      }
    } catch (e) {
      c.note = e.code === 'ref-not-found' ? '找不到這個分支或 tag，請在下方選擇正確的分支／路徑切法。' : errorText(e, '確認 skill');
    }
    renderCands();
  }
  renderCands();
}

function replaceWithSkills(c, dirs, ref) {
  const at = add.cands.indexOf(c);
  const fresh = markDuplicates(dirs.map((path) => ({ item_type: 'skill', owner: c.owner, repo: c.repo, url: c.url, ref, path, refOptions: null,
    verified: true, checkedRemote: true, key: keyOf({ item_type: 'skill', repo: c.repo, path }), source_url: c.source_url })), items)
    .filter((n) => !add.cands.some((x) => x.key === n.key))
    .map((n) => ({ ...n, checked: !n.duplicate && dirs.length === 1, note: '已確認有 SKILL.md' }));
  add.cands.splice(at, 1, ...fresh);
  addMsg(fresh.length ? `${c.repo} 裡找到 ${dirs.length} 個 skill，勾選要收藏的項目。` : `${c.repo} 的 skill 都已在收藏中。`);
  renderCands();
}

async function listRepoSkills(c) {
  const cfg = libCfg();
  if (isDemo(cfg) || !cfg || !cfg.token) { addMsg('要列出 repo 裡的 SKILL.md 需要先連結收藏庫；也可以直接貼 SKILL.md 的網址。', 'err'); return; }
  addMsg(`正在列出 ${c.repo} 裡的 SKILL.md…`);
  try {
    const found = await findSkills(cfg, c.repo, null);
    const dirs = skillDirs(found.entries);
    if (!dirs.length) { addMsg(`${c.repo} 裡沒有找到 SKILL.md${found.truncated ? '（repo 太大，清單不完整，請直接貼 SKILL.md 網址）' : ''}。`, 'err'); return; }
    replaceWithSkills(c, dirs, found.defaultBranch);
  } catch (e) { addMsg(errorText(e, '列出 skill'), 'err'); }
}

function renderCands() {
  $('cands').replaceChildren(...add.cands.map((c, i) => {
    const row = el('div', `cand${c.duplicate ? ' dup' : ''}`);
    const head = el('div', 'head');
    const box = el('input'); box.type = 'checkbox'; box.checked = c.checked; box.id = `cand-${i}`;
    box.onchange = () => { c.checked = box.checked; updateSubmit(); };
    const name = el('label', 'name', c.repo); name.htmlFor = box.id; name.style.margin = '0';
    head.append(box, name, el('span', `pill type${c.item_type === 'skill' ? ' skill' : ''}`, ITEM_TYPE_LABEL[c.item_type]));
    if (c.duplicate) {
      head.append(el('span', 'pill', '已在收藏中'));
      if (c.duplicate.stem) { const a = el('a', null, '開啟'); a.href = `read.html#${c.duplicate.stem}`; head.append(a); }
    }
    row.append(head);
    if (c.item_type === 'skill') {
      row.append(el('div', 'sub', `路徑：${c.path || '(根目錄)'}${c.ref ? ` · 來源 ref：${c.ref}` : ' · 預設分支'}`));
      if (c.refOptions) {
        const sel = el('select'); sel.setAttribute('aria-label', '分支／路徑切法');
        c.refOptions.forEach((o, k) => { const opt = el('option', null, `分支 ${o.ref} ／ 路徑 ${o.path || '(根目錄)'}`); opt.value = String(k); sel.append(opt); });
        sel.value = String(Math.max(0, c.refOptions.findIndex((o) => o.ref === c.ref)));
        sel.onchange = () => { Object.assign(c, chooseSplit(c, Number(sel.value)), { refOptions: c.refOptions }); c.duplicate = markDuplicates([c], items)[0].duplicate; renderCands(); };
        row.append(sel);
      }
    } else {
      const toSkill = el('button', 'linkish', '這個 repo 裡有 skill？列出 SKILL.md 改收 skill'); toSkill.type = 'button';
      toSkill.onclick = () => listRepoSkills(c);
      row.append(toSkill);
    }
    if (c.note) row.append(el('div', `sub${/找不到|無法|失敗|權限|不支援/.test(c.note) ? ' warn' : ''}`, c.note));
    if (c.duplicate && c.checked) row.append(el('div', 'sub', '勾選後會在原收藏記錄一次新的分享（不會重複新增，也不會重新分析）。'));
    return row;
  }));
  updateSubmit();
}

function updateSubmit() {
  const n = add.cands.filter((c) => c.checked).length;
  $('add-submit').textContent = add.cands.length ? `收藏 ${n} 筆` : '收藏';
  $('add-submit').disabled = add.busy || (add.cands.length > 0 && n === 0);
}

async function submitAdd(e) {
  e.preventDefault();
  if (add.busy) return;
  if (!add.cands.length) {
    findCandidates();
    // A single plain repo link from the URL tab goes straight in; anything else waits for confirmation.
    const only = add.cands.length === 1 && add.cands[0];
    if (!(add.pane === 'url' && only && only.checked && only.item_type === 'repository')) return;
  }
  const chosen = add.cands.filter((c) => c.checked);
  if (!chosen.length) return;
  const cfg = libCfg();
  if (isDemo(cfg)) { addMsg(STATE_TEXT.demo, 'err'); return; }
  if (!cfg || !cfg.repo || !cfg.token) { addMsg('請先連結收藏庫（右下角／側欄的「尚未連結收藏庫」）。', 'err'); openDrawer(); return; }
  const ctx = {
    source: $('add-source').value, note: $('add-note').value.trim(), tags: add.tags,
    share_text: add.pane === 'share' ? $('share-text').value : '', post_url: add.pane === 'share' ? $('post-url').value.trim() : '',
    transcript: add.pane === 'voice' ? $('transcript').value : '',
  };
  add.busy = true; updateSubmit();
  const ok = [], failed = [];
  for (const c of chosen) {
    addMsg(`送出中：${labelOf(c)}…`);
    try { await sendCapture(cfg, c, ctx); ok.push(c); c.checked = false; c.note = '已送出'; }
    catch (err) { failed.push([c, err]); c.note = errorText(err, '收藏'); }
  }
  add.busy = false;
  renderCands();
  if (failed.length) addMsg(`已收 ${ok.length} 筆，${failed.length} 筆沒送出：${errorText(failed[0][1], '收藏')} 可以再按一次「收藏」重試。`, 'err');
  else addMsg(`已收 ${ok.length} 筆。分析約需 3–8 分鐘，完成後會出現在收藏裡。`, 'ok');
  if (ok.length) {
    setStatus('已收', 'ok'); setRepo(ok.length === 1 ? labelOf(ok[0]) : `${ok.length} 筆`); setHint('分析完成後會出現在收藏裡。'); clearActions();
    render(); loadLib();
    if (!failed.length) setTimeout(closeAdd, 1400);
  }
}

function setupVoice() {
  $('voice-privacy').textContent = VOICE_TEXT.privacy;
  $('voice-warning').textContent = VOICE_TEXT.urlWarning;
  const stateText = (s, why) => {
    const st = $('voice-state');
    st.dataset.live = s === 'listening' ? '1' : '0';
    st.textContent = s === 'listening' ? '● 聆聽中…' : why === 'cancelled' ? '已取消' : s === 'error' ? VOICE_TEXT[why] || VOICE_TEXT.error : '';
    $('voice-start').disabled = s === 'listening';
    $('voice-stop').disabled = s !== 'listening';
    $('voice-cancel').disabled = s !== 'listening';
  };
  let before = '';
  voice = createVoice({
    Recognizer: recognizerClass(window),
    onText: (text) => { $('transcript').value = text; },
    onState: (s, why) => { if (why === 'cancelled') $('transcript').value = before; stateText(s, why); },
  });
  if (!voice.supported) { stateText('error', 'unsupported'); $('voice-start').disabled = true; }
  $('voice-start').onclick = () => { before = $('transcript').value; voice.start(before ? `${before} ` : ''); };
  $('voice-stop').onclick = () => voice.stop();
  $('voice-cancel').onclick = () => voice.cancel();
  $('voice-normalize').onclick = () => { $('transcript').value = normalizeSpokenLinks($('transcript').value); addMsg('已轉換，請確認網址是否正確後再按「找出 GitHub 網址」。'); };
}

// --- capture details (queued / failed captures that have no entry yet)

function openCapture(it) {
  const d = $('capture-dialog');
  const c = it.capture || {};
  $('cap-title').textContent = labelOf(it);
  const dl = el('dl', 'kv');
  const row = (k, v) => { if (v) dl.append(el('dt', null, k), el('dd', null, v)); };
  row('類型', ITEM_TYPE_LABEL[it.itemType]);
  row('分析狀態', jobLabel(it) || '分析完成');
  row('錯誤', it.jobError);
  if (it.itemType === 'skill') { row('Skill 路徑', it.skillPath || '(根目錄)'); row('來源 ref', it.ref || '預設分支'); }
  row('來源', SOURCE_LABEL[c.source] || c.source);
  row('收藏時間', c.captured_at ? new Date(c.captured_at).toLocaleString('zh-TW') : '');
  row('原貼文', c.post_url);
  row('分享文字', c.share_text);
  row('逐字稿', c.transcript);
  row('備註', c.note);
  row('標籤', (c.tags || []).join('、'));
  $('cap-body').replaceChildren(dl);
  $('cap-msg').textContent = '';
  const cfg = libCfg();
  const acts = [];
  const btn = (label, cls, fn) => { const b = el('button', `btn ${cls}`, label); b.type = 'button'; b.onclick = fn; acts.push(b); return b; };
  const inboxRec = it.job === 'failed' ? lib.inbox.failed.find((f) => f.id === it.jobId) : lib.inbox.queued.find((f) => f.id === it.jobId);
  const run = async (b, label, fn) => {
    if (isDemo(cfg)) { $('cap-msg').textContent = STATE_TEXT.demo; return; }
    b.disabled = true;
    try { await fn(); $('cap-msg').textContent = `${label}完成。`; setTimeout(() => d.close(), 700); loadLib(); }
    catch (e) { b.disabled = false; $('cap-msg').textContent = errorText(e, label); }
  };
  if (it.job === 'failed' && inboxRec) {
    const retry = btn('重新排入分析', 'primary', () => run(retry, '重新排入', () => requeueFailed(cfg, inboxRec)));
    const drop = btn('放棄這筆', 'danger', () => { if (confirm('刪除這筆失敗紀錄？分享文字與備註會一起刪掉。')) run(drop, '刪除', () => deleteFile(cfg, inboxRec.path, inboxRec.sha, `discard: ${it.repo}`)); });
  } else if (inboxRec) {
    const cancel = btn('取消這筆收藏', 'danger', () => { if (confirm('取消這筆還沒分析的收藏？')) run(cancel, '取消', () => deleteFile(cfg, inboxRec.path, inboxRec.sha, `cancel: ${it.repo}`)); });
  }
  if (!isDemo(cfg)) { const a = el('a', 'btn', 'GitHub ↗'); a.href = `https://github.com/${it.repo}`; a.target = '_blank'; a.rel = 'noopener'; acts.push(a); }
  if (cfg && cfg.repo && !isDemo(cfg)) { const a = el('a', 'btn', 'Actions 紀錄 ↗'); a.href = `https://github.com/${cfg.repo}/actions`; a.target = '_blank'; a.rel = 'noopener'; acts.push(a); }
  btn('關閉', '', () => d.close());
  $('cap-actions').replaceChildren(...acts);
  d.showModal ? d.showModal() : d.setAttribute('open', '');
}

// --- backup

let pendingImport = null;

function openBackup() {
  pendingImport = null;
  $('bk-preview').replaceChildren(); $('bk-msg').textContent = ''; $('bk-apply').hidden = true; $('bk-file').value = '';
  const d = $('backup-dialog'); d.showModal ? d.showModal() : d.setAttribute('open', '');
  closeSide();
}

function exportNow() {
  const cfg = libCfg();
  if (!connected(cfg)) { $('bk-msg').textContent = '先連結收藏庫才有資料可以匯出。'; return; }
  const data = exportBackup({ library: isDemo(cfg) ? 'demo' : cfg.repo, index: lib.index, user: lib.user, items });
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = el('a'); a.href = url; a.download = `collective-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('bk-msg').textContent = `已匯出 ${items.length} 筆收藏與你的筆記。`;
}

async function previewImport(file) {
  $('bk-msg').textContent = '';
  try {
    const backup = JSON.parse(await file.text());
    const plan = planImport(backup, { user: lib.user, items });
    pendingImport = { backup, plan };
    const box = el('div');
    box.append(el('p', null, `筆記／標籤／最愛：${plan.updated} 筆會更新，${plan.kept} 筆保留目前較新的版本。`));
    if (plan.toQueue.length) {
      const lab = el('label'); const cb = el('input'); cb.type = 'checkbox'; cb.id = 'bk-queue'; cb.checked = true;
      lab.append(cb, ` 收藏庫裡缺少 ${plan.toQueue.length} 筆，同時重新排入分析`);
      box.append(lab);
    }
    $('bk-preview').replaceChildren(box);
    $('bk-apply').hidden = false;
  } catch (e) {
    pendingImport = null; $('bk-apply').hidden = true;
    $('bk-msg').textContent = `無法讀取備份檔：${e.message}`;
  }
}

async function applyImport() {
  const cfg = libCfg();
  if (!pendingImport) return;
  if (isDemo(cfg)) { $('bk-msg').textContent = STATE_TEXT.demo; return; }
  const { backup } = pendingImport;
  const queue = $('bk-queue') && $('bk-queue').checked ? pendingImport.plan.toQueue : [];
  $('bk-apply').disabled = true;
  try {
    lib.user = await saveUser(cfg, (doc) => planImport(backup, { user: doc, items }).user, 'collective: import backup');
    let queued = 0;
    for (const t of queue) { await sendCapture(cfg, t, { source: 'other', note: '從備份匯入' }); queued += 1; }
    $('bk-msg').textContent = `匯入完成${queued ? `，已排入 ${queued} 筆分析` : ''}。`;
    pendingImport = null; $('bk-apply').hidden = true;
    loadLib();
  } catch (e) {
    $('bk-msg').textContent = errorText(e, '匯入');
  } finally { $('bk-apply').disabled = false; }
}

// --- settings drawer, side panel, demo

function openDrawer() { const d = $('drawer'); if (!d.open) { if (d.showModal) d.showModal(); else d.setAttribute('open', ''); } closeSide(); }
function closeDrawer() { const d = $('drawer'); if (d.open) d.close ? d.close() : d.removeAttribute('open'); }
function drawerMessage(text, isError) { const p = $('drawer-msg'); p.textContent = text; p.className = `msg ${isError ? 'err' : 'ok'}`; }
function openSide() { $('side').classList.add('open'); $('scrim').hidden = false; }
function closeSide() { $('side').classList.remove('open'); $('scrim').hidden = true; }

function setDemo(on) {
  const cfg = loadCfg() || {};
  const next = { ...cfg };
  if (on) next.demo = true; else delete next.demo;
  saveCfg(next);
  applyTransport();
  $('drawer-demo').textContent = on ? '離開示範模式' : '以示範資料瀏覽';
  closeDrawer();
  ui.view = 'all'; ui.tags = [];
  setStatus(''); setRepo(''); setHint(''); clearActions();
  loadLib();
}

function randomHex(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

// On github.com the bookmarklet carries the nonce (auto-write). Anywhere else it only carries the
// selected text and page link, never the nonce: a page's own script could intercept window.open.
function renderBookmarklet(base, cfg) {
  const a = $('bookmarklet');
  if (!cfg || !cfg.nonce) { a.removeAttribute('href'); a.textContent = '（先儲存設定）'; return; }
  a.textContent = '收進 Collective Hub';
  a.href = "javascript:(function(){var h=location.hostname,r='',u,B='" + base + "';try{r=new URL(document.referrer).hostname}catch(e){}" +
    "if(h==='github.com'){u=B+'#k=" + cfg.nonce + "&url='+encodeURIComponent(location.href)+'&ref='+encodeURIComponent(r)}" +
    "else{u=B+'#text='+encodeURIComponent(String(getSelection()).slice(0,3000))+'&post='+encodeURIComponent(location.href)}" +
    "window.open(u,'_blank','width=560,height=720')})()";
}

// --- incoming shares

// Auto-write only when provenance is proven and there is exactly one new repository; everything
// else needs an explicit tap. Shared text is only ever searched for links, never acted on.
// - Share sheet: manifest POST -> service worker stores a single-use handoff -> #s=<id>,
//   accepted only inside the installed app window. A crafted link can only GET, so it
//   cannot mint a handoff id.
// - Bookmarklet on github.com: #k=<nonce>; the bookmarklet adds the nonce only there.
// - Plain ?url= / #url= / #text= links (bookmarklet elsewhere, iOS Shortcuts): always confirm.
async function handleIncoming(base, cfg) {
  const q = new URLSearchParams(location.search);
  const h = new URLSearchParams(location.hash.slice(1));
  let shared = null;
  let trusted = false;
  if (h.has('s')) {
    // A cross-site form can also POST to ./share, but it lands in a browser tab;
    // only the OS share sheet delivers a POST into the installed app window.
    shared = await takeHandoff(h.get('s'));
    trusted = Boolean(shared) && matchMedia('(display-mode: standalone)').matches;
  } else if (h.has('url')) {
    shared = { url: h.get('url'), ref: h.get('ref') };
    trusted = Boolean(cfg && cfg.nonce && h.get('k') === cfg.nonce);
  } else if (h.has('text')) {
    shared = { text: h.get('text'), url: h.get('post') || '' };
  } else if (q.has('url') || q.has('text') || q.has('title')) {
    shared = { title: q.get('title'), text: q.get('text'), url: q.get('url') };
  }
  if (location.search || location.hash) history.replaceState(null, '', base);
  if (!shared) return;
  $('received').textContent = JSON.stringify(shared, null, 2);
  await Promise.race([libReady, new Promise((r) => setTimeout(r, 4000))]);
  const r = extractTargets(shared.url, shared.text, shared.title);
  const post = r.posts[0] || null;
  const source = detectSource(shared.ref || '') || (post ? post.platform : '') || '';
  const allText = [shared.text, shared.url, shared.title].filter(Boolean).join('\n');
  if (!r.items.length) {
    if (post) {
      setStatus('需要貼文內文', 'err');
      setHint('只收到貼文網址，這個網頁讀不到貼文內容。請複製貼文文字，貼到「分享文字」。');
      addAction('貼上分享文字', () => openAdd({ pane: 'share', postUrl: post.url, source: post.platform === 'threads' ? 'threads' : 'other' }), true);
    } else {
      setStatus('沒找到連結', 'err');
      setHint('分享的內容裡沒有 GitHub 網址。');
    }
    return;
  }
  const cands = markDuplicates(r.items, items);
  const ctx = { source: source === 'x' || source === 'youtube' ? 'other' : source, post_url: post ? post.url : '',
    share_text: shared.text && shared.text.trim() !== (shared.url || '').trim() ? shared.text : '' };
  const one = cands.length === 1 ? cands[0] : null;
  if (trusted && one && one.item_type === 'repository' && !one.duplicate) { submitOne(one, ctx); return; }
  setStatus('待確認', 'ask');
  setRepo(one ? labelOf(one) : `${cands.length} 個 GitHub 網址`);
  setHint(one && one.duplicate ? '這個已在收藏中。' : trusted ? '有多個網址或包含 skill，確認後才收。' : '這個連結不是從分享選單或你的書籤來的，確認後才收。');
  if (one && !one.duplicate && !one.refOptions) addAction('確認收藏', () => submitOne(one, ctx), true);
  addAction(one ? '檢視與補充' : '檢視候選', () => openAdd({ pane: 'share', text: allText, postUrl: ctx.post_url, source: ctx.source, autoFind: true }), !one);
}

// Coupled with sw.js: same cache name and key path; the entry is deleted on first read.
async function takeHandoff(id) {
  if (!/^[0-9a-f-]{36}$/.test(id || '') || !('caches' in self)) return null;
  try {
    const cache = await caches.open('repobox-handoff');
    const key = new URL(`handoff/${id}`, location.href).href;
    const res = await cache.match(key);
    if (!res) return null;
    await cache.delete(key);
    return await res.json();
  } catch { return null; }
}

// --- polling: while captures wait for Actions, look again every minute (only while visible).

let pollTimer = null;
function schedulePoll() {
  clearTimeout(pollTimer);
  if (document.hidden || isDemo(loadCfg()) || !items.some((it) => it.job === 'queued' || it.job === 'running')) return;
  pollTimer = setTimeout(() => loadLib(), POLL_MS);
}

function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  applyTransport();
  const prefs = loadPrefs();
  ui.sort = prefs.sort === 'analyzed' ? 'analyzed' : 'captured';
  ui.layout = prefs.layout === 'list' ? 'list' : 'cards';
  $('sort').value = ui.sort;
  for (const b of $('layout').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.layout === ui.layout));

  let cfg = loadCfg();
  if (cfg) { $('repo').value = cfg.repo || ''; $('token').value = cfg.token ? '********' : ''; $('dev-api').value = cfg.api || ''; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  $('dev-api-row').hidden = !local;
  $('drawer-demo').textContent = isDemo(cfg) ? '離開示範模式' : '以示範資料瀏覽';
  const base = location.origin + location.pathname;
  renderBookmarklet(base, cfg);
  loadLib();

  $('conn').onclick = openDrawer;
  $('drawer-close').onclick = closeDrawer;
  $('drawer-demo').onclick = () => setDemo(!isDemo(loadCfg()));
  for (const id of ['drawer', 'add-dialog', 'capture-dialog', 'backup-dialog']) {
    const d = $(id);
    d.addEventListener('click', (e) => {
      const r = d.getBoundingClientRect();
      const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      if (e.target === d && outside) (id === 'add-dialog' ? closeAdd() : d.close());
    });
  }
  $('library').onclick = (e) => { if (!loadCfg()) { e.preventDefault(); openDrawer(); } };
  $('menu').onclick = openSide;
  $('scrim').onclick = closeSide;
  $('open-add').onclick = () => openAdd();
  $('fab').onclick = () => openAdd();
  $('open-backup').onclick = openBackup;
  $('bk-close').onclick = () => $('backup-dialog').close();
  $('bk-export').onclick = exportNow;
  $('bk-file').onchange = () => { const f = $('bk-file').files[0]; if (f) previewImport(f); };
  $('bk-apply').onclick = applyImport;
  $('q').oninput = () => { ui.query = $('q').value; renderList(libCfg()); };
  $('sort').onchange = () => { ui.sort = $('sort').value; savePrefs(); renderList(libCfg()); };
  for (const b of $('layout').querySelectorAll('button')) {
    b.onclick = () => { ui.layout = b.dataset.layout; savePrefs(); for (const x of $('layout').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b)); renderList(libCfg()); };
  }

  const PANE_SOURCE = { url: 'github', share: 'threads', voice: 'voice' };
  for (const b of document.querySelectorAll('#add-dialog [role="tab"]')) {
    b.onclick = () => {
      // The source follows the tab unless the person already picked something else.
      if ($('add-source').value === PANE_SOURCE[add.pane]) $('add-source').value = PANE_SOURCE[b.dataset.pane];
      showPane(b.dataset.pane); add.cands = []; renderCands(); addMsg('');
    };
  }
  $('add').onsubmit = submitAdd;
  $('find').onclick = findCandidates;
  $('add-close').onclick = closeAdd;
  $('add-dialog').addEventListener('cancel', () => { if (voice) voice.cancel(); });
  const addTag = () => {
    const t = cleanTag($('add-newtag').value);
    if (t && !add.tags.includes(t)) add.tags.push(t);
    $('add-newtag').value = '';
    renderAddTags();
  };
  $('add-newtag-btn').onclick = addTag;
  $('add-newtag').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } };
  setupVoice();

  $('settings').onsubmit = (e) => {
    e.preventDefault();
    const repo = $('repo').value.trim();
    const tokenInput = $('token').value.trim();
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) { drawerMessage('收藏庫格式應為「帳號/repo 名稱」。', true); return; }
    const token = tokenInput === '********' ? (cfg && cfg.token) : tokenInput;
    if (!token) { drawerMessage('請貼上 token。', true); return; }
    const api = local ? $('dev-api').value.trim() : '';
    const next = { repo, token, nonce: (cfg && cfg.nonce) || randomHex(16), ...(api ? { api } : {}) };
    if (!saveCfg(next)) { drawerMessage('無法儲存：這個瀏覽器封鎖了本機儲存。', true); return; }
    cfg = next;
    $('token').value = '********';
    drawerMessage('已儲存。', false);
    applyTransport();
    $('drawer-demo').textContent = '以示範資料瀏覽';
    renderBookmarklet(base, cfg);
    loadLib();
    setTimeout(closeDrawer, 600);
  };

  if (!connected(cfg) && !location.hash && !location.search) openDrawer();
  handleIncoming(base, cfg);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadLib(); });
}

init();
