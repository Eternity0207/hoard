import './style.css';
import { startWorker, restartWorker, load, call, on, stopGeneration } from './client.js';
import { prepare, ocr, ocrPool } from './analyze.js';
import { KINDS, KIND_BY_ID, kindPrompts, averageKinds, classify } from './kinds.js';
import { KeywordIndex, rank, snippet, tokens, stem } from './search.js';
import { suggest, RULES } from './sweep.js';
import * as db from './db.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bump when the pipeline changes in a way that needs every screenshot re-read.
const PIPELINE = 1;
const SWEPT_DIR = 'Swept by Hoard';
const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;
const PACE = {
  sloth: { par: 1, nap: 2500, ocr: 1, label: 'Sloth pace' },
  steady: { par: 2, nap: 0, ocr: 1, label: 'Steady pace' },
  sprint: { par: 4, nap: 0, ocr: 2, label: 'Sprint' },
};
const EXAMPLES = ['wifi password', 'where did I park', 'boarding pass', 'sunset photo', 'tracking number', 'when is rent due?'];

const state = {
  shots: [],
  byId: new Map(),
  source: null, // { type: 'folder' | 'files' | 'sample', name, handle? }
  files: new Map(), // id -> File, for originals we can't re-open from disk
  queue: [],
  running: false,
  paused: false,
  pace: store.get('pace', 'steady'),
  core: 'idle',
  llm: 'idle',
  kindVecs: null,
  index: null,
  kindFilter: null,
  done: 0,
  total: 0,
  sweep: { groups: { duplicate: [], code: [], expired: [], accidental: [] }, dupOf: {} },
  detail: null,
  results: [],
  qcache: new Map(),
  download: null,
};

// ---------- models ----------

on('progress', ({ which, loaded, total }) => {
  if (which === 'core') {
    state.download = total ? loaded / total : 0;
    renderStatus();
  } else if (which === 'llm') {
    $('llmBarWrap').hidden = false;
    $('llmBar').style.width = `${Math.min(100, (loaded / total) * 100)}%`;
    $('llmState').textContent = `${Math.round(loaded / 1e6)} of ${Math.round(total / 1e6)} MB`;
    const who = $('answer').querySelector('.who');
    if (!$('answer').hidden && who && state.llm === 'loading') {
      who.textContent = `${store.get('llmDownloaded', false) ? 'Loading' : 'Downloading'} Gemma · ${Math.round((loaded / total) * 100)}% (once; it stays on this device)`;
    }
  }
});
on('status', ({ which, text }) => { if (which === 'llm') $('llmState').textContent = text; });

async function ensureCore() {
  if (state.core === 'ready') return;
  if (state.core !== 'loading') {
    state.core = 'loading';
    renderStatus();
  }
  try {
    await load('core');
    if (!state.kindVecs) {
      const rows = kindPrompts();
      state.kindVecs = averageKinds(rows, await call('siglip-text', { texts: rows.map((r) => r.p) }));
    }
    state.core = 'ready';
    state.download = null;
    store.set('coreDownloaded', true);
  } catch (err) {
    state.core = 'error';
    toast(navigator.onLine ? `Couldn't load the search models: ${err.message}` : 'You are offline and the search models are not downloaded yet.');
    throw err;
  } finally {
    renderStatus();
  }
}

function llmDevice() {
  return navigator.gpu && !store.get('gpuFailed', false) ? 'webgpu' : 'wasm';
}

async function ensureLlm() {
  if (state.llm === 'ready') return;
  state.llm = 'loading';
  renderModels();
  const device = llmDevice();
  try {
    await load('llm', { device });
    state.llm = 'ready';
    state.llmDevice = device;
    store.set('llmDownloaded', true);
  } catch (err) {
    if (device === 'webgpu') {
      // GPU path failed: remember that, start a fresh worker, and use the CPU.
      store.set('gpuFailed', true);
      restartWorker();
      state.core = 'idle';
      state.llm = 'idle';
      toast('Gemma could not use the GPU here, switching to the smaller CPU model.');
      ensureCore().catch(() => {});
      return ensureLlm();
    }
    state.llm = 'error';
    $('llmState').textContent = `Couldn't load: ${err.message}`;
    throw err;
  } finally {
    renderModels();
  }
}

function renderModels() {
  const label = { idle: 'Not loaded', loading: 'Loading…', ready: 'Ready', error: 'Error' };
  $('coreState').textContent = state.core === 'loading' && state.download != null ? `${Math.round(state.download * 100)}%` : label[state.core];
  $('coreState').dataset.state = state.core;
  if (state.llm !== 'loading') $('llmState').textContent = label[state.llm];
  $('llmState').dataset.state = state.llm;
  $('llmInfo').textContent = llmDevice() === 'webgpu' ? 'Gemma 3 1B on your GPU · ~790 MB' : 'Gemma 3 270M on your CPU (no WebGPU here) · ~590 MB';
  $('loadLlm').hidden = state.llm === 'ready';
  $('loadLlm').disabled = state.llm === 'loading';
  if (state.llm === 'ready') $('llmBarWrap').hidden = true;
}

