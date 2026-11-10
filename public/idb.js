// Minimal promise wrapper around IndexedDB: stores `items` (by id) and `meta` (by key).
let dbp;
function open() {
  return (dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('specs-app-v3', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('items', { keyPath: 'key' }); // key = <team id>|<item id>
      req.result.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}
const run = async (store, mode, fn) => {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const r = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(r?.result);
    tx.onerror = () => reject(tx.error);
  });
};
export const idb = {
  all: (store) => run(store, 'readonly', (s) => s.getAll()),
  get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
  put: (store, value, key) => run(store, 'readwrite', (s) => s.put(value, key)),
  del: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
  clear: (store) => run(store, 'readwrite', (s) => s.clear()),
};
