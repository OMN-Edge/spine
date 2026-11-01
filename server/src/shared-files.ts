import { objects } from './objects/index.js';

/**
 * The sealed copies a share is made of, under `shares/<id>/` in the object store: `db` and numbered `blob-N` objects. The server cannot
 * read them; this module moves bytes. The id is the owner's device's own and reaches the store as part of a key, so it is held to a safe
 * alphabet first.
 */
export const SHARE_ID = /^[A-Za-z0-9_-]{22,64}$/;

const keyOf = (id: string, name: string): string => {
  if (!SHARE_ID.test(id)) throw new Error('invalid share id');
  return `shares/${id}/${name}`;
};

export const writeBundle = (id: string, bytes: Buffer): Promise<void> => objects().put(keyOf(id, 'db'), bytes);
export const writeBlob = (id: string, n: number, bytes: Buffer): Promise<void> => objects().put(keyOf(id, `blob-${n}`), bytes);

export const readBundle = (id: string): Promise<Buffer | null> => objects().get(keyOf(id, 'db'));
export const readBlob = (id: string, n: number): Promise<Buffer | null> => objects().get(keyOf(id, `blob-${n}`));

/** The page images of an earlier publish, when the same share is published again. */
export const removeBlobs = async (id: string): Promise<void> => {
  for (const key of await objects().list(keyOf(id, 'blob-'))) await objects().remove(key);
};

export const removeShare = (id: string): Promise<void> => {
  if (!SHARE_ID.test(id)) throw new Error('invalid share id');
  return objects().removeAll(`shares/${id}/`);
};
