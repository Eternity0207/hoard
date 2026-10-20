// Copy the WASM runtimes and the OCR language data into public/ so the app
// serves everything from its own origin: it works offline and doesn't depend
// on a CDN staying up.
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pub = (p) => new URL(`../public/${p}`, import.meta.url);
const pkgDir = (name) => dirname(require.resolve(`${name}/package.json`));

// ONNX Runtime Web, for transformers.js (SigLIP, gte-small, Gemma).
const ort = join(dirname(require.resolve('@huggingface/transformers')), '..', '..', '..', 'onnxruntime-web', 'dist');
mkdirSync(pub('ort'), { recursive: true });
for (const f of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  cpSync(join(ort, f), pub(`ort/${f}`));
}

// Tesseract: the worker script, every core build (it picks one per device),
// and the LSTM English model, unzipped so no server ever re-encodes it.
mkdirSync(pub('tesseract'), { recursive: true });
cpSync(join(pkgDir('tesseract.js'), 'dist', 'worker.min.js'), pub('tesseract/worker.min.js'));
const core = pkgDir('tesseract.js-core');
for (const v of ['', '-simd', '-lstm', '-simd-lstm', '-relaxedsimd', '-relaxedsimd-lstm']) {
  cpSync(join(core, `tesseract-core${v}.wasm.js`), pub(`tesseract/tesseract-core${v}.wasm.js`));
}
const lang = pub('tesseract/eng.traineddata');
if (!existsSync(lang)) {
  const gz = readFileSync(join(pkgDir('@tesseract.js-data/eng'), '4.0.0_best_int', 'eng.traineddata.gz'));
  writeFileSync(lang, gunzipSync(gz));
}
console.log('Copied ONNX Runtime and Tesseract into public/');
