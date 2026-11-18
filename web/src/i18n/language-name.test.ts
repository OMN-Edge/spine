import { describe, expect, it } from 'vitest';
import { languageName } from './useTranslation';

describe('a language named in a sentence', () => {
  it('is named in the reader’s language, not in its own', () => {
    expect(languageName('ro', 'de')).toBe('Rumänisch');
    expect(languageName('de', 'en')).toBe('German');
  });

  it('is its own name in a list to choose from, and the code where nothing is known', () => {
    expect(languageName('ro')).toBe('Română');
    expect(languageName('xx')).toBe('XX');
  });
});
