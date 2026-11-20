import { describe, expect, it } from 'vitest';
import { hashTarget } from './scroll-to-hash';

describe('a link to a section of a page', () => {
  it('names the section by the fragment, decoded', () => {
    expect(hashTarget('#shared')).toBe('shared');
    expect(hashTarget('#a%20b')).toBe('a b');
  });

  it('names none for no fragment, an empty one or a broken one', () => {
    expect(hashTarget('')).toBeNull();
    expect(hashTarget('#')).toBeNull();
    expect(hashTarget('#%E0%A4%A')).toBeNull();
  });
});
