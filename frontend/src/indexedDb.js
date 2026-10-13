const DB_NAME = "ms-tech-ebook-cache";
const DB_VERSION = 1;
const CACHE_STORE = "cache";
const COVER_STORE = "covers";
const READER_STORE = "readerState";
const QUEUE_STORE = "refreshQueue";

let databasePromise;

function openDatabase() {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CACHE_STORE)) db.createObjectStore(CACHE_STORE, { keyPath: "key" });
      if (!db.objectStoreNames.contains(COVER_STORE)) db.createObjectStore(COVER_STORE, { keyPath: "key" });
      if (!db.objectStoreNames.contains(READER_STORE)) db.createObjectStore(READER_STORE, { keyPath: "key" });
      if (!db.objectStoreNames.contains(QUEUE_STORE)) db.createObjectStore(QUEUE_STORE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB could not be opened."));
    request.onblocked = () => resolve(null);
  }).catch(() => null);
  return databasePromise;
}

async function runTransaction(storeName, mode, operation) {
  const db = await openDatabase();
  if (!db) return null;
  return new Promise(resolve => {
    let result = null;
    let transaction;
    try {
      transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      result = operation(store);
      transaction.oncomplete = () => resolve(result?.result ?? result ?? null);
      transaction.onerror = transaction.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function readCache(key) {
  const db = await openDatabase();
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const request = db.transaction(CACHE_STORE, "readonly").objectStore(CACHE_STORE).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

export async function writeCache(key, value) {
  const record = { key, value, updatedAt: Date.now() };
  await runTransaction(CACHE_STORE, "readwrite", store => store.put(record));
  return record;
}

export async function readCover(key) {
  const db = await openDatabase();
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const store = db.transaction(COVER_STORE, "readonly").objectStore(COVER_STORE);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

export async function writeCover(key, blob) {
  if (!(blob instanceof Blob) || !blob.size) return;
  await runTransaction(COVER_STORE, "readwrite", store => store.put({ key, blob, updatedAt: Date.now(), size: blob.size }));
  // Keep the cover cache bounded; catalog metadata and reader state are separate.
  const db = await openDatabase();
  if (!db) return;
  try {
    const records = await new Promise(resolve => {
      const request = db.transaction(COVER_STORE, "readonly").objectStore(COVER_STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => resolve([]);
    });
    if (records.length > 100) {
      records.sort((a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0));
      await runTransaction(COVER_STORE, "readwrite", store => {
        records.slice(0, records.length - 100).forEach(record => store.delete(record.key));
      });
    }
  } catch {}
}

export async function readReaderState(key) {
  const db = await openDatabase();
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const request = db.transaction(READER_STORE, "readonly").objectStore(READER_STORE).get(key);
      request.onsuccess = () => resolve(request.result?.value || null);
      request.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

export async function writeReaderState(key, value) {
  await runTransaction(READER_STORE, "readwrite", store => store.put({ key, value, updatedAt: Date.now() }));
}

export async function getQueuedRefreshes() {
  const db = await openDatabase();
  if (!db) return [];
  return new Promise(resolve => {
    try {
      const request = db.transaction(QUEUE_STORE, "readonly").objectStore(QUEUE_STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => resolve([]);
    } catch { resolve([]); }
  });
}

export async function queueRefresh(key, path, attempts = 0, retryAt = Date.now()) {
  await runTransaction(QUEUE_STORE, "readwrite", store => store.put({ key, path, attempts, retryAt, queuedAt: Date.now() }));
}

export async function removeQueuedRefresh(key) {
  await runTransaction(QUEUE_STORE, "readwrite", store => store.delete(key));
}
