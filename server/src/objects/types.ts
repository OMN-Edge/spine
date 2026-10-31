/**
 * Where the sealed bytes live: the vault's objects and the copies a share is made of. The server cannot read them (SECURITY.md **M-34**,
 * **M-36**); a store only moves bytes under keys the server builds from ids it has already checked (`vault-files.ts`, `shared-files.ts`).
 * The database holds who owns what, and sizes; this holds the ciphertext. A host that has no disk of its own (Cloud Run) uses a bucket;
 * a machine with a disk uses files. Everything is async because a bucket is.
 *
 * A key is slash-separated segments of `A-Za-z0-9_-` and a dot, never empty and never `..`; a store refuses any other, so a key that was not
 * checked cannot reach outside its root.
 */
export interface ObjectStore {
  readonly kind: string;
  /** Stores the bytes under the key, replacing any; a reader sees the old bytes or the new, never half. */
  put(key: string, bytes: Buffer): Promise<void>;
  /** The bytes, or null when there are none. A failure to reach the store throws: it is not "no such object". */
  get(key: string): Promise<Buffer | null>;
  /** Removes one object; none to remove is not an error. */
  remove(key: string): Promise<void>;
  /** The keys that start with the prefix (`dir/`, or `dir/name-` for the names in a directory that begin so), in no order. */
  list(prefix: string): Promise<string[]>;
  /** Removes everything under a prefix that ends in `/`. */
  removeAll(prefix: string): Promise<void>;
}

export const KEY = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*(\/[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*)*$/;

export function checkKey(key: string): string {
  if (!KEY.test(key)) throw new Error('invalid object key');
  return key;
}

/** A prefix is a key, a `dir/`, or the start of a name in a directory. */
export function checkPrefix(prefix: string): string {
  if (!/^[A-Za-z0-9_./-]+$/.test(prefix) || prefix.split('/').some(part => part === '..' || part === '.')) throw new Error('invalid object prefix');
  return prefix;
}

export class ObjectsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObjectsConfigError';
  }
}
