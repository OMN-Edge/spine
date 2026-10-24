import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * docs/requirements.md is the one place the FR-, TR- and CR- IDs are defined, and the rest of the repository cites them. This holds the two
 * together: an ID is defined once, every ID cited anywhere is defined, and every row says when or how it is met.
 */
const root = new URL('../../../', import.meta.url).pathname;
const doc = readFileSync(`${root}docs/requirements.md`, 'utf8');
const ID = /\b(?:FR|TR|CR)-[A-Z]+-\d{2}\b/g;

const rows = doc.split('\n').filter(line => /^\| (?:FR|TR|CR)-[A-Z]+-\d{2} \|/.test(line));
const defined = rows.map(line => line.split('|')[1].trim());

describe('docs/requirements.md', () => {
  it('defines each requirement once', () => {
    expect(defined.length).toBeGreaterThan(80);
    expect(new Set(defined).size).toBe(defined.length);
  });

  it('gives every functional row a priority and a release, every compliance row a basis and a status', () => {
    for (const line of rows) {
      const cells = line.split('|').slice(1, -1).map(c => c.trim());
      const id = cells[0];
      expect(cells.every(c => c.length > 0), id).toBe(true);
      if (id.startsWith('FR-')) {
        expect(['Must', 'Should', 'Could'], id).toContain(cells[2]);
        expect(['Launch', 'Soon', 'Later'], id).toContain(cells[3]);
      }
      if (id.startsWith('CR-')) expect(cells.length, id).toBe(5);
    }
  });

  it('is the definition of every ID the rest of the repository cites', () => {
    const files = execFileSync('git', ['ls-files', '*.md', '*.ts', '*.tsx', '*.sql', '*.mjs'], { cwd: root, encoding: 'utf8' })
      .split('\n').filter(f => f && f !== 'docs/requirements.md' && !f.startsWith('server/src/__tests__/requirements.test.ts'));
    const missing: string[] = [];
    for (const file of files) {
      let text: string;
      try { text = readFileSync(root + file, 'utf8'); } catch { continue; }
      for (const id of new Set(text.match(ID) ?? [])) if (!defined.includes(id)) missing.push(`${file}: ${id}`);
    }
    expect(missing).toEqual([]);
  });

  it('keeps its prose on one line a paragraph', () => {
    const wrapped = doc.split('\n').filter((line, i, all) => /^[A-Za-z]/.test(line) && /^[a-z]/.test(all[i + 1] ?? '') && !line.startsWith('|'));
    expect(wrapped).toEqual([]);
  });
});
