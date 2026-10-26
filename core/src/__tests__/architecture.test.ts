import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { nativeTools, useNativeTools } from '../native-tools.js';
import { getAccountsStore, resetStore, useStoreFactory } from '../store/index.js';
import { createSqliteStore, useDriver } from '../store/sqlite/index.js';
import { openNative } from '../testing/driver-native.js';
import { useNodeFiles } from '../testing/node-files.js';
import { useNodeDigests } from '../testing/node-digests.js';
import os from 'node:os';
import { createChatLlm } from '../llm/index.js';
import { createEmbedder } from '../embedding/index.js';
import { fileSystem, useFiles } from '../files.js';
import { sha256, useDigests } from '../digest.js';
import { resolveDataDir, useDefaultDataDir } from '../config.js';

/**
 * The structural rules of docs/structure-rules.md, checked against the whole repository's import graph and build configuration. A rule that
 * fails here is a real violation, and a legitimate new exception is added to the lists below and to that page in the same commit. The rules S1
 * (direction), S4 (least capability) and S10 (pins) are also held, from other angles, by boundary.test.ts and pinned-images.test.ts.
 */
const repo = path.resolve(__dirname, '../../..');
const rel = (p: string) => path.relative(repo, p);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    if (['node_modules', 'dist', 'coverage'].includes(name)) continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const TEST_PATH = /(^|\/)(__tests__|__integration__|testing)\/|\.test\.tsx?$/;
const isTest = (file: string) => TEST_PATH.test(rel(file));
/** The Node tools exist to run the whole app on Node in tests, so they are test support, not production. */
const NODE_TOOLS = /^server\/src\/native\//;
const production = (area: string) => walk(path.join(repo, area, 'src')).filter(f => !f.endsWith('.d.ts') && !isTest(f) && !NODE_TOOLS.test(rel(f)));

/** The module each import, re-export and dynamic import of a file names. Only statements that start a line, so prose in a comment is not one. */
function specifiers(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of text.matchAll(/^[ \t]*(?:import|export)\b[^'"\n;]*?\bfrom\s+['"]([^'"]+)['"]/gm)) out.push(m[1]);
  for (const m of text.matchAll(/^[ \t]*}\s*from\s+['"]([^'"]+)['"]/gm)) out.push(m[1]);
  for (const m of text.matchAll(/^[ \t]*import\s+['"]([^'"]+)['"]/gm)) out.push(m[1]);
  for (const m of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  return out;
}

const BUILTINS = new Set([...builtinModules, ...builtinModules.map(m => `node:${m}`)]);
const packageOf = (s: string) => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]);
const isRelative = (s: string) => s.startsWith('.');
/** The file a relative import names, as a path from the repository, or null. */
const target = (file: string, spec: string) => rel(path.resolve(path.dirname(file), spec));

