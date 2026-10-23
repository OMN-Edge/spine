import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

/**
 * The same suite with the store on the WebAssembly SQLite driver the browser uses (web/src/core/sqlite-wasm.ts), to show it behaves
 * like the native one. `npm run test:shim`. Files that open a database by path are left out: the driver is in memory by design.
 */
export default mergeConfig(base, defineConfig({
  test: {
    setupFiles: ['src/__tests__/helpers/wasm-driver.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/legacy-database.test.ts', '**/page-hiding.test.ts', '**/backup.test.ts', '**/needs-reading-column.test.ts'],
    server: { deps: { inline: [/sqlite-wasm/] } },
  },
}));
