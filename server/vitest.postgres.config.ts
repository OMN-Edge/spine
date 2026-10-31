import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

/**
 * The tests of the accounts' routes, run on the Postgres adapter (over PGlite, Postgres in WebAssembly): `npm run test:postgres`. The same
 * list as `test:accounts` without the backup, which snapshots a SQLite file; a Postgres database is backed up by its host.
 */
export default mergeConfig(base, defineConfig({
  test: {
    setupFiles: ['../core/src/testing/use-postgres-store.ts'],
    include: [
      'accounts', 'auth', 'sessions', 'second-factor', 'totp', 'passkeys', 'vault', 'relay-routes', 'shared', 'share-shell', 'own-account',
      'cli', 'config', 'mail',
    ].map(name => `src/__tests__/${name}.test.ts`),
  },
}));
