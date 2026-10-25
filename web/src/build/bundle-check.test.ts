import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundleProblems } from '../../scripts/check-bundle.mjs';

/** The check that runs at the end of the build, on built folders made here: one as the build should leave it, and the ways it can go wrong. */
const made: string[] = [];
function assets(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-bundle-'));
  made.push(dir);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}
afterEach(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('the built core worker', () => {
  it('passes when it is one file that imports nothing beside itself', () => {
    expect(bundleProblems(assets({ 'core.worker-AbC123.js': 'const x = await import("data:text/javascript,1"); export {};', 'index-Zz.js': '' }))).toEqual([]);
  });

  it('fails when it imports another chunk, however the import is written', () => {
    for (const text of ['import "./shared-1.js";', 'import { a } from "./shared-1.js";', 'const m = await import("./shared-1.js");', "export * from './shared-1.js';"]) {
      const problems = bundleProblems(assets({ 'core.worker-AbC123.js': text }));
      expect(problems.join(' '), text).toMatch(/imports another chunk/);
    }
  });

  it('fails when the Node polyfills were split into a chunk of their own', () => {
    expect(bundleProblems(assets({ 'core.worker-AbC123.js': '', '_commonjs-dynamic-modules-9x.js': '' })).join(' ')).toMatch(/was split/);
  });

  it('fails when there is no worker, or two', () => {
    expect(bundleProblems(assets({ 'index-Zz.js': '' })).join(' ')).toMatch(/found 0/);
    expect(bundleProblems(assets({ 'core.worker-A.js': '', 'core.worker-B.js': '' })).join(' ')).toMatch(/found 2/);
    expect(bundleProblems(path.join(os.tmpdir(), 'spine-bundle-does-not-exist')).join(' ')).toMatch(/found 0/);
  });
});