// ---------- shots ----------

const thumbUrls = new Map();
function thumbUrl(shot) {
  let u = thumbUrls.get(shot.id);
  if (!u) { u = URL.createObjectURL(shot.thumb); thumbUrls.set(shot.id, u); }
  return u;
}

function addShot(rec) {
  if (state.byId.has(rec.id)) state.shots = state.shots.filter((s) => s.id !== rec.id);
  state.shots.push(rec);
  state.byId.set(rec.id, rec);
  state.index = null;
}

const live = () => state.shots.filter((s) => !s.swept);

// ---------- sources ----------

async function pickFolder() {
  if (!window.showDirectoryPicker) {
    $('filesInput').click();
    return;
  }
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: 'hoard', mode: 'readwrite', startIn: 'pictures' });
  } catch (err) {
    if (err.name !== 'AbortError') toast(`Couldn't open that folder: ${err.message}`);
    return;
  }
  await switchSource({ type: 'folder', name: handle.name, handle });
  await scanFolder();
}

async function switchSource(src) {
  const prev = state.source;
  const same = prev && prev.type === src.type && (src.type !== 'folder' || (await prev.handle?.isSameEntry?.(src.handle)));
  if (!same && state.shots.length) {
    await db.clearShots();
    state.shots = [];
    state.byId.clear();
    state.queue = [];
    state.index = null;
    for (const u of thumbUrls.values()) URL.revokeObjectURL(u);
    thumbUrls.clear();
  }
  state.source = src;
  await db.setKV('source', src.type === 'files' ? { type: 'files', name: src.name } : src);
  showApp();
}

async function* walk(dir, prefix = '', depth = 0) {
  for await (const [name, h] of dir.entries()) {
    if (h.kind === 'directory') {
      if (name === SWEPT_DIR || name.startsWith('.') || depth >= 3) continue;
      yield* walk(h, `${prefix}${name}/`, depth + 1);
    } else if (IMAGE_RE.test(name)) {
      yield { path: prefix + name, handle: h };
    }
  }
}

async function permission(handle, ask) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if (!ask) return false;
  return (await handle.requestPermission(opts)) === 'granted';
}

async function scanFolder() {
  const root = state.source?.handle;
  if (!root) return;
  if (!(await permission(root, true))) {
    $('reconnect').hidden = false;
    return;
  }
  $('reconnect').hidden = true;
  setStatusText('Looking for screenshots…', true);
  const seen = new Set();
  const fresh = [];
  for await (const { path, handle } of walk(root)) {
    const f = await handle.getFile();
    // Path + size identifies a file; copying or restoring it keeps both.
    const id = `f:${path}:${f.size}`;
    seen.add(id);
    if (!state.byId.has(id)) fresh.push({ id, path, source: 'folder', time: f.lastModified, getFile: () => handle.getFile() });
  }
  const gone = state.shots.filter((s) => s.source === 'folder' && !s.swept && !seen.has(s.id)).map((s) => s.id);
  if (gone.length) {
    await db.deleteShots(gone);
    for (const id of gone) state.byId.delete(id);
    state.shots = state.shots.filter((s) => state.byId.has(s.id));
    state.index = null;
  }
  enqueue(fresh);
  if (!fresh.length) toast(state.shots.length ? 'No new screenshots. You are up to date.' : 'No images found in that folder.');
  else if (state.shots.length) toast(`Found ${fresh.length} new screenshot${fresh.length === 1 ? '' : 's'}.`);
  refresh();
}

async function useFiles(list) {
  const files = [...list].filter((f) => IMAGE_RE.test(f.name));
  if (!files.length) { toast('No images in that folder.'); return; }
  const name = files[0].webkitRelativePath?.split('/')[0] || 'Chosen files';
  await switchSource({ type: 'files', name });
  const items = files.map((f) => {
    const id = `u:${f.webkitRelativePath || f.name}:${f.size}`;
    state.files.set(id, f);
    return { id, path: f.webkitRelativePath || f.name, source: 'files', time: f.lastModified, getFile: async () => f };
  }).filter((it) => !state.byId.has(it.id));
  enqueue(items);
  refresh();
}

async function useSample() {
  await switchSource({ type: 'sample', name: 'Sample pile' });
  setStatusText('Drawing the sample pile…', true);
  const { makeSampleHoard } = await import('./sample.js');
  const sample = await makeSampleHoard();
  const items = sample.map(({ id, file }) => {
    const sid = `s:${id}`;
    state.files.set(sid, file);
    return { id: sid, path: file.name, source: 'sample', time: file.lastModified, getFile: async () => file };
  }).filter((it) => !state.byId.has(it.id));
  enqueue(items);
  refresh();
}

// The sample is drawn, not stored, so after a reload its originals are redrawn.
async function sampleOriginal(id) {
  if (!state.files.has(id)) {
    const { makeSampleHoard } = await import('./sample.js');
    for (const s of await makeSampleHoard()) if (!state.files.has(`s:${s.id}`)) state.files.set(`s:${s.id}`, s.file);
  }
  return state.files.get(id);
}

