import { objects } from './objects/index.js';

/**
 * The ciphertext of the vault's objects, one object each under `vault/<user>/<id>` in the object store (`objects/`: files, or a bucket).
 * The server cannot read them; this module only moves bytes. An id is the client's own and reaches the store as part of a key, so it is
 * held to a safe alphabet before it is used.
 */
export const OBJECT_ID = /^[A-Za-z0-9_-]{8,64}$/;

function keyOf(userId: string, id: string): string {
  if (!OBJECT_ID.test(id)) throw new Error('invalid object id');
  return `vault/${userId}/${id}`;
}

export const writeObject = (userId: string, id: string, bytes: Buffer): Promise<void> => objects().put(keyOf(userId, id), bytes);

export const readObject = (userId: string, id: string): Promise<Buffer | null> => objects().get(keyOf(userId, id));

export const removeObject = (userId: string, id: string): Promise<void> => objects().remove(keyOf(userId, id));

export const removeAllObjects = (userId: string): Promise<void> => objects().removeAll(`vault/${userId}/`);
