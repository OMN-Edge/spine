import type { Settings } from 'spine-core/config';

/**
 * The core's settings on the device: where it keeps its files and its database (both in memory), and the ones its server gave it for model
 * calls (`relay-auth.ts`, `boot-share.ts` add them). Registered with `useSettings`; nothing of it is a secret, and nothing is read from the page.
 */
export const deviceSettings: Settings = { SPINE_DB_PATH: ':memory:', DATA_DIR: '/data' };