async function resolvePath(path) {
  const parts = path.split('/');
  let dir = state.source.handle;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
  return { dir, file: await dir.getFileHandle(parts.at(-1)), name: parts.at(-1) };
}

async function original(shot) {
  if (shot.source === 'folder') {
    if (!(await permission(state.source.handle, true))) throw new Error('Hoard needs permission to open the folder again.');
    if (shot.swept) {
      const dir = await state.source.handle.getDirectoryHandle(SWEPT_DIR);
      return (await dir.getFileHandle(shot.sweptName)).getFile();
    }
    return (await resolvePath(shot.path)).file.getFile();
  }
  if (shot.source === 'sample') return sampleOriginal(shot.id);
  return state.files.get(shot.id) || null;
}

// ---------- indexing ----------

function enqueue(items) {
  // Newest first: recent screenshots are the ones people go looking for.
  items.sort((a, b) => b.time - a.time);
  const queued = new Set(state.queue.map((q) => q.id));
  for (const it of items) if (!queued.has(it.id)) state.queue.push(it);
  state.total = state.done + state.queue.length;
  runQueue();
}

let wake = null;
async function runQueue() {
  if (state.running || !state.queue.length) return;
  state.running = true;
  renderStatus();
  try {
    await ensureCore();
    const inflight = new Set();
    while (state.queue.length || inflight.size) {
      if (state.paused) {
        await new Promise((r) => { wake = r; });
        continue;
      }
      const pace = PACE[state.pace];
      await ocrPool(pace.ocr);
      while (inflight.size < pace.par && state.queue.length) {
        const item = state.queue.shift();
        const p = processOne(item)
          .catch((err) => console.warn('Skipped', item.path, err))
          .finally(() => { inflight.delete(p); state.done++; scheduleRefresh(); });
        inflight.add(p);
      }
      if (inflight.size) await Promise.race(inflight);
      if (pace.nap && state.queue.length) await sleep(pace.nap);
    }
  } catch {
    /* model load failed; already reported */
  } finally {
    state.running = false;
    if (!state.queue.length) { state.done = 0; state.total = 0; }
    refresh();
  }
}

async function processOne(item) {
  const file = await item.getFile();
  const p = await prepare(file);
  const { text, conf } = await ocr(p.ocrBlob);
  const { img, txt } = await call('embed-shot', { blob: p.thumb, text: text.slice(0, 2000) });
  const k = classify(text, img, state.kindVecs);
  const rec = {
    id: item.id, v: PIPELINE, source: item.source, path: item.path, name: file.name, size: file.size,
    takenAt: p.takenAt, w: p.width, h: p.height, thumb: p.thumb, dhash: p.dhash, lumStd: p.lumStd, edgeFrac: p.edgeFrac,
    text, conf, img, txt, kind: k.kind, kept: false, swept: false, indexedAt: Date.now(),
  };
  await db.putShot(rec);
  addShot(rec);
}

function setPaused(p) {
  state.paused = p;
  if (!p) { wake?.(); wake = null; }
  $('pauseBtn').textContent = p ? 'Resume indexing' : 'Pause indexing';
  renderStatus();
}

// ---------- refresh ----------

let refreshTimer = null;
function scheduleRefresh() {
  renderStatus();
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 900);
}

function refresh() {
  state.sweep = suggest(state.shots);
  renderStatus();
  renderKinds();
  renderSweep();
  runSearch({ keepAnswer: true });
}

function setStatusText(text, busy) {
  $('statusPill').hidden = false;
  $('statusText').textContent = text;
  $('statusPill').toggleAttribute('data-busy', !!busy);
}

function renderStatus() {
  const n = live().length;
  const left = state.queue.length + (state.running ? Math.max(0, state.total - state.done - state.queue.length) : 0);
  let bar = null;
  if (state.core === 'loading' && state.download != null && state.download < 0.995) {
    setStatusText(`${store.get('coreDownloaded', false) ? 'Loading' : 'Downloading'} models · ${Math.round(state.download * 100)}%`, true);
    bar = state.download;
  } else if (state.core === 'loading' && (state.queue.length || state.running)) {
    setStatusText('Waking up the models…', true);
  } else if (state.running || state.queue.length) {
    setStatusText(`${state.paused ? 'Paused' : 'Indexing'} · ${Math.min(state.done + 1, state.total)} of ${state.total}`, !state.paused);
    bar = state.total ? state.done / state.total : 0;
  } else if (n) {
    setStatusText(`${n.toLocaleString()} screenshot${n === 1 ? '' : 's'}`, false);
  } else if (!state.source) {
    $('statusPill').hidden = true;
  }
  $('statusPill').toggleAttribute('data-paused', state.paused && left > 0);
  $('progress').hidden = bar == null;
  if (bar != null) $('progressBar').style.width = `${Math.min(100, bar * 100)}%`;
  const eta = left && !state.paused ? ` About ${Math.max(1, Math.round((left * (state.pace === 'sloth' ? 5 : state.pace === 'sprint' ? 1.2 : 2)) / 60))} min to go at ${PACE[state.pace].label.toLowerCase()}.` : '';
  $('indexInfo').textContent = left ? `${left} waiting.${eta}` : n ? 'All caught up.' : '';
  renderModels();
}

