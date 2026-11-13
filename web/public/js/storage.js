// Tiny IndexedDB key/value helpers (disc files, memory card, savestates).
const DB_NAME = 'cochons-de-guerre';
const STORE = 'kv';
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const kvGet = (k) => tx('readonly', (s) => s.get(k)).catch(() => undefined);
export const kvSet = (k, v) => tx('readwrite', (s) => s.put(v, k));
export const kvDel = (k) => tx('readwrite', (s) => s.delete(k));

export function prefGet(key, def) {
  try {
    const v = localStorage.getItem('cdg.' + key);
    return v == null ? def : JSON.parse(v);
  } catch { return def; }
}

export function prefSet(key, value) {
  try { localStorage.setItem('cdg.' + key, JSON.stringify(value)); } catch { /* private mode */ }
}
