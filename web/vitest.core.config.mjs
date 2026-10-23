import { defineConfig } from 'vitest/config';
import { coreAliases, corePlugins } from './vite.core.shared.mjs';

/** The core's own tests, built the way the browser's is (Node's modules and native tools swapped), but run in Node. */
export default defineConfig({
  // Node's own modules are resolved before plugins see them, so here the swaps are plain aliases (and Node keeps `child_process`, which
  // SQLite's Node build and the swapped-out files do not need from us).
  plugins: corePlugins({ inNode: true }).slice(1),
  resolve: { alias: coreAliases.filter(a => !String(a.find).includes('child_process')) },
  test: { include: ['src/core/**/*.test.ts'], server: { deps: { inline: [/sqlite-wasm/] } } },
});
