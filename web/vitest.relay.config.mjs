import { defineConfig } from 'vitest/config';
import { coreAliases, corePlugins } from './vite.core.shared.mjs';

/**
 * The device's model client against the real relay code, in Node. Node's own fs and crypto stay (the relay signs and checks passes with
 * them); only the swaps the model path needs are made: the device's Vertex client, and the one copy of LangChain.
 */
export default defineConfig({
  plugins: corePlugins({ inNode: true }).slice(1),
  resolve: { alias: coreAliases.filter(a => /google-common|spine-core/.test(String(a.find))) },
  test: { include: ['src/core/llm.test.ts'] },
});
