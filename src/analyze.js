// Everything Hoard learns from a screenshot without a neural network: a small
// thumbnail, a perceptual hash for spotting duplicates, how "blank" it looks,
// and when it was taken. Plus the OCR pool (Tesseract's LSTM model).

import { createScheduler, createWorker } from 'tesseract.js';

const THUMB_W = 300;

export async function prepare(file) {
  const bmp = await createImageBitmap(file);
  const { width, height } = bmp;

  // Thumbnail: shown in the grid and fed to SigLIP (which resizes to 224 px anyway).
  const tw = Math.min(THUMB_W, width);
  const th = Math.round((height / width) * tw);
  const tc = new OffscreenCanvas(tw, th);
  tc.getContext('2d').drawImage(bmp, 0, 0, tw, th);
  const thumb = await tc.convertToBlob({ type: 'image/jpeg', quality: 0.82 });

  // dHash: 9x8 greyscale, one bit per "is the next pixel brighter".
  const hc = new OffscreenCanvas(9, 8);
  const hg = hc.getContext('2d', { willReadFrequently: true });
  hg.drawImage(bmp, 0, 0, 9, 8);
  const hp = hg.getImageData(0, 0, 9, 8).data;
  let bits = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const a = lum(hp, (y * 9 + x) * 4);
      const b = lum(hp, (y * 9 + x + 1) * 4);
      bits += a > b ? '1' : '0';
    }
  }
  const dhash = BigInt('0b' + bits).toString(16).padStart(16, '0');

  // A 32x56 greyscale grid: how much is going on in the picture. A blank or
  // all-black screenshot has almost no variation and almost no edges.
  const gw = 32, gh = 56;
  const gc = new OffscreenCanvas(gw, gh);
  const gg = gc.getContext('2d', { willReadFrequently: true });
  gg.drawImage(bmp, 0, 0, gw, gh);
  const gp = gg.getImageData(0, 0, gw, gh).data;
  const L = new Float32Array(gw * gh);
  let mean = 0;
  for (let i = 0; i < L.length; i++) { L[i] = lum(gp, i * 4); mean += L[i]; }
  mean /= L.length;
  let varSum = 0, edges = 0;
  for (let i = 0; i < L.length; i++) {
    varSum += (L[i] - mean) ** 2;
    if (i % gw && Math.abs(L[i] - L[i - 1]) > 24) edges++;
  }
  const lumStd = Math.sqrt(varSum / L.length);
  const edgeFrac = edges / L.length;

  // OCR time grows with pixels. Phone screenshots (tall) have big text, so they
  // are scaled to 1100 px wide; desktop screenshots (wide) have small text, so
  // they keep up to 2000 px or the words would shrink below what Tesseract reads.
  let ocrBlob = file;
  const maxW = height > width ? 1100 : 2000;
  if (width > maxW) {
    const ow = maxW;
    const oc = new OffscreenCanvas(ow, Math.round((height / width) * ow));
    oc.getContext('2d').drawImage(bmp, 0, 0, oc.width, oc.height);
    ocrBlob = await oc.convertToBlob({ type: 'image/png' });
  }
  bmp.close();

  return { width, height, thumb, dhash, lumStd, edgeFrac, ocrBlob, takenAt: takenAt(file) };
}

const lum = (p, i) => 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];

// Screenshot apps put the time in the file name; trust it over lastModified,
// which copying and syncing often reset.
const NAME_PATTERNS = [
  /(20\d\d)[-_.]?(\d\d)[-_.]?(\d\d)[ _T-]+(?:at[ _])?(\d\d)[-_.:]?(\d\d)[-_.:]?(\d\d)?/, // Screenshot_20260312-184522, Screenshot 2026-03-12 at 18.45.22
  /(20\d\d)[-_.]?(\d\d)[-_.]?(\d\d)/,
];
export function takenAt(file) {
  for (const re of NAME_PATTERNS) {
    const m = file.name.match(re);
    if (m) {
      const [, y, mo, d, h = '12', mi = '0', s = '0'] = m;
      const t = new Date(+y, +mo - 1, +d, +h, +mi, +s || 0).getTime();
      if (!Number.isNaN(t) && +mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31) return t;
    }
  }
  return file.lastModified || Date.now();
}

export function hamming(a, b) {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

// ---------- OCR ----------

let scheduler = null;
let size = 0;

export async function ocrPool(n = 2) {
  scheduler ??= createScheduler();
  const root = new URL(import.meta.env.BASE_URL + 'tesseract/', location.href).href;
  while (size < n) {
    size++;
    const w = await createWorker('eng', 1, {
      workerPath: root + 'worker.min.js',
      corePath: root,
      langPath: root,
      gzip: false,
      workerBlobURL: false,
    });
    // tesseract.js defaults to "one block of text"; screenshots are a page of
    // scattered blocks, and automatic segmentation finds headers in coloured
    // bars (BOARDING PASS on red) that single-block mode skips.
    await w.setParameters({ tessedit_pageseg_mode: '3' });
    scheduler.addWorker(w);
  }
  return scheduler;
}

export async function ocr(blob) {
  const s = await ocrPool();
  const { data } = await s.addJob('recognize', blob);
  return { text: cleanText(data.text), conf: data.confidence };
}

export async function stopOcr() {
  await scheduler?.terminate();
  scheduler = null;
  size = 0;
}

// Drop the lines Tesseract hallucinates from icons and shapes: mostly
// punctuation, or a stray letter or two.
// The phone's status bar ("09:14 all @") is read too; it's noise at the top.
export function cleanText(raw) {
  return raw
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l, i) => {
      if (i < 2 && /^\d{1,2}[:.]\d\d\b.{0,14}$/.test(l)) return false;
      const alnum = (l.match(/[\p{L}\p{N}]/gu) || []).length;
      return alnum >= 2 && alnum / l.length > 0.5;
    })
    .join('\n');
}
