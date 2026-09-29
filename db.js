// Pharos — IndexedDB storage
// Stores: books (metadata), content (chapters + images + raw file), marks (highlights/notes/bookmarks), kv (settings)

const DB_NAME = 'pharos';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('content')) db.createObjectStore('content', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('marks')) {
        const s = db.createObjectStore('marks', { keyPath: 'id' });
        s.createIndex('book', 'bookId');
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const db = {
  get: (store, key) => tx(store, 'readonly', s => s.get(key)),
  put: (store, val, key) => tx(store, 'readwrite', s => key === undefined ? s.put(val) : s.put(val, key)),
  del: (store, key) => tx(store, 'readwrite', s => s.delete(key)),
  all: (store) => tx(store, 'readonly', s => s.getAll()),
  byBook: (bookId) => tx('marks', 'readonly', s => s.index('book').getAll(bookId)),
  async deleteBook(id) {
    const marks = await this.byBook(id);
    await open().then(d => new Promise((resolve, reject) => {
      const t = d.transaction(['books', 'content', 'marks'], 'readwrite');
      t.objectStore('books').delete(id);
      t.objectStore('content').delete(id);
      for (const m of marks) t.objectStore('marks').delete(m.id);
      t.oncomplete = resolve; t.onerror = () => reject(t.error);
    }));
  }
};

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
