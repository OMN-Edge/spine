import { defineConfig } from 'vite';
import { corePlugins, coreAssets } from '../vite.core.shared.mjs';

/** Builds the browser check: the device core and its native replacements, run by run.mjs in a real Chrome under the production policy. */
export default defineConfig({
  root: import.meta.dirname,
  plugins: [...corePlugins(), coreAssets()],
  define: { 'process.env': 'globalThis.process.env' },
  // The check's own worker is one file for the reason the app's is (see ../vite.config.ts).
  worker: { format: 'es', plugins: () => corePlugins(), rollupOptions: { output: { inlineDynamicImports: true } } },
  build: { outDir: 'dist', emptyOutDir: true, minify: false, target: 'es2022', rollupOptions: {
      // Every other warning is shown (a missing export is a break, not noise); zod's comments about tree shaking are the one known harmless kind.
      onwarn(warning, warn) { if (warning.code !== 'INVALID_ANNOTATION') warn(warning); },
      output: { inlineDynamicImports: true },  // one file: see worker in ../vite.config.ts
    } },
});
