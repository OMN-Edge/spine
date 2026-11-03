import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MARK_PATHS } from './Logo';

/** The favicon is the mark in a fixed colour, written out as a file: it must be drawn with the same vertebrae as the mark. */
describe('the favicon', () => {
  it('has the mark’s vertebrae', () => {
    const svg = readFileSync(new URL('../../public/favicon.svg', import.meta.url), 'utf8');
    expect([...svg.matchAll(/<path d="([^"]+)"/g)].map(m => m[1])).toEqual(MARK_PATHS);
  });
});
