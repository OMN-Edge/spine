import { describe, expect, it } from 'vitest';
import { buildOverview, defaultShareName } from './share-overview';

/** What a share link starts by telling the doctor: never "Me", the name an account gives its own first records. */
describe('the name a share link starts with', () => {
  it('is the emergency card\'s, else the open person\'s, and nothing for "Me"', () => {
    expect(defaultShareName('Ana Exemplu', 'Me')).toBe('Ana Exemplu');
    expect(defaultShareName(undefined, 'Ana')).toBe('Ana');
    // What the owner showed on the last link stands in for a card with no name, and for "Me", which is not a name.
    expect(defaultShareName(undefined, 'Me', 'Ana Exemplu')).toBe('Ana Exemplu');
    expect(defaultShareName('Card Name', 'Me', 'Ana Exemplu')).toBe('Card Name');
    expect(defaultShareName('', 'Ana')).toBe('Ana');
    expect(defaultShareName(undefined, 'Me')).toBe('');
    expect(defaultShareName('  ', 'Me')).toBe('');
  });

  it('is left out of the overview when it is empty, with the box ticked', () => {
    expect(buildOverview({ showName: true, name: defaultShareName(undefined, 'Me'), note: '', includeNow: false }, null)).toBeNull();
    expect(buildOverview({ showName: true, name: 'Ana', note: '', includeNow: false }, null)).toMatchObject({ by: 'Ana' });
  });
});
