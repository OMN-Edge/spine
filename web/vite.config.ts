import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { corePlugins, coreAssets, nodeModules } from './vite.core.shared.mjs';

export default defineConfig({
  // `nodeModules` is also here because its aliases are set when the config is read, which the worker's own plugin list does not do.
  plugins: [react(), coreAssets(), nodeModules()],
  // The core runs in a worker, built with Node's modules and native tools swapped for the device's (vite.core.shared.mjs).
  worker: { format: 'es', plugins: () => corePlugins() },
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
