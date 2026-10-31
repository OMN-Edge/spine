/**
 * A copy, on this device, of the sealed objects the vault holds, so that opening the records again fetches what changed and not everything
 * (docs/crypto-design.md, "Keeping a copy on the device"; SECURITY.md M-43).
 *
 * What is kept is exactly what the server holds: the sealed body and the key it is sealed under, which only the account's keys can open.
 * Nothing in it is readable without the master password, so it is no weaker than the server's own copy; what it adds is that a person
 * with this browser's storage can see how many objects there are and how large. It is cleared at sign-out.
 *
 * It is a cache and never the truth: every method is best effort, a failure (a full disk, a private window, a browser that removed the
 * storage) is a miss, and the app works with none. Only objects that are written once (a segment, a snapshot part, a file) are kept: the
 * index is read from the server every time, so a copy can never be stale. A copy that does not open is dropped and fetched again.
 */
export interface SealedObject { body: Uint8Array; wrappedKey: string; seq: number; profileId: string }

export interface SealedCache {
  get(id: string): Promise<SealedObject | null>;
  put(id: string, object: SealedObject): Promise<void>;
  forget(id: string): Promise<void>;
  /** Drops what the vault no longer lists (objects another device removed, or this one). */
  keepOnly(ids: Set<string>): Promise<void>;
}

const DATABASE = 'spine-sealed';
const OBJECTS = 'objects';
const META = 'meta';
/** About how much one account keeps; the least recently used go first. */
const MAX_BYTES = 300 * 1024 * 1024;
/** What a stored object costs besides its body (key, wrapped key, bookkeeping), for the count. */
const OVERHEAD = 256;

const settle = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
const finished = (tx: IDBTransaction): Promise<void> => new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });

interface Stored { body: ArrayBuffer; wrappedKey: string; seq: number; profileId: string }
interface Meta { size: number; used: number }

