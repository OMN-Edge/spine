import { defineConfig } from 'vitest/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const core = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../core/src');

export default defineConfig({
  // The tests run against the core's source, so a change there needs no build; the built server reaches the same files as `spine-core`.
  resolve: {
    alias: [
      { find: /^spine-core\/(.*)\.js$/, replacement: `${core}/$1.ts` },
      { find: /^spine-core\/(.*)$/, replacement: `${core}/$1` },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    // The tests run the routes the device runs: the first store a test opens holds records. `test:accounts` runs the server's own instead.
    setupFiles: ['../core/src/testing/use-records-store.ts', './src/__tests__/helpers/use-providers.ts'],
    // Set here, not in test files: the store captures SPINE_DB_PATH at module load,
    // and ESM hoists imports above any top-level assignment a test makes. Tests
    // that set this themselves silently wrote to the real data/spine.db.
    //
    // ANTHROPIC_API_KEY is emptied so a developer's own key can never turn a test into a
    // live model call: anything that reaches the real adapter fails to construct instead.
    // Tests that need a key set one themselves.
    env: {
      SPINE_DB_PATH: ':memory:',
      // Files the tests write go in a directory of their own, never in the repository's.
      DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'spine-test-data-')),
      ANTHROPIC_API_KEY: '',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
    },
  },
});
