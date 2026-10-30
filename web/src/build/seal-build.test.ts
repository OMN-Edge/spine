import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addIntegrity, buildPathLeaks, hashLines, sealBuild, HASHES_FILE } from '../../scripts/seal-build.mjs';

/** The step that ends the build (TR-CLI-02): integrity attributes on the page, and the list of hashes anyone can compare with. */
const made: string[] = [];
function built(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-seal-'));
  made.push(dir);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}
afterEach(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const PAGE = `<!doctype html><head>
<script src="/theme.js"></script>
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<script type="module" crossorigin src="/assets/index-A.js"></script>
<link rel="stylesheet" crossorigin href="/assets/index-A.css">
<link rel="modulepreload" href="/assets/chunk-B.js">
<script src="https://elsewhere.example/x.js"></script>
</head>`;
const FILES = { 'index.html': PAGE, 'theme.js': 'a', 'favicon.svg': '<svg/>', 'assets/index-A.js': 'b', 'assets/index-A.css': 'c', 'assets/chunk-B.js': 'd' };
const sri = (text: string) => `sha384-${crypto.createHash('sha384').update(text).digest('base64')}`;

describe('integrity on the page', () => {
  it('goes on each script, stylesheet and preload that is a file of the build, with the hash of that file', () => {
    const html = addIntegrity(PAGE, built(FILES));
    expect(html).toContain(`<script src="/theme.js" integrity="${sri('a')}"></script>`);
    expect(html).toContain(`<script type="module" crossorigin src="/assets/index-A.js" integrity="${sri('b')}"></script>`);
    expect(html).toContain(`<link rel="stylesheet" crossorigin href="/assets/index-A.css" integrity="${sri('c')}">`);
    expect(html).toContain(`<link rel="modulepreload" href="/assets/chunk-B.js" integrity="${sri('d')}">`);
  });

  it('is left off an icon, an address elsewhere and a file the build does not have, and is not added twice', () => {
    const dir = built(FILES);
    const html = addIntegrity(PAGE, dir);
    expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
    expect(html).toContain('<script src="https://elsewhere.example/x.js"></script>');
    expect(addIntegrity(html, dir)).toBe(html);
    expect(addIntegrity('<script src="/gone.js"></script>', dir)).toBe('<script src="/gone.js"></script>');
  });
});

describe('hashes.txt', () => {
  it('lists every file but itself, sorted, as sha256sum -c reads it', () => {
    const dir = built(FILES);
    expect(sealBuild(dir, '/not/here')).toEqual([]);
    const lines = fs.readFileSync(path.join(dir, HASHES_FILE), 'utf8').split('\n');
    expect(lines.at(-1)).toBe('');
    const names = lines.filter(Boolean).map(l => l.slice(66));
    expect(names).toEqual([...names].sort());
    expect(names).toEqual(['assets/chunk-B.js', 'assets/index-A.css', 'assets/index-A.js', 'favicon.svg', 'index.html', 'theme.js']);
    for (const line of lines.filter(Boolean)) {
      expect(line).toMatch(/^[0-9a-f]{64} {2}\S+$/);
      expect(crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, line.slice(66)))).digest('hex')).toBe(line.slice(0, 64));
    }
  });

  it('describes the page as sealed, so the integrity attributes are part of what is compared', () => {
    const dir = built(FILES);
    sealBuild(dir, '/not/here');
    const indexLine = hashLines(dir).find(l => l.endsWith('  index.html'))!;
    expect(indexLine.slice(0, 64)).toBe(crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'index.html'))).digest('hex'));
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toContain('integrity=');
  });

  it('is the same for the same files, whatever folder they are in', () => {
    const a = built(FILES);
    const b = built(FILES);
    sealBuild(a, '/not/here');
    sealBuild(b, '/not/here');
    expect(fs.readFileSync(path.join(a, HASHES_FILE))).toEqual(fs.readFileSync(path.join(b, HASHES_FILE)));
  });
});

describe('a build that names its own folder', () => {
  it('is refused, because the same commit would build differently elsewhere', () => {
    const dir = built({ ...FILES, 'assets/index-A.js': 'const p = "/home/someone/spine/web/src/x.ts";' });
    expect(buildPathLeaks(dir, '/home/someone/spine')).toEqual(['assets/index-A.js']);
    expect(sealBuild(dir, '/home/someone/spine').join(' ')).toMatch(/built in/);
    expect(fs.existsSync(path.join(dir, HASHES_FILE))).toBe(false);
  });
});