// ---------- search ----------

function keywordIndex() {
  if (!state.index) {
    const docs = live();
    state.index = { docs, kw: new KeywordIndex(docs) };
  }
  return state.index;
}

async function queryVecs(q) {
  if (state.core !== 'ready') return null;
  if (!state.qcache.has(q)) state.qcache.set(q, call('embed-query', { q }));
  return state.qcache.get(q);
}

let searchSeq = 0;
async function runSearch({ keepAnswer = false } = {}) {
  const q = $('q').value.trim();
  const seq = ++searchSeq;
  if (!keepAnswer) hideAnswer();
  const { docs, kw } = keywordIndex();
  const filter = (s) => !state.kindFilter || s.kind === state.kindFilter;

  if (!q) {
    const recent = docs.filter(filter).sort((a, b) => b.takenAt - a.takenAt);
    state.results = recent.map((shot) => ({ shot }));
    $('resultMeta').textContent = recent.length ? `${recent.length.toLocaleString()} screenshot${recent.length === 1 ? '' : 's'}${state.kindFilter ? ` · ${KIND_BY_ID[state.kindFilter].label}` : ''}, newest first` : '';
    renderGrid(recent.slice(0, 120).map((shot) => ({ shot })), '');
    return state.results;
  }

  if (state.core === 'idle' && store.get('coreDownloaded', false)) ensureCore().then(() => { if (seq === searchSeq) runSearch({ keepAnswer: true }); }).catch(() => {});
  // Keyword results show at once; the AI re-rank replaces them a moment later.
  const pending = queryVecs(q)?.catch(() => null);
  let vecs = pending && (await Promise.race([pending, sleep(120).then(() => undefined)]));
  if (vecs === undefined) {
    if (seq !== searchSeq) return null;
    showHits(docs, rank(docs, kw, { text: q }), q, filter, { interim: true });
    vecs = await pending;
  }
  if (seq !== searchSeq) return null;
  return showHits(docs, rank(docs, kw, { text: q, txt: vecs?.txt, vis: vecs?.vis }), q, filter, { vecs });
}

function showHits(docs, ranked, q, filter, { vecs, interim = false }) {
  const top = ranked[0]?.score || 0;
  const hits = ranked
    .filter((r) => r.score > 0 && r.score >= top * 0.35 && filter(docs[r.i]))
    .slice(0, 36)
    .map((r) => ({ shot: docs[r.i], score: r.score }));
  // "Best match" only when the top result is clearly ahead of the rest.
  if (hits.length > 1 && hits[0].score > hits[1].score * 1.25) hits[0].best = true;
  if (hits.length === 1) hits[0].best = true;
  state.results = hits;
  const note = interim ? '' : vecs ? '' : ' by keyword (the AI models are still loading)';
  $('resultMeta').textContent = hits.length
    ? `${hits.length} match${hits.length === 1 ? '' : 'es'}${note}`
    : interim ? 'Looking…' : vecs ? 'Nothing matches that. Try describing what was on the screen.' : 'No keyword matches yet. The AI models are still loading.';
  renderGrid(hits, q);
  return hits;
}

// The line that says what a screenshot is about: skip app chrome ("< Notes",
// a bare app name) and prefer the first line with a few words in it.
function headline(text) {
  const ls = (text || '').split('\n').map((l) => l.trim()).filter((l) => l.length > 2 && !/^[<‹«]/.test(l));
  // OCR breaks a sentence wherever the screen wrapped it; glue those back.
  const joined = [];
  for (const l of ls) {
    const prev = joined.at(-1);
    if (prev && !/[.!?:]$/.test(prev) && /^[a-z0-9]/.test(l)) joined[joined.length - 1] = `${prev} ${l}`;
    else joined.push(l);
  }
  const best = joined.find((l) => l.split(' ').length >= 3) || joined[0] || '';
  return best.length > 140 ? `${best.slice(0, 137)}…` : best;
}

function highlight(line, q) {
  const qt = new Set(tokens(q));
  return escapeHtml(line).replace(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu, (w) => {
    const t = stem(w.toLowerCase().replace(/[^a-z0-9]/g, ''));
    return t && (qt.has(t) || [...qt].some((x) => x.length >= 3 && t.startsWith(x))) ? `<mark>${w}</mark>` : w;
  });
}

function card(shot, { q = '', best = false, small = false } = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'card';
  b.dataset.id = shot.id;
  const snip = (q && snippet(shot.text, q)) || headline(shot.text);
  b.innerHTML = `
    ${best ? '<span class="best">Best match</span>' : ''}
    <div class="thumb"><img loading="lazy" alt="" src="${thumbUrl(shot)}"></div>
    <div class="cap">
      ${small ? '' : `<span class="snip">${snip ? (q ? highlight(snip, q) : escapeHtml(snip)) : `<em>${escapeHtml(KIND_BY_ID[shot.kind]?.label || 'Screenshot')}</em>`}</span>`}
      <span class="when">${fmtWhen(shot.takenAt)}</span>
    </div>`;
  b.querySelector('img').alt = shot.text ? `Screenshot: ${shot.text.slice(0, 80)}` : 'Screenshot';
  b.addEventListener('click', () => openDetail(shot.id));
  return b;
}

