import { describe, it, expect } from 'vitest';
import { guessTitle } from '../ingestion/title-guess.js';

/** The text is invented. A guess from the first lines of a page, with no model (SECURITY.md M-29). */
describe('a label for a document that has not been read', () => {
  it('prefers a line that names a kind of document over the clinic’s letterhead', () => {
    const page = ['SPITAL EXEMPLU SRL', 'Str. Fictiva nr. 4, Oras Exemplu', 'Tel: 0211 000 000', 'BULETIN DE ANALIZE MEDICALE', 'Pacient: Ion Exemplu'].join('\n');
    expect(guessTitle(page)).toBe('Buletin de analize medicale');
  });

  it('works in the other languages the interface speaks', () => {
    expect(guessTitle('Cabinet Exemple\nCompte rendu de consultation\nDate: 12/03/2026')).toBe('Compte rendu de consultation');
    expect(guessTitle('Praxis Beispiel\nArztbrief\nDatum: 12.03.2026')).toBe('Arztbrief');
    expect(guessTitle('Example Clinic\nDischarge summary\nAdmitted 2 April')).toBe('Discharge summary');
  });

  it('skips numbers, dates, page markers, phone numbers, addresses and e-mail', () => {
    expect(guessTitle('12.03.2026\n0211 000 000\nPagina 1 din 3\ncontact@exemplu.test\nStrada Fictiva 4\nRaport de laborator')).toBe('Raport de laborator');
    expect(guessTitle('12.03.2026\n1 / 3\n0211 000 000')).toBeNull();
  });

  it('falls back to the first line that reads like words, and says nothing for an empty page', () => {
    expect(guessTitle('Fisa pacientului Exemplu\nvarsta 41')).toBe('Fisa pacientului Exemplu');
    expect(guessTitle('')).toBeNull();
    expect(guessTitle(null)).toBeNull();
  });

  it('is short', () => {
    const long = `Raport ${'foarte lung '.repeat(20)}`;
    expect((guessTitle(long) ?? '').length).toBeLessThanOrEqual(80);
  });
});
