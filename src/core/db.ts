/** Minimal IndexedDB key-value wrapper. Everything in `records` and `blobs` is AES-GCM ciphertext. */
export type StoreName = 'meta' | 'records' | 'blobs';
const DB_NAME = 'marketing-studio';

let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        for (const s of ['meta', 'records', 'blobs']) req.result.createObjectStore(s);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const tx = d.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        let out: T;
        req.onsuccess = () => (out = req.result);
        tx.oncomplete = () => resolve(out);
        tx.onerror = tx.onabort = () => reject(tx.error ?? req.error);
      }),
  );
}

export const dbGet = <T>(store: StoreName, key: string) => run<T | undefined>(store, 'readonly', (s) => s.get(key));
export const dbPut = (store: StoreName, key: string, value: unknown) =>
  run(store, 'readwrite', (s) => s.put(value, key)).then(() => undefined);
export const dbDel = (store: StoreName, key: string) =>
  run(store, 'readwrite', (s) => s.delete(key)).then(() => undefined);
export const dbClear = (store: StoreName) => run(store, 'readwrite', (s) => s.clear()).then(() => undefined);
export const dbKeys = (store: StoreName) => run(store, 'readonly', (s) => s.getAllKeys()) as Promise<string[]>;

export async function dbEntries<T>(store: StoreName): Promise<[string, T][]> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, 'readonly');
    const s = tx.objectStore(store);
    const keys = s.getAllKeys();
    const vals = s.getAll();
    tx.oncomplete = () => resolve((keys.result as string[]).map((k, i) => [k, vals.result[i] as T]));
    tx.onerror = () => reject(tx.error);
  });
}
