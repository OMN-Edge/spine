import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

/**
 * Integration tests: the flows run against the real model named in `.env`, poppler, with a fresh in-memory
 * database and a temporary data directory. Not part of `npm test`, which cannot call a model (vitest.config.ts blanks the keys);
 * run with `npm run test:integration`. See docs/testing.md.
 *
 * One file at a time (the model is the slow part and a flaky one), long timeouts, and one retry: a model is not deterministic, so the
 * tests assert what must hold whatever it says (structure, safety, the facts in the input), and a retry absorbs an odd answer.
 */
export default defineConfig({
  resolve: base.resolve,
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__integration__/**/*.it.ts'],
    setupFiles: ['src/__integration__/support/env.ts', '../core/src/testing/use-records-store.ts'],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    retry: 1,
    reporters: ['verbose'],
  },
});
