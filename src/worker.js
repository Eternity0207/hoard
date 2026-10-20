// All model work happens here so the UI never freezes. Every model is open and
// runs locally in the browser:
//   - SigLIP base (Google, Apache-2.0): image and text in one shared space, so
//     "sunset photo" finds a picture with no words in it.
//   - gte-small (Alibaba, MIT): meaning-based search over the text Tesseract
//     read off each screenshot, so "where did I park" finds "Level 3, Bay C14".
//   - Gemma 3 (Google, open weights), optional: answers a question in one line
//     from the few screenshots the search found.
// After the first download they all load from disk, so the app works offline.

import {
  env,
  pipeline,
  AutoTokenizer,
  AutoProcessor,
  AutoModelForCausalLM,
  SiglipVisionModel,
  SiglipTextModel,
  RawImage,
  TextStreamer,
  InterruptableStoppingCriteria,
} from '@huggingface/transformers';
import { opfsCache, opfsAvailable, failures, clearModels } from './opfs-cache.js';

// Serve the ONNX Runtime WASM from our own origin, not a CDN.
const base = new URL(import.meta.env.BASE_URL + 'ort/', self.location.origin).href;
env.backends.onnx.wasm.wasmPaths = {
  mjs: base + 'ort-wasm-simd-threaded.asyncify.mjs',
  wasm: base + 'ort-wasm-simd-threaded.asyncify.wasm',
};
env.allowLocalModels = false;

// Model files go to the Origin Private File System when possible, otherwise
// transformers.js' Cache API default.
let storageReady = null;
const setupStorage = () => (storageReady ??= opfsAvailable().then((ok) => {
  if (ok) {
    env.useBrowserCache = false;
    env.useCustomCache = true;
    env.customCache = opfsCache;
  }
}));

const SIGLIP_ID = 'Xenova/siglip-base-patch16-224';
const GTE_ID = 'Xenova/gte-small';
const GEMMA = {
  '1b': 'onnx-community/gemma-3-1b-it-ONNX',
  '270m': 'onnx-community/gemma-3-270m-it-ONNX',
};
const EXPECTED_MB = {
  core: 100 + 112 + 34,
  '1b:q4': 880, '1b:q4f16': 785,
  '270m:fp16': 590,
};

const post = (msg) => self.postMessage(msg);

function progressReporter(which, expectedMB = 0) {
  const files = new Map();
  return (p) => {
    if (p.status !== 'progress' && p.status !== 'done') return;
    const prev = files.get(p.file) || { loaded: 0, total: 0 };
    files.set(p.file, { loaded: p.status === 'done' ? prev.total || p.loaded || 0 : p.loaded, total: p.total ?? prev.total });
    let loaded = 0, total = 0;
    for (const f of files.values()) { loaded += f.loaded || 0; total += f.total || 0; }
    post({ type: 'progress', which, loaded, total: Math.max(total, expectedMB * 1e6) });
  };
}

function normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / s;
  return out;
}

// ---------- Search models (SigLIP + gte-small) ----------

let core = null;
let coreLoading = null;

function loadCore() {
  if (core) return Promise.resolve(core);
  return (coreLoading ??= (async () => {
    await setupStorage();
    const progress_callback = progressReporter('core', EXPECTED_MB.core);
    const [processor, vision, tokenizer, textModel, gte] = await Promise.all([
      AutoProcessor.from_pretrained(SIGLIP_ID, { progress_callback }),
      SiglipVisionModel.from_pretrained(SIGLIP_ID, { dtype: 'q8', device: 'wasm', progress_callback }),
      AutoTokenizer.from_pretrained(SIGLIP_ID, { progress_callback }),
      SiglipTextModel.from_pretrained(SIGLIP_ID, { dtype: 'q8', device: 'wasm', progress_callback }),
      pipeline('feature-extraction', GTE_ID, { dtype: 'q8', device: 'wasm', progress_callback }),
    ]);
    core = { processor, vision, tokenizer, textModel, gte };
    return core;
  })().catch((err) => { coreLoading = null; throw err; }));
}

async function embedImage(blob) {
  const { processor, vision } = await loadCore();
  const image = await RawImage.fromBlob(blob);
  const inputs = await processor(image);
  const { pooler_output } = await vision(inputs);
  return normalize(pooler_output.data);
}

// SigLIP was trained on fixed-length (64 token) lowercase text.
async function siglipText(texts) {
  const { tokenizer, textModel } = await loadCore();
  const inputs = tokenizer(texts.map((t) => t.toLowerCase()), { padding: 'max_length', truncation: true });
  const { pooler_output } = await textModel(inputs);
  const [n, d] = pooler_output.dims;
  return Array.from({ length: n }, (_, i) => normalize(pooler_output.data.slice(i * d, (i + 1) * d)));
}

