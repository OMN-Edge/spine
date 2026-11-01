/// <reference types="vitest/config" />
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { corePlugins, coreAssets, coreAliases, nodeModules } from './vite.core.shared.mjs';

/**
 * The commit this build is of, written into the app (`src/build-info.ts`) so a site says which commit to build to check it (docs/verify-build.md).
 * `SPINE_COMMIT` wins (a Docker build has no .git); otherwise git is asked, and uncommitted changes add `-dirty`. A build that can do neither says
 * `unknown` (a self-hoster's `docker compose up` still works); the release workflow refuses to publish a build that says it.
 */
function buildCommit(): string {
  const fromEnv = process.env.SPINE_COMMIT?.trim();
  if (fromEnv) return fromEnv;
  try {
    const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return git('rev-parse', 'HEAD') + (git('status', '--porcelain') ? '-dirty' : '');
  } catch {
    console.warn('Cannot tell which commit this is (no git checkout, no SPINE_COMMIT): the app will say "unknown".');
    return 'unknown';
  }
}

/** The version in web/package.json, the one a release is tagged with (docs/releasing.md). */
const version = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;

export default defineConfig(({ command }) => ({
  // `nodeModules` is also here because its aliases are set when the config is read, which the worker's own plugin list does not do.
  plugins: [react(), coreAssets(), nodeModules()],
  // The page uses a few pure files of the shared package (the rules for syncing, the vault client's clock reading), as source.
  resolve: { alias: coreAliases.filter(a => /spine-core/.test(String(a.find))) },
  // The core runs in a worker. What it asks of the machine (files, hashing, settings, the native tools) the device registers when the core starts (src/core/native/, src/core/shims/fs.ts).
  // One file, on purpose: the server's code reads `process` and `Buffer` as globals that src/core/shims/globals.ts sets, and the Node
  // polyfills (stream, util) read them as soon as they are evaluated. Chunks are evaluated in an order the bundler picks, and a newer
  // Rollup split PDF.js and the polyfills into chunks that ran before the shim, so the core never started. A single file runs in import order.
  worker: { format: 'es', plugins: () => corePlugins(), rollupOptions: { output: { inlineDynamicImports: true } } },
  // Libraries the core bundles read `process.env`, which Vite would otherwise replace with an empty object (one src/core/shims/globals.ts could not set).
  define: {
    'process.env': 'globalThis.process.env',
    // Only a build says a commit; the dev server and the tests show `dev`.
    __SPINE_COMMIT__: JSON.stringify(command === 'build' ? buildCommit() : 'dev'),
    __SPINE_VERSION__: JSON.stringify(version),
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/share': 'http://localhost:3000',
    },
  },
  // A test that asserts nothing passes whatever the code does; this makes it fail instead.
  test: { expect: { requireAssertions: true } },
  build: {
    outDir: 'dist',
    // A font is never inlined as a data: address: the content security policy allows fonts from this origin only (font-src 'self').
    assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
    target: 'es2022',
  },
}));
