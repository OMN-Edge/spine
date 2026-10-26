import { defineConfig } from 'vitest/config';
import { coreAliases, corePlugins } from './vite.core.shared.mjs';

/** The core's own tests, built the way the browser's is (Node's modules and native tools swapped), but run in Node. */
export default defineConfig({
  // Node's own modules are resolved before plugins see them, so here the swaps are plain aliases.
  plugins: corePlugins({ inNode: true }).slice(1),
  resolve: { alias: coreAliases },
  test: { include: ['src/core/**/*.test.ts'], exclude: ['src/core/llm.test.ts', '**/node_modules/**'], server: { deps: { inline: [/sqlite-wasm/] } } },
});
