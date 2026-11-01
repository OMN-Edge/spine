import { resolveDataDir } from 'spine-core/config.js';
import { createFilesystemObjects } from './filesystem.js';
import { createGcsObjects } from './gcs.js';
import { ObjectsConfigError, type ObjectStore } from './types.js';

export { type ObjectStore } from './types.js';

/**
 * Which store holds the sealed bytes (`SPINE_OBJECTS`): `filesystem` (default; files under `DATA_DIR`) or `gcs` (a Google Cloud Storage
 * bucket, `SPINE_GCS_BUCKET`, optionally under `SPINE_GCS_PREFIX`). Adding one is a map entry and a file here, never a conditional.
 */
const ADAPTERS: Record<string, (env: NodeJS.ProcessEnv) => ObjectStore> = {
  filesystem: () => createFilesystemObjects(() => resolveDataDir()),
  gcs: env => createGcsObjects({ bucket: (env.SPINE_GCS_BUCKET ?? '').trim(), prefix: (env.SPINE_GCS_PREFIX ?? '').trim() || undefined }),
};

export const OBJECT_ADAPTERS = Object.keys(ADAPTERS);

/** The store the environment names, made; throws `ObjectsConfigError` in words when it cannot be. */
export function createObjects(env: NodeJS.ProcessEnv = process.env): ObjectStore {
  const name = env.SPINE_OBJECTS ?? 'filesystem';
  const make = ADAPTERS[name];
  if (!make) throw new ObjectsConfigError(`SPINE_OBJECTS is "${name}"; expected one of ${OBJECT_ADAPTERS.join(', ')}`);
  if (name === 'gcs' && !(env.SPINE_GCS_BUCKET ?? '').trim()) throw new ObjectsConfigError('SPINE_OBJECTS=gcs needs SPINE_GCS_BUCKET');
  return make(env);
}

let chosen: (() => ObjectStore) | null = null;
let made: ObjectStore | null = null;

/** Says which store this process uses. Every entry point that moves sealed bytes calls this first (S3): a process that did not fails at its first use. */
export function useObjects(make: (() => ObjectStore) | null): void {
  chosen = make;
  made = null;
}

export function objects(): ObjectStore {
  if (!chosen) throw new Error('no object store has been chosen for this process (useObjects)');
  return (made ??= chosen());
}