function renderGrid(items, q) {
  const grid = $('grid');
  grid.replaceChildren(...items.map((it) => card(it.shot, { q, best: it.best })));
  const empty = !items.length;
  $('emptyGrid').hidden = !empty || !!q;
  if (empty && !q) {
    $('emptyGrid').textContent = state.queue.length || state.running
      ? 'Your first screenshots will appear here as Hoard reads them.'
      : state.kindFilter ? 'None of this kind.' : 'No screenshots yet.';
  }
}

function renderKinds() {
  const counts = {};
  for (const s of live()) counts[s.kind] = (counts[s.kind] || 0) + 1;
  const wrap = $('kinds');
  const all = document.createElement('button');
  all.className = 'chip';
  all.type = 'button';
  all.textContent = 'All';
  all.setAttribute('aria-pressed', String(!state.kindFilter));
  all.addEventListener('click', () => { state.kindFilter = null; renderKinds(); runSearch({ keepAnswer: true }); });
  const chips = KINDS.filter((k) => counts[k.id]).map((k) => {
    const c = document.createElement('button');
    c.className = 'chip';
    c.type = 'button';
    c.innerHTML = `${escapeHtml(k.label)}<b>${counts[k.id]}</b>`;
    c.setAttribute('aria-pressed', String(state.kindFilter === k.id));
    c.addEventListener('click', () => {
      state.kindFilter = state.kindFilter === k.id ? null : k.id;
      renderKinds();
      runSearch({ keepAnswer: true });
    });
    return c;
  });
  wrap.replaceChildren(...(chips.length > 1 ? [all, ...chips] : []));
}

// ---------- ask (Gemma) ----------

function hideAnswer() {
  $('answer').hidden = true;
  stopGeneration();
}

async function ask() {
  const q = $('q').value.trim();
  if (!q) { $('q').focus(); return; }
  const box = $('answer');
  box.hidden = false;
  const hits = (await runSearch({ keepAnswer: true })) || [];
  if (!hits.length) {
    box.innerHTML = '<p class="who">Hoard</p><p class="text">Nothing in your screenshots matches that yet.</p>';
    return;
  }
  if (state.llm !== 'ready' && !store.get('llmDownloaded', false)) {
    box.innerHTML = `<p class="who">Ask with Gemma</p>
      <p class="text">Ask answers in one sentence, using the screenshots that match best. It needs Gemma 3, an open model from Google that runs on your device (${llmDevice() === 'webgpu' ? 'about 790 MB' : 'about 590 MB'}, downloaded once).</p>
      <div class="refs"><button class="btn primary small" type="button" id="getGemma" style="width:auto;height:auto;padding:8px 14px">Download Gemma and answer</button></div>`;
    $('getGemma').addEventListener('click', () => ask2(q, hits), { once: true });
    return;
  }
  ask2(q, hits);
}

async function ask2(q, hits) {
  const box = $('answer');
  box.innerHTML = '<p class="who">Gemma is reading your screenshots…</p><p class="text cursor"></p><div class="refs"></div>';
  const text = box.querySelector('.text');
  try {
    await ensureLlm();
  } catch (err) {
    text.classList.remove('cursor');
    text.textContent = `Gemma couldn't load: ${err.message}`;
    return;
  }
  // A 1B model gets confused by distractors, so it only sees the screenshots
  // that scored close to the best one (at most three), labelled with their kind.
  // Measured on the sample pile: 6 right answers out of 8 instead of 5, no
  // invented details, and a median of 8 s per answer instead of 13 s.
  const withText = hits.filter((h) => h.shot.text);
  const top = withText.filter((h, i) => i < 3 && h.score >= (withText[0]?.score || 0) * 0.7);
  const context = top.map((h, i) => `Screenshot ${i + 1} (${(KIND_BY_ID[h.shot.kind]?.label || 'screenshot').toLowerCase()}, ${fmtDate(h.shot.takenAt)}):\n${h.shot.text.slice(0, 600)}`).join('\n\n');
  const messages = [{
    role: 'user',
    content: `Here is the text from ${top.length === 1 ? 'a screenshot' : 'my screenshots, most likely match first'}:\n\n${context}\n\nQuestion: ${q}\n\nAnswer in one short sentence, copying the exact detail (number, code, time, place or name) from the text. Do not guess. If the text does not answer it, say: I couldn't find that in your screenshots.`,
  }];
  box.querySelector('.who').textContent = `Gemma 3 ${state.llmDevice === 'webgpu' ? '1B' : '270M'} · on this device · check it against the screenshot`;
  let out = '';
  const tidy = (s) => s.replace(/,?\s*(as (shown|stated|seen) |found )?in (screenshot )?\[?\d*\]?\.?$/i, '.').replace(/\s*\[\d\]/g, '').replace(/\.\.$/, '.').trim();
  try {
    const res = await call('generate', { messages, maxTokens: 70, device: state.llmDevice }, (chunk) => {
      out += chunk;
      text.textContent = tidy(out);
    });
    out = res.text;
  } catch (err) {
    out = `Something went wrong: ${err.message}`;
  }
  text.classList.remove('cursor');
  text.textContent = tidy(out);
  const refs = box.querySelector('.refs');
  const show = top.length ? top : hits.slice(0, 3);
  refs.replaceChildren(...show.map((h) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = 'Open this screenshot';
    b.innerHTML = `<img alt="" src="${thumbUrl(h.shot)}">`;
    b.addEventListener('click', () => openDetail(h.shot.id));
    return b;
  }));
}