describe('S1 — direction', () => {
  it('core imports only core; server imports only server and core by name; web imports only web and core by name', () => {
    const offenders: string[] = [];
    for (const [area, others] of [['core', ['server/', 'web/']], ['server', ['core/', 'web/']], ['web', ['core/', 'server/']]] as const) {
      for (const file of production(area)) {
        for (const spec of specifiers(file)) {
          if (area === 'core' && spec.startsWith('spine-core')) offenders.push(`${rel(file)} -> ${spec} (core names itself by path)`);
          if (!isRelative(spec)) continue;
          const t = target(file, spec);
          if (others.some(o => t.startsWith(o))) offenders.push(`${rel(file)} -> ${t}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('production code imports no test code, test helper or Node tool made to run the app in tests', () => {
    const offenders: string[] = [];
    for (const area of ['core', 'server', 'web']) {
      for (const file of production(area)) {
        for (const spec of specifiers(file)) {
          const named = spec.startsWith('spine-core/') ? `core/src/${spec.slice('spine-core/'.length)}` : isRelative(spec) ? target(file, spec) : '';
          if (!named) continue;
          if (TEST_PATH.test(named + '/') || /^server\/src\/native(\/|$)/.test(named)) offenders.push(`${rel(file)} -> ${named}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('S2 — core is platform-neutral', () => {
  /** What the shared code may import beyond itself. Adding to either list is a decision about the device: say why, in docs/structure-rules.md. */
  const CORE_NODE = new Set(['path']);
  const CORE_PACKAGES = new Set(['@langchain/core', '@langchain/langgraph', 'heic-convert', 'pdfjs-dist', 'uuid', 'zod']);

  it('imports only the Node built-ins and the packages on the lists', () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(repo, 'core/src')).filter(f => !isTest(f))) {
      for (const spec of specifiers(file)) {
        if (isRelative(spec)) continue;
        const bare = spec.replace(/^node:/, '');
        if (BUILTINS.has(spec) || BUILTINS.has(bare)) { if (!CORE_NODE.has(bare)) offenders.push(`${rel(file)} -> node:${bare}`); continue; }
        if (!CORE_PACKAGES.has(packageOf(spec))) offenders.push(`${rel(file)} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('declares as dependencies only what it imports (a native library is, at most, a dev dependency for its tests)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'core/package.json'), 'utf8'));
    expect(Object.keys(pkg.dependencies).sort()).toEqual([...CORE_PACKAGES].sort());
  });

  it('reads no environment and uses no process global: its settings are registered by the host', () => {
    const readers = production('core').filter(f => /\bprocess\.(env|cwd|argv|platform|exit)\b/.test(fs.readFileSync(f, 'utf8'))).map(f => rel(f)).sort();
    expect(readers).toEqual([]);
  });

  // E2: `Buffer` is a Node global, not an import, so the list above cannot see it; the device supplies it (web/src/core/shims/globals.ts).
  // The files that use it are listed so a new one is a decision, and the list can only shrink.
  const BUFFER_USERS = [
    'archive/export.ts', 'archive/zip-read.ts', 'archive/zip-write.ts', 'file-kind.ts', 'files.ts', 'ingestion/accept-upload.ts',
    'ingestion/convert.ts', 'ingestion/photo-set.ts', 'native-tools.ts', 'similarity/index.ts', 'store/sqlite/embeddings.ts', 'store/types.ts',
  ];
  it('uses the Buffer global only in the files on the list (E2)', () => {
    const users = production('core').filter(f => /\bBuffer\b/.test(fs.readFileSync(f, 'utf8'))).map(f => rel(f).replace(/^core\/src\//, '')).sort();
    expect(users).toEqual(BUFFER_USERS);
  });
});

describe('S3 — nothing is wired by default', () => {
  afterEach(() => {
    useNativeTools(null);
    useStoreFactory(null);
    resetStore(null);
    useDriver(openNative);
    useNodeFiles();
    useNodeDigests();
    useDefaultDataDir(path.join(os.tmpdir(), 'spine-test-default-data'));
  });

  it('fails at first use, naming what is missing, for each thing a host brings', () => {
    useNativeTools(null);
    expect(() => nativeTools()).toThrow(/native tools/);

    useStoreFactory(null);
    resetStore(null);
    expect(() => getAccountsStore()).toThrow(/no store has been set up/);

    useFiles(null);
    expect(() => fileSystem()).toThrow(/no files have been registered/);
    useDigests(null);
    expect(() => sha256()).toThrow(/no hashing has been registered/);
    useDefaultDataDir(null);
    expect(() => resolveDataDir({})).toThrow(/DATA_DIR is not set/);

    useDriver(null);
    expect(() => createSqliteStore({ adapter: 'sqlite', location: ':memory:' })).toThrow(/no SQLite driver has been chosen/);

    // the model providers and the embedders: the device's relay is the only one this package knows, and no other is assumed
    expect(() => createChatLlm({ provider: 'anthropic' } as never)).toThrow(/unknown SPINE_LLM_PROVIDER "anthropic"/);
    expect(() => createEmbedder({ adapter: 'vertex' } as never)).toThrow(/unknown SPINE_EMBEDDINGS "vertex"/);
  });
});

describe('S5 — one door per engine and vendor', () => {
  it('names the engine only where it is assembled', () => {
    const allowed = new Set(['core/src/store/index.ts', 'web/src/core/device-store.ts', 'web/src/core/sqlite-wasm.ts', 'server/src/store.ts', 'server/src/driver-native.ts']);
    const offenders: string[] = [];
    for (const area of ['core', 'server', 'web']) {
      for (const file of production(area)) {
        if (rel(file).startsWith('core/src/store/sqlite/') || allowed.has(rel(file))) continue;
        for (const spec of specifiers(file)) if (/store\/sqlite|better-sqlite3|@sqlite\.org/.test(spec)) offenders.push(`${rel(file)} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('imports a model vendor only in the relay service’s adapters', () => {
    const offenders: string[] = [];
    for (const area of ['core', 'server', 'web']) {
      for (const file of production(area)) {
        if (/^server\/src\/(llm|embedding)\/adapters\//.test(rel(file))) continue;
        for (const spec of specifiers(file)) if (/^(@langchain\/(anthropic|google-vertexai|google-common)|google-auth-library|@anthropic-ai)/.test(spec)) offenders.push(`${rel(file)} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('S6 — production ships production', () => {
  const config = (file: string) => JSON.parse(fs.readFileSync(path.join(repo, file), 'utf8')) as { exclude?: string[] };

  it('builds core and server without their tests, and the server without the Node tools', () => {
    expect(config('core/tsconfig.build.json').exclude).toEqual(expect.arrayContaining(['src/__tests__', 'src/testing', 'src/**/*.test.ts']));
    expect(config('server/tsconfig.build.json').exclude).toEqual(expect.arrayContaining(['src/__tests__', 'src/__integration__', 'src/native', 'src/testing', 'src/**/*.test.ts']));
    const scripts = (file: string) => JSON.parse(fs.readFileSync(path.join(repo, file), 'utf8')).scripts as Record<string, string>;
    expect(scripts('server/package.json').build).toContain('tsconfig.build.json');
    expect(scripts('core/package.json').build).toContain('tsconfig.build.json');
  });

  it('builds no test support into either image (nothing is deleted afterwards), and runs every entry point before an image is made', () => {
    for (const file of ['Dockerfile', 'relay.Dockerfile']) {
      const text = fs.readFileSync(path.join(repo, file), 'utf8');
      expect(text, file).not.toMatch(/rm -rf core\/dist|rm -rf server\/dist/);
      expect(text, file).toContain('npm run smoke -w spine-server');
    }
  });
});

describe('S7 — no hidden build-time substitution', () => {
  it('aliases only the packages on the list, and swaps no file by its path', () => {
    const text = fs.readFileSync(path.join(repo, 'web/vite.core.shared.mjs'), 'utf8');
    const aliases = [...text.matchAll(/find:\s*\/(.*?)\/,\s*replacement/g)].map(m => m[1]);
    expect(aliases).toEqual([
      '^spine-core\\/(.*)\\.js$', '^spine-core\\/(.*)$',                    // the shared package, as its source
      '^vite-plugin-node-polyfills\\/shims\\/(.*)$',                         // the polyfills' own helpers
            '^(@langchain\\/google-common)$',                                      // one copy of LangChain
      '^pdfjs-dist\\/legacy\\/build\\/pdf\\.mjs$', '^pdfjs-real\\/(.*)$',    // PDF.js with its fonts served from our own origin
    ]);
    expect(text).not.toMatch(/REPLACED|replaceNativeFiles|empty\.ts/);
  });

  it('clears the build folder first, and makes the worker one file', () => {
    for (const pkg of ['core', 'server']) expect(JSON.parse(fs.readFileSync(path.join(repo, pkg, 'package.json'), 'utf8')).scripts.build, pkg).toMatch(/^rm -rf dist &&/);
    expect(fs.readFileSync(path.join(repo, 'web/package.json'), 'utf8')).toContain('check-bundle.mjs');
    expect(fs.readFileSync(path.join(repo, 'web/vite.config.ts'), 'utf8')).toContain('inlineDynamicImports: true');
  });
});

describe('S8 — every process is started by a test', () => {
  it('has a smoke test for each entry point of the server, and no entry point it does not list', () => {
    const smoke = fs.readFileSync(path.join(repo, 'server/scripts/smoke-entrypoints.mjs'), 'utf8');
    const listed = (smoke.match(/ENTRYPOINTS = \[(.*?)\]/s)?.[1] ?? '').match(/'([^']+)'/g)?.map(s => s.slice(1, -1)).sort();
    // a file that listens for connections, starts the relay, or is run as a command, is an entry point
    // a file that exports a function to serve (relay/serve.ts) is started by the entry points that call it, which are the ones listed
    const found = production('server').filter(f => { const text = fs.readFileSync(f, 'utf8'); return /\.listen\(|process\.argv\[1\]|^async function main\(|^serveRelay\(\)/m.test(text) && !/^export function serve/m.test(text); })
      .map(f => `dist/${path.relative(path.join(repo, 'server/src'), f).replace(/\.ts$/, '.js')}`).sort();
    expect(found).toEqual(listed);
  });
});

describe('S10 — reproducible inputs', () => {
  it('installs from the lockfile with npm ci, never npm install, in the images and the pipelines', () => {
    const offenders: string[] = [];
    for (const file of ['Dockerfile', 'relay.Dockerfile', 'scripts/check.sh', '.github/workflows/ci.yml', '.gitlab-ci.yml', 'install.sh']) {
      fs.readFileSync(path.join(repo, file), 'utf8').split('\n').forEach((line, i) => { if (/\bnpm (install|i)\b/.test(line) && !line.trim().startsWith('#')) offenders.push(`${file}:${i + 1}`); });
    }
    expect(offenders).toEqual([]);
    expect(fs.existsSync(path.join(repo, 'package-lock.json'))).toBe(true);
    for (const stale of ['server/package-lock.json', 'web/package-lock.json', 'core/package-lock.json']) expect(fs.existsSync(path.join(repo, stale)), stale).toBe(false);
  });
});
