import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Writes the hashed bundle files into dist/sw.js so the service worker can
// precache them, and versions its cache by their names so updates replace it.
// (The copy of ONNX Runtime's .wasm that Vite emits is skipped: the app loads
// the one in public/ort.)
function precacheAssets() {
  return {
    name: 'precache-assets',
    apply: 'build',
    writeBundle(options, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map') && !f.endsWith('.wasm') && f !== 'index.html').sort();
      const version = createHash('sha256').update(files.join('|')).digest('hex').slice(0, 10);
      const sw = join(options.dir, 'sw.js');
      writeFileSync(sw, readFileSync(sw, 'utf8')
        .replace("const VERSION = 'dev';", `const VERSION = '${version}';`)
        .replace('const ASSETS = [];', `const ASSETS = ${JSON.stringify(files)};`));
    },
  };
}

// Cross-origin isolation unlocks SharedArrayBuffer, which ONNX Runtime needs to
// run WASM on multiple CPU threads. "credentialless" keeps CORS fetches of the
// model files from Hugging Face working.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
  base: './',
  plugins: [precacheAssets()],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  build: {
    target: 'es2022',
    // eval.html is a dev tool, so only the app itself is built.
    rollupOptions: { input: { main: 'index.html' } },
  },
  server: { headers: isolation, port: 5177, strictPort: true },
  preview: { headers: isolation },
});