// ---------- sweep ----------

function renderSweep() {
  const { groups, dupOf } = state.sweep;
  const total = Object.values(groups).reduce((a, g) => a + g.length, 0);
  $('sweepCount').hidden = !total;
  $('sweepCount').textContent = total;
  $('sweepTitle').textContent = total ? `${total} screenshot${total === 1 ? '' : 's'} you can let go of` : state.running || state.queue.length ? 'Still reading your screenshots…' : 'Nothing to sweep. Tidy!';
  const where = state.source?.type === 'folder'
    ? `Sweeping moves them into a "${SWEPT_DIR}" folder inside ${state.source.name}. Nothing is deleted: empty that folder yourself once you're sure.`
    : state.source?.type === 'sample'
      ? 'This is the sample pile, so sweeping only hides them here.'
      : "This browser can't move files, so sweeping hides them from Hoard and gives you their names to delete yourself.";
  $('sweepLede').textContent = total ? where : '';

  const wrap = $('sweepGroups');
  wrap.replaceChildren();
  for (const [rule, ids] of Object.entries(groups)) {
    if (!ids.length) continue;
    const g = document.createElement('section');
    g.className = 'group';
    g.innerHTML = `<div class="group-head"><div><h3>${RULES[rule].title} · ${ids.length}</h3><p>${RULES[rule].why}</p></div><button class="btn small warn solid" type="button">Sweep ${ids.length}</button></div><div class="grid"></div>`;
    const grid = g.querySelector('.grid');
    const btn = g.querySelector('button');
    for (const id of ids) {
      const shot = state.byId.get(id);
      const lab = document.createElement('label');
      lab.className = 'pick';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = true;
      box.value = id;
      box.setAttribute('aria-label', `Include ${shot.name}`);
      const c = card(shot, { small: true });
      if (rule === 'duplicate' && dupOf[id]) c.querySelector('.when').textContent = `Copy of ${fmtWhen(state.byId.get(dupOf[id]).takenAt)}`;
      // The card opens the screenshot; the checkbox decides what gets swept.
      lab.append(box, c);
      grid.append(lab);
    }
    grid.addEventListener('change', () => {
      const n = grid.querySelectorAll('input:checked').length;
      btn.textContent = `Sweep ${n}`;
      btn.disabled = !n;
    });
    btn.addEventListener('click', () => sweep([...grid.querySelectorAll('input:checked')].map((i) => i.value)));
    wrap.append(g);
  }

  const swept = state.shots.filter((s) => s.swept);
  $('sweptBox').hidden = !swept.length;
  $('sweptSummary').textContent = `Already swept · ${swept.length}`;
  $('sweptWhere').textContent = state.source?.type === 'folder' ? `They're in the "${SWEPT_DIR}" folder. Open one to put it back.` : 'Open one to put it back.';
  $('sweptGrid').replaceChildren(...swept.sort((a, b) => b.sweptAt - a.sweptAt).map((s) => card(s, { small: true })));
}

async function moveTo(srcDir, name, dstDir, newName) {
  const handle = await srcDir.getFileHandle(name);
  if (handle.move) {
    try { await handle.move(dstDir, newName); return; } catch { /* fall back to copy + remove */ }
  }
  const file = await handle.getFile();
  const out = await (await dstDir.getFileHandle(newName, { create: true })).createWritable();
  await out.write(file);
  await out.close();
  await srcDir.removeEntry(name);
}

async function freeName(dir, name) {
  const dot = name.lastIndexOf('.');
  const [stemPart, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? name : `${stemPart} (${i})${ext}`;
    try { await dir.getFileHandle(candidate); } catch { return candidate; }
  }
}

