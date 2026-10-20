// Everything Hoard knows lives in this browser's IndexedDB: one record per
// screenshot (thumbnail, OCR text, embeddings, sweep state) and a few settings,
// including the folder handle so the next visit can pick up new screenshots.

const DB = 'hoard';
const VERSION = 1;
let dbp;

function open() {
  return (dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('shots')) db.createObjectStore('shots', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((v) => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

export const allShots = () => tx('shots', 'readonly', (s) => req(s.getAll()));
export const putShot = (shot) => tx('shots', 'readwrite', (s) => { s.put(shot); });
export const putShots = (shots) => tx('shots', 'readwrite', (s) => { for (const x of shots) s.put(x); });
export const deleteShots = (ids) => tx('shots', 'readwrite', (s) => { for (const id of ids) s.delete(id); });
export const clearShots = () => tx('shots', 'readwrite', (s) => { s.clear(); });

export const getKV = (k) => tx('kv', 'readonly', (s) => req(s.get(k)));
export const setKV = (k, v) => tx('kv', 'readwrite', (s) => { s.put(v, k); });
export const delKV = (k) => tx('kv', 'readwrite', (s) => { s.delete(k); });
