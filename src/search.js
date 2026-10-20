// Hybrid search over the hoard. Three signals, each good at something the
// others miss:
//   - keywords (BM25 over the OCR text): exact things like "TP 1351" or "priya"
//   - meaning (gte-small over the OCR text): "where did I park" -> "Level 3, Bay C14"
//   - picture (SigLIP): "sunset photo", "a map", screenshots with no words at all
// The two embedding scores are turned into z-scores across the whole hoard, so
// "how unusually close is this one?" is comparable between models whose raw
// cosine ranges differ a lot.

const STOP = new Set('a an and are as at be by did do does for from had has have how i in is it its me my of on or our so that the their them then there these this those to was we were what when where which who why will with you your'.split(' '));

export function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export function tokens(s, keepStop = false) {
  return (s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/(\w)[-‐](\w)/g, '$1$2') // wi-fi -> wifi, one-time -> onetime
    .split(/[^a-z0-9]+/)
    .filter((w) => w && (keepStop || !STOP.has(w)))
    .map(stem);
}

export class KeywordIndex {
  constructor(docs) {
    this.docs = docs;
    this.tf = docs.map((d) => {
      const m = new Map();
      for (const t of tokens(d.text)) m.set(t, (m.get(t) || 0) + 1);
      return m;
    });
    this.len = this.tf.map((m) => [...m.values()].reduce((a, b) => a + b, 0));
    this.avg = this.len.reduce((a, b) => a + b, 0) / (docs.length || 1) || 1;
    this.df = new Map();
    for (const m of this.tf) for (const t of m.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    this.vocab = [...this.df.keys()];
  }

  // BM25, with the last word of the query matched as a prefix so results
  // appear while you are still typing.
  score(q) {
    const qt = [...new Set(tokens(q))];
    const N = this.docs.length;
    const out = new Float32Array(N);
    if (!qt.length) return out;
    const expand = (t, i) => (i === qt.length - 1 && t.length >= 3 ? this.vocab.filter((v) => v.startsWith(t)) : [t]);
    qt.forEach((t, i) => {
      for (const term of expand(t, i)) {
        const df = this.df.get(term);
        if (!df) continue;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        const exact = term === t ? 1 : 0.7;
        for (let d = 0; d < N; d++) {
          const f = this.tf[d].get(term);
          if (!f) continue;
          out[d] += exact * idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (this.len[d] / this.avg))));
        }
      }
    });
    return out;
  }
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function zscores(arr) {
  const vals = arr.filter((x) => x !== null);
  if (vals.length < 2) return arr.map(() => 0);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
  return arr.map((x) => (x === null ? 0 : (x - mean) / sd));
}

// Picked on the 30 tuning queries in sample.js (see eval.html); the 20
// held-out queries were only scored afterwards.
export const DEFAULT_WEIGHTS = { kw: 1, sem: 0.75, vis: 1.5 };

// docs: [{ text, txt (gte vec | null), img (SigLIP vec) }]
// q: { text, txt (gte vec), vis (SigLIP text vec) }
export function rank(docs, index, q, w = DEFAULT_WEIGHTS) {
  const kwRaw = index.score(q.text);
  const kwMax = Math.max(0, ...kwRaw);
  const sem = zscores(docs.map((d) => (d.txt && q.txt ? dot(d.txt, q.txt) : null)));
  const vis = zscores(docs.map((d) => (d.img && q.vis ? dot(d.img, q.vis) : null)));
  const rows = docs.map((d, i) => {
    const kw = kwMax > 0 ? kwRaw[i] / kwMax : 0;
    // Only "closer than usual" counts; being unusually far says nothing.
    const s = w.kw * kw + w.sem * Math.max(0, sem[i]) + w.vis * Math.max(0, vis[i]);
    return { i, score: s, kw, sem: sem[i], vis: vis[i] };
  });
  return rows.sort((a, b) => b.score - a.score);
}

// The line of OCR text that best explains why this screenshot matched, or ''
// when no word matched (it was found by meaning or by its picture).
export function snippet(text, q) {
  const ls = (text || '').split('\n').filter(Boolean);
  if (!ls.length) return '';
  const qt = new Set(tokens(q));
  let best = '', bestN = 0;
  for (const l of ls) {
    const n = tokens(l).filter((t) => qt.has(t) || [...qt].some((x) => x.length >= 3 && t.startsWith(x))).length;
    if (n > bestN) { best = l; bestN = n; }
  }
  return best.length > 120 ? best.slice(0, 117) + '…' : best;
}
