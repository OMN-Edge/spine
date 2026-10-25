import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The three packages and who may use whom: core is used by server and web, and uses neither. This is what the split is for, so it is a
 * test and not a convention: a file in core that reaches into server/ or web/ would make the device's code depend on something only the
 * server has, and a file outside core that reaches in by path (not as `spine-core/...`) would skip the package's own surface.
 */
const repo = path.resolve(__dirname, '../../..');
const core = path.join(repo, 'core/src');
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bvi\.(?:do)?mock\(\s*)(['"])(\.{1,2}\/[^'"]*)\1/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** The relative imports of a file, as the paths they name. */
function relativeImports(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(SPEC)].map(m => path.resolve(path.dirname(file), m[2]));
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + path.sep);

describe('the packages', () => {
  it('core imports nothing from server or web (its tests and test setup may reach web)', () => {
    const offenders: string[] = [];
    for (const file of walk(core)) {
      if (file.includes(`${path.sep}__tests__${path.sep}`)) continue;
      for (const target of relativeImports(file)) {
        if (!inside(target, core)) offenders.push(`${path.relative(repo, file)} -> ${path.relative(repo, target)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('core does not name the other packages as dependencies', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'core/package.json'), 'utf8'));
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies });
    expect(names.filter(n => n === 'spine-server' || n === 'spine-web')).toEqual([]);
  });

  it('the server and the web app use core as `spine-core/...`, not by its path', () => {
    const offenders: string[] = [];
    for (const dir of ['server/src', 'web/src']) {
      for (const file of walk(path.join(repo, dir))) {
        for (const target of relativeImports(file)) {
          if (inside(target, core)) offenders.push(`${path.relative(repo, file)} -> ${path.relative(repo, target)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the server’s own code asks only for the accounts store: it never calls getStore or createStore, which are for records', () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(repo, 'server/src'))) {
      const rel = path.relative(repo, file);
      if (rel.includes(`${path.sep}__tests__${path.sep}`) || rel.includes(`${path.sep}__integration__${path.sep}`)) continue;
      if (/\b(getStore|createStore)\(/.test(fs.readFileSync(file, 'utf8'))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('the server does not import the web app', () => {
    // Two tests drive web code from the server's side (the device's router against the same routes, and the WebAssembly driver);
    // nothing the server runs may.
    const allowed = new Set(['server/src/__tests__/local-app.test.ts']);
    const offenders: string[] = [];
    for (const file of walk(path.join(repo, 'server/src'))) {
      const rel = path.relative(repo, file);
      if (allowed.has(rel)) continue;
      for (const target of relativeImports(file)) {
        if (inside(target, path.join(repo, 'web'))) offenders.push(`${rel} -> ${path.relative(repo, target)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
