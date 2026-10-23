import { defineConfig } from 'vite';
import { corePlugins, coreAssets } from '../vite.core.shared.mjs';

/** Builds the browser check: the device core and its native replacements, run by run.mjs in a real Chrome under the production policy. */
export default defineConfig({
  root: import.meta.dirname,
  plugins: [...corePlugins(), coreAssets()],
  build: { outDir: 'dist', emptyOutDir: true, minify: false, target: 'es2022', rollupOptions: { shimMissingExports: true, onwarn() {} } },
});
