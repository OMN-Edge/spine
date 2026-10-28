/**
 * What a visitor read in the demo, kept in this browser until they have an account to put it in (SECURITY.md M-39). Keeping it is their
 * choice ("Keep them in an account"); it is the demo's own export (a Spine export zip, the sample records taken out first), restored into the
 * account through the ordinary upload, with no model call. It is held in this browser's storage, not sealed: it is the visitor's own files on
 * their own device, and it is kept for a day at most, deleted when it is added, when the visitor discards it, or when a day has passed.
 */
const DB = 'spine-demo';
const STORE = 'carry';
const KEY = 'pending';
/** How long it waits for an account. */
export const KEEP_MS = 24 * 60 * 60 * 1000;

export interface Carried { zip: Blob; files: number; at: number }

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = act(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function keepForAccount(zip: Blob, files: number): Promise<void> {
  await run('readwrite', store => store.put({ zip, files, at: Date.now() } satisfies Carried, KEY));
}

/** What is waiting, or null; one older than a day is deleted here and not offered. Storage that cannot be read gives null. */
export async function waiting(): Promise<Carried | null> {
  try {
    const found = (await run('readonly', store => store.get(KEY))) as Carried | undefined;
    if (!found) return null;
    if (Date.now() - found.at > KEEP_MS) { await discard(); return null; }
    return found;
  } catch {
    return null;
  }
}

export async function discard(): Promise<void> {
  try { await run('readwrite', store => store.delete(KEY)); } catch { /* nothing kept */ }
}