class IdbSealedCache implements SealedCache {
  private total = 0;
  private broken = false;
  private touched = new Set<string>();
  private flushing: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly db: IDBDatabase, private readonly scope: string, private readonly max: number) {}

  private key(id: string) { return `${this.scope}\u0000${id}`; }
  private range() { return IDBKeyRange.bound(`${this.scope}\u0000`, `${this.scope}\u0000￿`); }

  /** Counts what is already kept for this account. */
  async init(): Promise<void> {
    const tx = this.db.transaction(META, 'readonly');
    const cursor = tx.objectStore(META).openCursor(this.range());
    await new Promise<void>((resolve, reject) => {
      cursor.onsuccess = () => { const at = cursor.result; if (!at) return resolve(); this.total += (at.value as Meta).size; at.continue(); };
      cursor.onerror = () => reject(cursor.error);
    });
  }

  /** A failure turns the cache off for this visit, once, in words; the vault is read as if there were none. */
  private fail(err: unknown): void {
    if (!this.broken) console.debug('[core] the local copy of sealed objects is off for this visit:', (err as Error)?.message ?? String(err));
    this.broken = true;
  }

  async get(id: string): Promise<SealedObject | null> {
    if (this.broken) return null;
    try {
      const tx = this.db.transaction(OBJECTS, 'readonly');
      const found = (await settle(tx.objectStore(OBJECTS).get(this.key(id)))) as Stored | undefined;
      if (!found) return null;
      this.touched.add(id);
      this.flushSoon();
      return { body: new Uint8Array(found.body), wrappedKey: found.wrappedKey, seq: found.seq, profileId: found.profileId };
    } catch (err) { this.fail(err); return null; }
  }

  /** Remembers which objects were used, in one write a moment later, so that reading a hundred is not a hundred writes. */
  private flushSoon(): void {
    if (this.flushing) return;
    this.flushing = setTimeout(() => {
      this.flushing = null;
      const ids = [...this.touched];
      this.touched.clear();
      try {
        const tx = this.db.transaction(META, 'readwrite');
        const done = finished(tx);
        const store = tx.objectStore(META);
        const now = Date.now();
        for (const id of ids) {
          const read = store.get(this.key(id));
          read.onsuccess = () => { if (read.result) store.put({ ...(read.result as Meta), used: now }, this.key(id)); };
        }
        done.catch(err => this.fail(err));
      } catch (err) { this.fail(err); }
    }, 2000);
  }

  // The reads and writes of a transaction are chained by callbacks, never by `await`: a transaction ends when nothing is waiting on it, and
  // a browser that runs promise callbacks after that (Safari did) would find it closed.
  async put(id: string, object: SealedObject): Promise<void> {
    if (this.broken) return;
    try {
      const size = object.body.length + OVERHEAD;
      if (size > this.max / 4) return; // one file that would crowd out the rest is not kept
      const body = object.body.buffer.slice(object.body.byteOffset, object.body.byteOffset + object.body.byteLength) as ArrayBuffer;
      const tx = this.db.transaction([OBJECTS, META], 'readwrite');
      const done = finished(tx);
      const meta = tx.objectStore(META);
      let before = 0;
      const read = meta.get(this.key(id));
      read.onsuccess = () => {
        before = (read.result as Meta | undefined)?.size ?? 0;
        tx.objectStore(OBJECTS).put({ body, wrappedKey: object.wrappedKey, seq: object.seq, profileId: object.profileId } satisfies Stored, this.key(id));
        meta.put({ size, used: Date.now() } satisfies Meta, this.key(id));
      };
      await done;
      this.total += size - before;
      if (this.total > this.max) await this.trim();
    } catch (err) { this.fail(err); }
  }

  /** Lets the least recently used go until about nine tenths of the allowance is used. */
  private async trim(): Promise<void> {
    const tx = this.db.transaction([OBJECTS, META], 'readwrite');
    const done = finished(tx);
    const meta = tx.objectStore(META);
    const objects = tx.objectStore(OBJECTS);
    const prefix = `${this.scope}\u0000`;
    const cursor = meta.index('used').openCursor();
    let total = this.total;
    cursor.onsuccess = () => {
      const at = cursor.result;
      if (!at || total <= this.max * 0.9) return;
      const key = String(at.primaryKey);
      if (key.startsWith(prefix)) { total -= (at.value as Meta).size; objects.delete(key); at.delete(); }
      at.continue();
    };
    await done;
    this.total = total;
  }

  async forget(id: string): Promise<void> {
    if (this.broken) return;
    try {
      const tx = this.db.transaction([OBJECTS, META], 'readwrite');
      const done = finished(tx);
      const meta = tx.objectStore(META);
      let before = 0;
      const read = meta.get(this.key(id));
      read.onsuccess = () => {
        before = (read.result as Meta | undefined)?.size ?? 0;
        tx.objectStore(OBJECTS).delete(this.key(id));
        meta.delete(this.key(id));
      };
      await done;
      this.total -= before;
    } catch (err) { this.fail(err); }
  }

  async keepOnly(ids: Set<string>): Promise<void> {
    if (this.broken) return;
    try {
      const tx = this.db.transaction([OBJECTS, META], 'readwrite');
      const done = finished(tx);
      const meta = tx.objectStore(META);
      const objects = tx.objectStore(OBJECTS);
      const prefix = `${this.scope}\u0000`;
      const cursor = meta.openCursor(this.range());
      let freed = 0;
      cursor.onsuccess = () => {
        const at = cursor.result;
        if (!at) return;
        const key = String(at.primaryKey);
        if (!ids.has(key.slice(prefix.length))) { freed += (at.value as Meta).size; objects.delete(key); at.delete(); }
        at.continue();
      };
      await done;
      this.total -= freed;
    } catch (err) { this.fail(err); }
  }
}

/** The copy kept for one account, or null where the browser has no storage to keep it in. */
export async function openSealedCache(scope: string, max = MAX_BYTES): Promise<SealedCache | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    // A phone gives a site little room: never take more than a tenth of what the browser says this site may use.
    const quota = (await navigator.storage?.estimate?.().catch(() => undefined))?.quota;
    if (quota) max = Math.min(max, Math.floor(quota / 10));
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(DATABASE, 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore(OBJECTS);
        open.result.createObjectStore(META).createIndex('used', 'used');
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error('the storage is in use by an older version of the page'));
    });
    const cache = new IdbSealedCache(db, scope, max);
    await cache.init();
    return cache;
  } catch (err) {
    console.debug('[core] no local copy of sealed objects:', (err as Error)?.message ?? String(err));
    return null;
  }
}

/** Removes every account's copy from this browser: what signing out does. Never fails; a copy that cannot be removed is ciphertext. */
export async function clearSealedCache(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>(resolve => {
    try {
      const request = indexedDB.deleteDatabase(DATABASE);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch { resolve(); }
  });
}
