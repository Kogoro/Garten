// Minimal promise wrapper around IndexedDB: stores `items` (by id) and `meta` (by key).
let dbp: Promise<IDBDatabase> | undefined;
function open() {
  return (dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('specs-app-v3', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('items', { keyPath: 'key' }); // key = <team id>|<item id>
      req.result.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}
const run = async <T = any>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | undefined): Promise<T> => {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const r = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(r?.result as T);
    tx.onerror = () => reject(tx.error);
  });
};
export const idb = {
  all: (store: string) => run(store, 'readonly', (s) => s.getAll()),
  get: (store: string, key: IDBValidKey) => run(store, 'readonly', (s) => s.get(key)),
  put: (store: string, value: unknown, key?: IDBValidKey) => run(store, 'readwrite', (s) => s.put(value, key)),
  del: (store: string, key: IDBValidKey) => run(store, 'readwrite', (s) => s.delete(key)),
  clear: (store: string) => run(store, 'readwrite', (s) => s.clear()),
};