async function sweep(ids, { quiet = false } = {}) {
  if (!ids.length) return;
  const shots = ids.map((id) => state.byId.get(id)).filter(Boolean);
  let failed = 0;
  if (state.source?.type === 'folder') {
    if (!(await permission(state.source.handle, true))) { toast('Hoard needs permission to move files in that folder.'); return; }
    const dst = await state.source.handle.getDirectoryHandle(SWEPT_DIR, { create: true });
    for (const s of shots) {
      try {
        const { dir, name } = await resolvePath(s.path);
        s.sweptName = await freeName(dst, name);
        await moveTo(dir, name, dst, s.sweptName);
      } catch (err) {
        console.warn('Could not sweep', s.path, err);
        failed++;
        continue;
      }
      s.swept = true;
      s.sweptAt = Date.now();
    }
  } else {
    for (const s of shots) { s.swept = true; s.sweptAt = Date.now(); }
  }
  const done = shots.filter((s) => s.swept);
  await db.putShots(done);
  state.index = null;
  refresh();
  if (quiet) return;
  if (state.source?.type === 'files' && done.length) {
    const names = done.map((s) => s.path).join('\n');
    toast(`Hid ${done.length}. Copy their names to delete them yourself?`, 'Copy names', () => navigator.clipboard.writeText(names).then(() => toast('Names copied.')));
  } else {
    toast(`Swept ${done.length} screenshot${done.length === 1 ? '' : 's'}${failed ? ` (${failed} couldn't be moved)` : ''}.`, 'Undo', () => unsweep(done.map((s) => s.id)));
  }
}

async function unsweep(ids) {
  const shots = ids.map((id) => state.byId.get(id)).filter((s) => s?.swept);
  if (state.source?.type === 'folder') {
    if (!(await permission(state.source.handle, true))) return;
    const src = await state.source.handle.getDirectoryHandle(SWEPT_DIR, { create: true });
    for (const s of shots) {
      try {
        const parts = s.path.split('/');
        let dir = state.source.handle;
        for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
        await moveTo(src, s.sweptName, dir, await freeName(dir, parts.at(-1)));
      } catch (err) {
        console.warn('Could not restore', s.path, err);
        continue;
      }
      s.swept = false;
    }
  } else {
    for (const s of shots) s.swept = false;
  }
  for (const s of shots) if (!s.swept) { delete s.sweptName; delete s.sweptAt; }
  await db.putShots(shots);
  state.index = null;
  refresh();
  toast(`Put back ${shots.filter((s) => !s.swept).length}.`);
}

// ---------- detail ----------

let detailUrl = null;
async function openDetail(id) {
  const shot = state.byId.get(id);
  if (!shot) return;
  state.detail = id;
  $('detail').hidden = false;
  document.body.style.overflow = 'hidden';
  $('detailImg').src = thumbUrl(shot);
  $('detailImg').alt = shot.text ? `Screenshot: ${shot.text.slice(0, 120)}` : 'Screenshot';
  $('detailKind').textContent = KIND_BY_ID[shot.kind]?.label || 'Screenshot';
  $('detailTitle').textContent = headline(shot.text) || shot.name;
  $('detailMeta').textContent = `${fmtDate(shot.takenAt, true)} · ${shot.w}×${shot.h} · ${shot.path}`;
  $('detailText').textContent = shot.text || '(No text on this one.)';
  $('keepBtn').textContent = shot.kept ? 'Kept forever ✓' : 'Keep forever';
  $('keepBtn').title = 'Never suggest this one in Sweep';
  $('sweepOne').textContent = shot.swept ? 'Put back' : 'Sweep';
  $('copyText').disabled = !shot.text;
  setTimeout(() => $('detail').querySelector('.close').focus(), 0);
  try {
    const file = await original(shot);
    if (state.detail !== id || !file) return;
    if (detailUrl) URL.revokeObjectURL(detailUrl);
    detailUrl = URL.createObjectURL(file);
    $('detailImg').src = detailUrl;
    $('openOriginal').disabled = false;
  } catch {
    $('openOriginal').disabled = true;
  }
}

function closeDetail() {
  $('detail').hidden = true;
  document.body.style.overflow = '';
  const id = state.detail;
  state.detail = null;
  document.querySelector(`.card[data-id="${CSS.escape(id || '')}"]`)?.focus();
}

// ---------- UI ----------

function showApp() {
  $('welcome').hidden = true;
  $('app').hidden = false;
}

function showWelcome() {
  $('welcome').hidden = false;
  $('app').hidden = true;
  if (!window.showDirectoryPicker) {
    $('pickNote').textContent = "Your browser can read a folder but can't move files, so Sweep will give you a list instead. Chrome or Edge can do both. The first run downloads about 250 MB of models, once.";
  }
}

function selectTab(name) {
  for (const b of document.querySelectorAll('.tabs [role=tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  $('tab-search').hidden = name !== 'search';
  $('tab-sweep').hidden = name !== 'sweep';
}

let toastTimer;
function toast(msg, action, fn) {
  $('toastText').textContent = msg;
  const a = $('toastAction');
  a.hidden = !action;
  if (action) {
    a.textContent = action;
    a.onclick = () => { $('toast').hidden = true; fn(); };
  }
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, action ? 7000 : 3500);
}

function renderSource() {
  const s = state.source;
  $('sourceInfo').textContent = !s ? 'No folder chosen yet.'
    : s.type === 'folder' ? `Folder: ${s.name}. Hoard checks it for new screenshots each time you open the app.`
      : s.type === 'sample' ? 'The sample pile: 40 made-up screenshots.'
        : `Files from ${s.name} (read-only; pick it again next time to catch new ones).`;
  $('rescanBtn').hidden = s?.type !== 'folder';
}

function wireUI() {
  $('pickFolder').addEventListener('click', pickFolder);
  $('changeFolder').addEventListener('click', () => { $('settings').close(); pickFolder(); });
  $('trySample').addEventListener('click', useSample);
  $('filesInput').addEventListener('change', (e) => useFiles(e.target.files));
  $('reconnectBtn').addEventListener('click', scanFolder);
  $('rescanBtn').addEventListener('click', () => { $('settings').close(); scanFolder(); });

  let t;
  $('q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => runSearch(), 180); });
  $('searchForm').addEventListener('submit', (e) => { e.preventDefault(); ask(); });
  $('examples').replaceChildren(
    Object.assign(document.createElement('span'), { textContent: 'Try:' }),
    ...EXAMPLES.map((ex) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = ex;
      b.addEventListener('click', () => {
        $('q').value = ex.replace(/\?$/, '');
        if (ex.endsWith('?')) { $('q').value = ex; ask(); } else runSearch();
      });
      return b;
    }),
  );

  for (const b of document.querySelectorAll('.tabs [role=tab]')) b.addEventListener('click', () => selectTab(b.dataset.tab));

  $('detail').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeDetail(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('detail').hidden) closeDetail();
    if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && !$('app').hidden) { e.preventDefault(); selectTab('search'); $('q').focus(); }
  });
  $('copyText').addEventListener('click', async () => {
    const s = state.byId.get(state.detail);
    try { await navigator.clipboard.writeText(s.text); toast('Text copied.'); } catch { toast("Couldn't copy. Select the text instead."); }
  });
  $('openOriginal').addEventListener('click', () => { if (detailUrl) window.open(detailUrl, '_blank', 'noopener'); });
  $('keepBtn').addEventListener('click', async () => {
    const s = state.byId.get(state.detail);
    s.kept = !s.kept;
    await db.putShot(s);
    $('keepBtn').textContent = s.kept ? 'Kept forever ✓' : 'Keep forever';
    refresh();
  });
  $('sweepOne').addEventListener('click', async () => {
    const id = state.detail;
    const s = state.byId.get(id);
    closeDetail();
    if (s.swept) await unsweep([id]); else await sweep([id]);
  });

  $('settingsBtn').addEventListener('click', () => { renderSource(); renderStatus(); $('settings').showModal(); });
  $('statusPill').addEventListener('click', () => { renderSource(); renderStatus(); $('settings').showModal(); });
  for (const r of document.querySelectorAll('input[name=pace]')) {
    r.checked = r.value === state.pace;
    r.addEventListener('change', () => { state.pace = r.value; store.set('pace', r.value); renderStatus(); });
  }
  $('pauseBtn').addEventListener('click', () => setPaused(!state.paused));
  $('loadLlm').addEventListener('click', () => ensureLlm().catch(() => {}));
  $('forgetBtn').addEventListener('click', async () => {
    if (!confirm('Forget the whole index on this device? Your screenshots are not touched.')) return;
    await db.clearShots();
    await db.delKV('source');
    location.reload();
  });
  $('clearModels').addEventListener('click', async () => {
    if (!confirm('Delete the downloaded models? Hoard will download them again next time it needs them.')) return;
    await call('clear-models');
    store.set('coreDownloaded', false);
    store.set('llmDownloaded', false);
    toast('Models deleted.');
  });

  addEventListener('scroll', () => document.querySelector('.top').classList.toggle('scrolled', scrollY > 4), { passive: true });
}

