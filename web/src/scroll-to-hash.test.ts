import { describe, expect, it } from 'vitest';
import { hashTarget, scrollFor } from './scroll-to-hash';

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

describe('where the screen is after a link', () => {
  it('is at the top of a page followed from another, where it used to open at the height of the one before', () => {
    expect(scrollFor('', 'PUSH')).toEqual({ to: 'top' });
    expect(scrollFor('', 'REPLACE')).toEqual({ to: 'top' });
  });

  it('is at the section the link names, and where the browser had it for Back and Forward', () => {
    expect(scrollFor('#shared', 'PUSH')).toEqual({ to: 'section', id: 'shared' });
    expect(scrollFor('#shared', 'POP')).toEqual({ to: 'section', id: 'shared' });
    expect(scrollFor('', 'POP')).toEqual({ to: 'stay' });
  });
});
