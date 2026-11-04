import { objects } from './objects/index.js';

/**
 * The sealed copies a share is made of, under `shares/<id>/` in the object store: `db` and `blob-<name>` objects, a page image each (a
 * number from a version that numbered them, or a name the owner's device made from what the image is, so a copy sent again keeps the
 * images it already has). The server cannot
 * read them; this module moves bytes. The id is the owner's device's own and reaches the store as part of a key, so it is held to a safe
 * alphabet first.
 */
export const SHARE_ID = /^[A-Za-z0-9_-]{22,64}$/;

const keyOf = (id: string, name: string): string => {
  if (!SHARE_ID.test(id)) throw new Error('invalid share id');
  return `shares/${id}/${name}`;
};

/** A page image's name: what follows `blob-`. */
export const BLOB_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const blobKey = (id: string, name: string): string => {
  if (!BLOB_NAME.test(name)) throw new Error('invalid blob name');
  return keyOf(id, `blob-${name}`);
};

export const writeBundle = (id: string, bytes: Buffer): Promise<void> => objects().put(keyOf(id, 'db'), bytes);
export const writeBlob = (id: string, name: string, bytes: Buffer): Promise<void> => objects().put(blobKey(id, name), bytes);

export const readBundle = (id: string): Promise<Buffer | null> => objects().get(keyOf(id, 'db'));
export const readBlob = (id: string, name: string): Promise<Buffer | null> => objects().get(blobKey(id, name));
export const removeBlob = (id: string, name: string): Promise<void> => objects().remove(blobKey(id, name));

/** The names of the page images a share holds now. */
export const blobNames = async (id: string): Promise<string[]> => {
  const prefix = keyOf(id, 'blob-');
  return (await objects().list(prefix)).map(key => key.slice(prefix.length)).filter(name => BLOB_NAME.test(name));
};

/** The page images of an earlier publish, when the same share is published again. */
export const removeBlobs = async (id: string): Promise<void> => {
  for (const key of await objects().list(keyOf(id, 'blob-'))) await objects().remove(key);
};

export const removeShare = (id: string): Promise<void> => {
  if (!SHARE_ID.test(id)) throw new Error('invalid share id');
  return objects().removeAll(`shares/${id}/`);
};
