import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { corePlugins, coreAssets, coreAliases, nodeModules } from './vite.core.shared.mjs';

export default defineConfig({
  // `nodeModules` is also here because its aliases are set when the config is read, which the worker's own plugin list does not do.
  plugins: [react(), coreAssets(), nodeModules()],
  // The page uses a few pure files of the shared package (the rules for syncing, the vault client's clock reading), as source.
  resolve: { alias: coreAliases.filter(a => /spine-core/.test(String(a.find))) },
  // The core runs in a worker, built with Node's modules and native tools swapped for the device's (vite.core.shared.mjs).
  // One file, on purpose: the server's code reads `process` and `Buffer` as globals that src/core/shims/globals.ts sets, and the Node
  // polyfills (stream, util) read them as soon as they are evaluated. Chunks are evaluated in an order the bundler picks, and a newer
  // Rollup split PDF.js and the polyfills into chunks that ran before the shim, so the core never started. A single file runs in import order.
  worker: { format: 'es', plugins: () => corePlugins(), rollupOptions: { output: { inlineDynamicImports: true } } },
  // The core reads its settings from `process.env`, which Vite would otherwise replace with an empty object (one the core could not set).
  define: { 'process.env': 'globalThis.process.env' },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/share': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
});
