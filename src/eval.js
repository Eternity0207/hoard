// Dev-only eval (open /eval.html with `npm run dev`). Runs the real pipeline
// on the sample hoard and measures what each part contributes:
//   - search: hit@1, hit@3 and MRR@5 for each signal alone and combined,
//     on the tuning queries and on held-out queries never used for tuning
//   - kinds: how often the screenshot type is right
//   - sweep: precision and recall against the hand-labelled truth
// The indexed sample is cached in IndexedDB (add ?fresh to rebuild), and the
// data is left on window.__data for experiments in the console.

import { makeSampleHoard, SAMPLE_QUERIES, HELDOUT_QUERIES } from './sample.js';
import { prepare, ocr, ocrPool } from './analyze.js';
import { startWorker, load, call } from './client.js';
import { kindPrompts, averageKinds, classify } from './kinds.js';
import { KeywordIndex, rank, DEFAULT_WEIGHTS } from './search.js';
import { suggest } from './sweep.js';

const out = document.getElementById('out');
const log = (s) => { out.textContent += s + '\n'; };
const params = new URLSearchParams(location.search);
const CACHE_KEY = 'eval-v2';

const idb = () => new Promise((res, rej) => {
  const r = indexedDB.open('hoard-eval', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function cacheGet(k) {
  const db = await idb();
  return new Promise((res) => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
}
async function cachePut(k, v) {
  const db = await idb();
  return new Promise((res) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = res; });
}

async function index() {
  const t0 = performance.now();
  const sample = await makeSampleHoard();
  log(`Drew ${sample.length} screenshots in ${Math.round(performance.now() - t0)} ms`);
  const strip = document.getElementById('strip');
  for (const s of sample) {
    const im = document.createElement('img');
    im.src = URL.createObjectURL(s.file);
    im.title = s.id;
    strip.append(im);
  }
  if (params.has('draw')) return null;
  await Promise.all([load('core'), ocrPool(2)]);
  log(`Models ready after ${Math.round((performance.now() - t0) / 1000)} s`);

  const shots = [];
  const timing = { prepare: 0, ocr: 0, embed: 0 };
  for (const s of sample) {
    let t = performance.now();
    const p = await prepare(s.file);
    timing.prepare += performance.now() - t;
    t = performance.now();
    const { text, conf } = await ocr(p.ocrBlob);
    timing.ocr += performance.now() - t;
    t = performance.now();
    const { img, txt } = await call('embed-shot', { blob: p.thumb, text: text.slice(0, 2000) });
    timing.embed += performance.now() - t;
    delete p.ocrBlob;
    shots.push({ id: s.id, truth: s.truth, text, conf, img, txt, ...p });
    out.textContent = out.textContent.replace(/Indexed \d+.*\n$/, '') + `Indexed ${shots.length}/${sample.length}\n`;
  }
  const n = sample.length;
  for (const k of Object.keys(timing)) timing[k] = Math.round(timing[k] / n);

  const embedQueries = async (list) => {
    const qs = [];
    for (const q of list) {
      const { vis, txt } = await call('embed-query', { q: q.q });
      const { vis: visT } = await call('embed-query', { q: q.q, visual: `a screenshot of ${q.q}` });
      qs.push({ ...q, text: q.q, vis, visT, txt, want: [].concat(q.want) });
    }
    return qs;
  };
  const rows = kindPrompts();
  const kindVecs = averageKinds(rows, await call('siglip-text', { texts: rows.map((r) => r.p) }));
  const data = { shots, queries: await embedQueries(SAMPLE_QUERIES), heldout: await embedQueries(HELDOUT_QUERIES), kindVecs, timing };
  await cachePut(CACHE_KEY, data);
  return data;
}

export function evaluate(shots, queries, w, { vis = 'vis' } = {}) {
  const index = new KeywordIndex(shots);
  let h1 = 0, h3 = 0, mrr = 0;
  const misses = [];
  for (const q of queries) {
    const r = rank(shots, index, { ...q, vis: q[vis] }, w);
    const pos = r.findIndex((x) => q.want.includes(shots[x.i].id));
    if (pos === 0) h1++;
    if (pos >= 0 && pos < 3) h3++;
    if (pos >= 0 && pos < 5) mrr += 1 / (pos + 1);
    if (pos !== 0) misses.push(`${q.q} -> #${pos + 1} (top: ${shots[r[0].i].id})`);
  }
  const m = queries.length;
  return { hit1: +(h1 / m).toFixed(3), hit3: +(h3 / m).toFixed(3), mrr5: +(mrr / m).toFixed(3), misses };
}

async function run() {
  startWorker();
  let data = params.has('fresh') ? null : await cacheGet(CACHE_KEY);
  if (data) log('Using cached index (add ?fresh to rebuild)');
  else data = await index();
  if (!data) return;
  const { shots, queries, heldout, kindVecs, timing } = data;
  const n = shots.length;
  log(`Per screenshot: prepare ${timing.prepare} ms, OCR ${timing.ocr} ms, embed ${timing.embed} ms`);

  // ---- kinds ----
  for (const s of shots) Object.assign(s, (({ kind, by }) => ({ kind, kindBy: by }))(classify(s.text, s.img, kindVecs)));
  const kindRight = shots.filter((s) => s.kind === s.truth.kind).length;
  const imageOnly = shots.filter((s) => classify('', s.img, kindVecs).kind === s.truth.kind).length;
  log(`\nKinds: ${kindRight}/${n} right (image only: ${imageOnly}/${n})`);
  for (const s of shots) if (s.kind !== s.truth.kind) log(`  ${s.id}: got ${s.kind} (${s.kindBy}), want ${s.truth.kind}`);

  // ---- search ----
  const configs = {
    'keywords only': { kw: 1, sem: 0, vis: 0 },
    'meaning only (gte)': { kw: 0, sem: 1, vis: 0 },
    'picture only (SigLIP)': { kw: 0, sem: 0, vis: 1 },
    'keywords + meaning': { kw: DEFAULT_WEIGHTS.kw, sem: DEFAULT_WEIGHTS.sem, vis: 0 },
    'all three (default)': DEFAULT_WEIGHTS,
  };
  const results = {};
  log(`\nSearch, ${queries.length} tuning queries | ${heldout.length} held-out:`);
  for (const [name, w] of Object.entries(configs)) {
    const a = evaluate(shots, queries, w);
    const b = evaluate(shots, heldout, w);
    results[name] = { tune: a, heldout: b };
    log(`  ${name.padEnd(24)} hit@1 ${a.hit1}  hit@3 ${a.hit3}  MRR@5 ${a.mrr5}   |  hit@1 ${b.hit1}  hit@3 ${b.hit3}  MRR@5 ${b.mrr5}`);
  }
  log(`  misses (default, tuning):\n    ${results['all three (default)'].tune.misses.join('\n    ')}`);
  log(`  misses (default, held-out):\n    ${results['all three (default)'].heldout.misses.join('\n    ')}`);

  // ---- sweep ----
  const { groups } = suggest(shots);
  const flagged = new Map();
  for (const [rule, ids] of Object.entries(groups)) for (const id of ids) flagged.set(id, rule);
  const should = shots.filter((s) => s.truth.sweep);
  const tp = should.filter((s) => flagged.get(s.id) === s.truth.sweep).length;
  log(`\nSweep: flagged ${flagged.size}, correct ${tp}, should flag ${should.length}`);
  for (const s of shots) {
    const got = flagged.get(s.id);
    if (got !== s.truth.sweep) log(`  ${s.id}: got ${got || '-'}, want ${s.truth.sweep || '-'}`);
  }

  window.__data = data;
  window.__evaluate = evaluate;
  window.__results = results;
  log('\nDone');
}

run().catch((e) => { log('FAILED: ' + (e.stack || e)); console.error(e); });
