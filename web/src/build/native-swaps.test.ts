import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { REPLACED } from '../../vite.core.shared.mjs';

/**
 * The device runs the shared code with some files swapped for browser versions (vite.core.shared.mjs, `REPLACED`: a map from a path in
 * core/src to a file in src/core/native). The swap is by path, so nothing complains if a file that needs Node is added and not swapped, if a
 * swapped file is renamed, or if its replacement stops offering what the original does: the first sign would be a feature that breaks in
 * a browser. These tests are that sign, earlier.
 */
const core = path.resolve(__dirname, '../../../core/src');
const native = path.resolve(__dirname, '../core/native');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) { if (name !== '__tests__' && name !== 'testing') walk(p, out); } else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Packages (and built-ins) a browser does not have, or that would do nothing there. */
const NODE_ONLY = /from '(sharp|pdfkit|yauzl|yazl|google-auth-library|@langchain\/google-vertexai|@langchain\/anthropic|better-sqlite3|maxmind|(node:)?child_process)'/;

/** Files that import them and are never run on the device, and why. Anything else that does must be swapped. */
const NEVER_ON_THE_DEVICE: Record<string, string> = {
  'llm/adapters/anthropic.ts': 'a provider adapter: the device sends its model calls to the relay, which runs the provider',
  'llm/adapters/vertex.ts': 'a provider adapter: the relay runs it',
  'llm/adapters/vertex-tasks.ts': 'a provider adapter: the relay runs it',
  'embedding/adapters/vertex.ts': 'a provider adapter: the relay runs it',
  'store/sqlite/driver-native.ts': 'the native SQLite module: the device brings SQLite in WebAssembly',
};

/** The names a file exports as values (types are erased and cost a replacement nothing). */
function valueExports(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const names = new Set<string>();
  for (const m of text.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class|enum)\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
  for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gm)) for (const part of m[1].split(',')) { const n = part.trim().split(/\s+as\s+/).pop()!.replace(/^type\s+/, ''); if (n && !/^type\s/.test(part.trim())) names.add(n); }
  if (/^export\s+default\b/m.test(text)) names.add('default');
  return [...names];
}

describe('the files the device swaps for browser versions', () => {
  it('are all there: each original in core and each replacement in src/core/native', () => {
    for (const [original, replacement] of Object.entries(REPLACED)) {
      expect(fs.existsSync(path.join(core, original)), `core/src/${original}`).toBe(true);
      expect(fs.existsSync(path.join(native, replacement)), `src/core/native/${replacement}`).toBe(true);
    }
  });

  it('offer everything the original does', () => {
    for (const [original, replacement] of Object.entries(REPLACED)) {
      const wanted = valueExports(path.join(core, original));
      const offered = new Set(valueExports(path.join(native, replacement)));
      expect(wanted.filter(n => !offered.has(n)), `${replacement} lacks`).toEqual([]);
    }
  });

  it('cover every file in core that needs Node, except those that never run on the device', () => {
    const unplaced: string[] = [];
    for (const file of walk(core)) {
      const rel = path.relative(core, file);
      if (!NODE_ONLY.test(fs.readFileSync(file, 'utf8'))) continue;
      if (!(rel in REPLACED) && !(rel in NEVER_ON_THE_DEVICE)) unplaced.push(rel);
    }
    expect(unplaced, 'add a browser version to REPLACED, or say in NEVER_ON_THE_DEVICE why it is not needed').toEqual([]);
  });

  it('do not list a file as both swapped and never used', () => {
    expect(Object.keys(REPLACED).filter(f => f in NEVER_ON_THE_DEVICE)).toEqual([]);
  });
});
