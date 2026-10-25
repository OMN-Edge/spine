import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

/** The core's tests that touch accounts, run on the accounts-only database (SECURITY.md **M-37**); the server's own are in server/. */
export default mergeConfig(base, defineConfig({
  test: {
    setupFiles: ['./src/testing/use-accounts-store.ts'],
    include: ['accounts-scope'].map(name => `src/__tests__/${name}.test.ts`),
  },
}));
