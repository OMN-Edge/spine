// Run after `vite build` and before `seo-pages.mjs`: draws the public pages whose text is the same for everyone (`src/prerender-entry.tsx`) to HTML, with the app's own source,
// and leaves them in `dist/prerender.json` (path to markup) for `seo-pages.mjs` to put into each page's file. The same commit draws the same text anywhere.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true } });
try {
  // What the pages read while they are drawn and nothing more: the theme the page has, whether the device prefers dark, and the address's query. There is no DOM here.
  const given = { document: { documentElement: { getAttribute: () => null } }, window: { matchMedia: () => ({ matches: false }), location: { search: '' } } };
  const { PRERENDERED, renderPublic } = await server.ssrLoadModule('/src/prerender-entry.tsx');
  Object.assign(globalThis, given);
  const out = {};
  for (const page of Object.keys(PRERENDERED)) {
    out[page] = renderPublic(page);
    if (out[page].length < 500) throw new Error(`${page} drew almost nothing (${out[page].length} characters)`);
  }
  for (const key of Object.keys(given)) delete globalThis[key];
  fs.writeFileSync(path.join(root, 'dist', 'prerender.json'), JSON.stringify(out));
  console.log(`prerendered ${Object.keys(out).length} public pages`);
} finally {
  await server.close();
}
