import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

/**
 * The tests of everything the server registers, run on the database the server really has: the account, session, vault and sealed-share
 * tables and no table for a record (SECURITY.md **M-37**). `npm run test:accounts`. The rest of the suite tests the route files the device
 * runs, over the full schema; this run is what keeps the two from drifting apart. The core's own accounts tests are `npm run test:accounts` in core/.
 */
export default mergeConfig(base, defineConfig({
  test: {
    setupFiles: ['../core/src/testing/use-accounts-store.ts'],
    include: [
      'accounts', 'auth', 'sessions', 'second-factor', 'totp', 'passkeys', 'vault', 'relay-routes', 'shared', 'share-shell', 'own-account',
      'backup', 'cli', 'config', 'mail',
    ].map(name => `src/__tests__/${name}.test.ts`),
  },
}));
