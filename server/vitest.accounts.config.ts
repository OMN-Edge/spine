import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

/**
 * The tests of everything the server registers, run on the database the server really has: the account, session, vault and sealed-share
 * tables and no table for a record (SECURITY.md **M-37**). `npm run test:accounts`. The rest of the suite tests the route files the device
 * runs, over the full schema; this run is what keeps the two from drifting apart.
 */
export default mergeConfig(base, defineConfig({
  test: {
    env: { SPINE_STORE_SCOPE: 'accounts' },
    include: [
      'accounts', 'auth', 'sessions', 'second-factor', 'totp', 'passkeys', 'vault', 'relay-routes', 'shared', 'share-shell', 'own-account',
      'backup', 'cli', 'mail', 'config', 'accounts-scope',
    ].map(name => `src/__tests__/${name}.test.ts`),
  },
}));