async function gteEmbed(texts) {
  const { gte } = await loadCore();
  const out = await gte(texts, { pooling: 'mean', normalize: true });
  const [n, d] = out.dims;
  return Array.from({ length: n }, (_, i) => out.data.slice(i * d, (i + 1) * d));
}

// ---------- Gemma (optional, for "Ask") ----------

let gemma = null;
const stopper = new InterruptableStoppingCriteria();
let genChain = Promise.resolve();

async function webgpuInfo() {
  try {
    if (!self.navigator.gpu) return null;
    const adapter = await self.navigator.gpu.requestAdapter();
    if (!adapter) return null;
    return { fp16: adapter.features.has('shader-f16') };
  } catch {
    return null;
  }
}

// GPU: Gemma 3 1B in 4-bit. CPU: ONNX Runtime Web has no CPU kernel for the
// 4/8-bit embedding op these exports use, so the 270M model runs in fp16.
// A failed session load can leave this worker unable to create sessions, so
// the UI restarts the worker to fall back rather than retrying here.
async function loadGemma(device = 'webgpu') {
  if (gemma && gemma.device === device) return gemma;
  await setupStorage();
  if (gemma) { await gemma.model.dispose?.(); gemma = null; }
  const gpu = device === 'webgpu' ? await webgpuInfo() : null;
  if (device === 'webgpu' && !gpu) throw new Error('WebGPU is not available');
  const plan = device === 'webgpu'
    ? { id: GEMMA['1b'], size: '1b', dtype: gpu.fp16 ? 'q4f16' : 'q4' }
    : { id: GEMMA['270m'], size: '270m', dtype: 'fp16' };
  const tokenizer = await AutoTokenizer.from_pretrained(plan.id);
  post({ type: 'status', which: 'llm', text: `Loading Gemma 3 ${plan.size.toUpperCase()} on ${device === 'webgpu' ? 'GPU' : 'CPU'}…` });
  const model = await AutoModelForCausalLM.from_pretrained(plan.id, {
    device, dtype: plan.dtype, progress_callback: progressReporter('llm', EXPECTED_MB[`${plan.size}:${plan.dtype}`]),
  });
  // One tiny generation so GPU driver problems show up now, not mid-answer.
  const warm = tokenizer.apply_chat_template([{ role: 'user', content: 'Hi' }], { add_generation_prompt: true, return_dict: true });
  await model.generate({ ...warm, max_new_tokens: 2, do_sample: false });
  gemma = { tokenizer, model, device, size: plan.size };
  return gemma;
}

async function generate(id, messages, maxTokens, prefill, device) {
  const { tokenizer, model } = await loadGemma(device);
  const prompt = tokenizer.apply_chat_template(messages, { add_generation_prompt: true, tokenize: false }) + (prefill || '');
  const inputs = tokenizer(prompt, { add_special_tokens: false });
  let text = '';
  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (chunk) => { text += chunk; post({ type: 'token', id, chunk }); },
  });
  stopper.reset();
  await model.generate({
    ...inputs,
    max_new_tokens: maxTokens || 120,
    do_sample: false,
    repetition_penalty: 1.1,
    streamer,
    stopping_criteria: stopper,
  });
  return { text: text.trim() };
}

// ---------- Message loop ----------

self.addEventListener('message', async ({ data }) => {
  const { type, id } = data;
  try {
    switch (type) {
      case 'load-core':
        await loadCore();
        post({ type: 'ready', which: 'core', offline: failures.length === 0 });
        break;
      case 'load-llm': {
        const g = await loadGemma(data.device);
        post({ type: 'ready', which: 'llm', device: g.device, size: g.size, offline: failures.length === 0 });
        break;
      }
      case 'embed-shot': {
        // One screenshot: its picture (SigLIP) and its text (gte-small).
        const [img, [txt]] = await Promise.all([
          embedImage(data.blob),
          data.text ? gteEmbed([data.text]) : Promise.resolve([null]),
        ]);
        post({ type: 'result', id, result: { img, txt } });
        break;
      }
      case 'embed-query': {
        const [[vis], [txt]] = await Promise.all([siglipText([data.visual || data.q]), gteEmbed([data.q])]);
        post({ type: 'result', id, result: { vis, txt } });
        break;
      }
      case 'siglip-text':
        post({ type: 'result', id, result: await siglipText(data.texts) });
        break;
      case 'generate': {
        const run = genChain.then(() => generate(id, data.messages, data.maxTokens, data.prefill, data.device));
        genChain = run.catch(() => {});
        post({ type: 'result', id, result: await run });
        break;
      }
      case 'stop':
        stopper.interrupt();
        break;
      case 'clear-models':
        await clearModels();
        await caches.delete('transformers-cache').catch(() => {});
        post({ type: 'result', id, result: true });
        break;
    }
  } catch (err) {
    console.error(err);
    post({ type: 'error', id, which: data.which, message: String(err?.message || err) });
  }
});
