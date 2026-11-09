import type { Freshness } from '../core/persist';

/**
 * The highest vault sequence this device has seen for a profile (SECURITY.md S-43). A number and nothing else: it says how far the vault had
 * got, not what is in it. It is not cleared at sign-out, since remembering across sign-ins is what it is for; a profile that is erased and
 * made again has a new id, so it starts from none. Best effort like the sealed copy: no storage, no mark, no check.
 */
const DATABASE = 'spine-freshness';
const MARKS = 'marks';

const settle = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });

export async function openFreshness(profileId: string): Promise<Freshness | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(DATABASE, 1);
      open.onupgradeneeded = () => { open.result.createObjectStore(MARKS); };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error('the storage is in use by an older version of the page'));
    });
    return {
      get: async () => {
        const found = await settle(db.transaction(MARKS, 'readonly').objectStore(MARKS).get(profileId));
        return typeof found === 'number' ? found : 0;
      },
      set: async seq => { await settle(db.transaction(MARKS, 'readwrite').objectStore(MARKS).put(seq, profileId)); },
    };
  } catch (err) {
    console.debug('[core] no mark of how far the vault had got:', (err as Error)?.message ?? String(err));
    return null;
  }
}