// ---------- formatting ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(t, withTime = false) {
  const d = new Date(t);
  const opts = { day: 'numeric', month: 'short', year: 'numeric' };
  if (withTime) Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString(undefined, opts);
}

function fmtWhen(t) {
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days < 1) return 'Today';
  if (days < 2) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  const d = new Date(t);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }) });
}

// ---------- start ----------

async function init() {
  if (import.meta.env.DEV) {
    window.__hoard = state;
    window.__hoardApi = { switchSource, scanFolder, sweep, unsweep, original };
  }
  startWorker();
  wireUI();
  if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('./sw.js').catch(() => {});

  const all = await db.allShots().catch(() => []);
  const stale = all.filter((s) => s.v !== PIPELINE).map((s) => s.id);
  if (stale.length) await db.deleteShots(stale);
  for (const s of all) if (s.v === PIPELINE) addShot(s);
  state.source = (await db.getKV('source').catch(() => null)) || null;

  if (!state.source && !state.shots.length) {
    showWelcome();
    return;
  }
  showApp();
  refresh();
  if (state.source?.type === 'folder') {
    $('reconnectName').textContent = state.source.name;
    if (await permission(state.source.handle, false).catch(() => false)) scanFolder();
    else $('reconnect').hidden = false;
  }
  // Warm the models from disk so the first search is a smart one.
  if (store.get('coreDownloaded', false)) ensureCore().then(() => runSearch({ keepAnswer: true })).catch(() => {});
}

init();
