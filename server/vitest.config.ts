import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Set here, not in test files: db/index.ts captures DB_PATH at module load,
    // and ESM hoists imports above any top-level assignment a test makes. Tests
    // that set this themselves silently wrote to the real data/spine.db.
    env: {
      SPINE_DB_PATH: ':memory:',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
    },
  },
});
