import { describe, expect, it } from 'vitest';
import { pageName } from './ChatProvider';

describe('pageName: what the chat says it is looking at', () => {
  it('names a page the assistant knows by its screen', () => {
    expect(pageName('trends', '/trends')).toBe('Trends');
  });

  it('names the pages the assistant calls "other" by their address, not "Spine"', () => {
    expect(pageName('other', '/emergency')).toBe('Emergency card');
    expect(pageName('other', '/profiles')).toBe('People');
    expect(pageName('other', '/episodes')).toBe('Episodes');
    expect(pageName('other', '/somewhere-else')).toBe('Spine');
  });
});
