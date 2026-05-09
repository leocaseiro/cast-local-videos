const DB_NAME = 'StreamLocalDB';
const DB_VERSION = 1;

let db = null;

export async function openDB() {
  if (db) return db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('folders')) {
        d.createObjectStore('folders', { keyPath: 'id', autoIncrement: true });
      }
      if (!d.objectStoreNames.contains('progress')) {
        d.createObjectStore('progress', { keyPath: 'key' });
      }
      if (!d.objectStoreNames.contains('thumbnails')) {
        d.createObjectStore('thumbnails', { keyPath: 'key' });
      }
      if (!d.objectStoreNames.contains('settings')) {
        d.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

async function tx(storeName, mode, fn) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const t = d.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const db_put = (store, val) => tx(store, 'readwrite', s => s.put(val));
export const db_get = (store, key) => tx(store, 'readonly', s => s.get(key));
export const db_delete = (store, key) => tx(store, 'readwrite', s => s.delete(key));

export async function db_getAll(storeName) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const t = d.transaction(storeName, 'readonly');
    const req = t.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const getSetting = async (key, defaultVal) => {
  const row = await db_get('settings', key);
  return row ? row.value : defaultVal;
};

export const setSetting = (key, value) => db_put('settings', { key, value });

export async function saveProgress(key, position, duration) {
  await db_put('progress', {
    key,
    position,
    duration,
    completed: duration > 0 && position / duration > 0.9,
    lastWatched: Date.now(),
  });
}

export const getProgress = (key) => db_get('progress', key);

export async function getRecentlyWatched(limit = 20) {
  const all = await db_getAll('progress');
  return all
    .filter(p => p.lastWatched)
    .sort((a, b) => b.lastWatched - a.lastWatched)
    .slice(0, limit);
}
