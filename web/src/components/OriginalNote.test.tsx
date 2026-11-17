import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n';
import OriginalNote, { editsOriginal } from './OriginalNote';

/** The note above the review form (T-17): only where the document is not in the language of the screens. */
const note = (language: string | null) => renderToStaticMarkup(<I18nProvider><OriginalNote documentLanguage={language} /></I18nProvider>).replace(/<[^>]+>/g, '');

describe('the note above the review form', () => {
  it('says the original is being corrected, in its language, and that the reader’s version is made again after the save', () => {
    const text = note('ro');
    expect(text).toContain('You are correcting the original, in');
    expect(text).toContain('Română');
    expect(text).toContain('English version is a translation and is made again after you save.');
  });

  it('is not there when the document is in the language of the screens, or its language is not known', () => {
    expect(note('en')).toBe('');
    expect(note(null)).toBe('');
    expect(note('')).toBe('');
  });

  it('knows a document in another language from one in the screens’ language', () => {
    expect(editsOriginal('ro', 'en')).toBe(true);
    expect(editsOriginal('ro', 'ro')).toBe(false);
    expect(editsOriginal('de', 'it')).toBe(true);
  });
});
