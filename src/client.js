// Talks to the model worker: request/response by id, streamed tokens for
// Gemma, and download progress for the UI.

let worker;
let nextId = 1;
const pending = new Map();
const listeners = { progress: [], status: [], ready: [], loadError: [] };
const loads = {};

export const on = (event, fn) => listeners[event].push(fn);
const emit = (event, data) => listeners[event].forEach((fn) => fn(data));

export function startWorker() {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.addEventListener('message', ({ data }) => {
    switch (data.type) {
      case 'progress': emit('progress', data); break;
      case 'status': emit('status', data); break;
      case 'ready':
        loads[data.which]?.resolve(data);
        emit('ready', data);
        break;
      case 'token': pending.get(data.id)?.onToken?.(data.chunk); break;
      case 'result':
        pending.get(data.id)?.resolve(data.result);
        pending.delete(data.id);
        break;
      case 'error':
        if (data.id && pending.has(data.id)) {
          pending.get(data.id).reject(new Error(data.message));
          pending.delete(data.id);
        } else if (data.which) {
          loads[data.which]?.reject(new Error(data.message));
          delete loads[data.which];
          emit('loadError', data);
        }
        break;
    }
  });
  worker.addEventListener('error', (e) => {
    console.error('Worker error', e);
    for (const which of Object.keys(loads)) {
      loads[which].reject(new Error(e.message || 'the AI worker crashed'));
      emit('loadError', { which, message: e.message || 'the AI worker crashed' });
      delete loads[which];
    }
  });
}

// A model that fails to load can leave ONNX Runtime unable to create sessions,
// so recovering means a fresh worker. Models reload from local storage.
export function restartWorker() {
  worker?.terminate();
  for (const [, p] of pending) p.reject(new Error('restarting'));
  pending.clear();
  for (const k of Object.keys(loads)) delete loads[k];
  startWorker();
}

export function call(type, payload = {}, onToken) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onToken });
    worker.postMessage({ type, id, ...payload });
  });
}

export function load(which, payload = {}) {
  if (!loads[which]) {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    loads[which] = { promise, resolve, reject };
    worker.postMessage({ type: `load-${which}`, which, ...payload });
  }
  return loads[which].promise;
}

export const stopGeneration = () => worker?.postMessage({ type: 'stop' });
