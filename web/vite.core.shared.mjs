import fs from 'node:fs';
import path from 'node:path';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

/**
 * How the shared code (core/src) is built for the device (docs/crypto-design.md): Node's modules become the ones in src/core/shims, and the few
 * files of it that run a native tool (poppler, tesseract, sharp, ...) are swapped for the file of the same name in src/core/native.
 */
const here = path.dirname(new URL(import.meta.url).pathname);
const shims = path.join(here, 'src/core/shims');
const native = path.join(here, 'src/core/native');
const core = path.resolve(here, '../core/src');

/** A package may be installed here or, with the workspaces, at the root. */
const installed = rel => (fs.existsSync(path.join(here, 'node_modules', rel)) ? path.join(here, 'node_modules', rel) : path.join(here, '../node_modules', rel));

/** Server file -> its replacement on the device. */
export const REPLACED = {
  'ingestion/rasterize.ts': 'rasterize.ts',
  'parser/ocr.ts': 'ocr.ts',
  'archive/pdf-pages.ts': 'pdf-pages.ts',
  'ingestion/image-ops.ts': 'image-ops.ts',
  'ingestion/signatures.ts': 'signatures.ts',
  'ingestion/text-pdf.ts': 'text-pdf.ts',
  'archive/zip-read.ts': 'zip-read.ts',
  'archive/zip-write.ts': 'zip-write.ts',
  'geo.ts': 'geo.ts',
};

const replaceNativeFiles = {
  name: 'spine-device-files',
  enforce: 'pre',
  async resolveId(source, importer) {
    if (!importer) return null;
    // Reached by a relative path from inside the core, or by name from the device's own code.
    const target = source.startsWith('.') ? path.resolve(path.dirname(importer), source) : source.startsWith('spine-core/') ? path.join(core, source.slice('spine-core/'.length)) : null;
    if (!target) return null;
    const rel = path.relative(core, target.replace(/\.js$/, '.ts'));
    return REPLACED[rel] ? path.join(native, REPLACED[rel]) : null;
  },
};

export const coreAliases = [
  // The shared package is used as its source here, so a change in it needs no build.
  { find: /^spine-core\/(.*)\.js$/, replacement: `${core}/$1.ts` },
  { find: /^spine-core\/(.*)$/, replacement: `${core}/$1` },
  { find: /^vite-plugin-node-polyfills\/shims\/(.*)$/, replacement: path.join(installed('vite-plugin-node-polyfills'), 'shims/$1/dist/index.js') },
  { find: /^(node:)?fs\/promises$/, replacement: path.join(shims, 'fs-promises.ts') },
  { find: /^(node:)?fs$/, replacement: path.join(shims, 'fs.ts') },
  { find: /^(node:)?crypto$/, replacement: path.join(shims, 'crypto.ts') },
  { find: /^(node:)?url$/, replacement: path.join(shims, 'url.ts') },
  { find: /^(node:)?(child_process|module)$/, replacement: path.join(shims, 'empty.ts') },
  // The one copy of LangChain the shared code uses, so a class made here is the same class there.
  { find: /^(@langchain\/google-common)$/, replacement: installed('@langchain/google-common') },
  { find: /^pdfjs-dist\/legacy\/build\/pdf\.mjs$/, replacement: path.join(native, 'pdfjs.ts') },
  // The real PDF.js, for the file above that wraps it: it cannot ask for it by its own name, which is the one swapped for that file.
  { find: /^pdfjs-real\/(.*)$/, replacement: `${installed('pdfjs-dist')}/$1` },
  { find: /^(sharp|pdfkit|yauzl|yazl|google-auth-library|@langchain\/google-vertexai|@langchain\/anthropic|better-sqlite3|@node-rs\/argon2)$/, replacement: path.join(shims, 'empty.ts') },
];

/** `inNode`: the tests run in Node, which has these modules for real; only the swaps are wanted. */
/** The aliases as a plugin, so they apply where it is used (the core's worker, its tests) and not to the page's own code. */
const coreAliasPlugin = (aliases) => ({
  name: 'spine-core-aliases',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    for (const { find, replacement } of aliases) {
      if (find.test(source)) return this.resolve(source.replace(find, replacement), importer, { ...options, skipSelf: true });
    }
    return null;
  },
});

/** Browser versions of the Node modules the shared code imports (buffer, path, stream, ...). */
export const nodeModules = () => nodePolyfills({ include: ['buffer', 'path', 'stream', 'events', 'util', 'os', 'process'], globals: { Buffer: false, process: false, global: false } });

export const corePlugins = ({ inNode = false } = {}) => [
  coreAliasPlugin(inNode ? coreAliases.filter(a => !String(a.find).includes('child_process')) : coreAliases),
  replaceNativeFiles,
  ...(inNode ? [] : [nodeModules()]),
];

/** Files the core loads at run time from its own origin (the page's policy allows nothing else): PDF.js's fonts, Tesseract and its languages, DejaVu. */
const ASSETS = [
  ['pdfjs-dist/standard_fonts', 'pdfjs/standard_fonts'],
  ['tesseract.js/dist/worker.min.js', 'tesseract/worker.min.js'],
  ['tesseract.js-core', 'tesseract/core', /^tesseract-core.*\.(js|wasm)$/],
  ['@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'tesseract/lang/eng.traineddata.gz'],
  ['@tesseract.js-data/ron/4.0.0_best_int/ron.traineddata.gz', 'tesseract/lang/ron.traineddata.gz'],
  ['dejavu-fonts-ttf/ttf/DejaVuSans.ttf', 'fonts/DejaVuSans.ttf'],
];

export const coreAssets = () => ({
  name: 'spine-core-assets',
  // In development the same files are answered from where they are installed.
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\//, '');
      for (const [from, to, only] of ASSETS) {
        if (!url.startsWith(to)) continue;
        const source = path.join(installed(from), url.slice(to.length));
        const file = fs.existsSync(source) && fs.statSync(source).isFile() ? source : null;
        if (file && (!only || only.test(path.basename(file)))) {
          res.setHeader('content-type', file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
          return fs.createReadStream(file).pipe(res);
        }
      }
      next();
    });
  },
  writeBundle(options) {
    const out = options.dir;
    for (const [from, to, only] of ASSETS) {
      const source = installed(from);
      const target = path.join(out, to);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (fs.statSync(source).isDirectory()) {
        fs.mkdirSync(target, { recursive: true });
        for (const name of fs.readdirSync(source)) if (!only || only.test(name)) fs.cpSync(path.join(source, name), path.join(target, name), { recursive: true });
      } else fs.cpSync(source, target);
    }
  },
});
