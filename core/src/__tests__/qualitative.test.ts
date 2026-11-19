import { describe, expect, it } from 'vitest';
import { isSusceptibility, qualitativeOf } from '../qualitative.js';

/** Words a lab prints in place of a number, in any of the four languages, by a fixed map (T-18). */
describe('a qualitative value', () => {
  it('is the same value in Romanian, English, French and German', () => {
    for (const word of ['Sensibil', 'sensibilă', 'Sensitive', 'Susceptible', 'Sensible', 'empfindlich']) expect(qualitativeOf(word)).toBe('sensitive');
    for (const word of ['Rezistent', 'Resistant', 'résistant', 'Resistent']) expect(qualitativeOf(word)).toBe('resistant');
    for (const word of ['Intermediar', 'Intermediate', 'Intermédiaire']) expect(qualitativeOf(word)).toBe('intermediate');
    for (const word of ['Pozitiv', 'Positive', 'positif', 'Positiv']) expect(qualitativeOf(word)).toBe('positive');
    for (const word of ['Negativ', 'Negative', 'Négatif']) expect(qualitativeOf(word)).toBe('negative');
    for (const word of ['Absent', 'absentă']) expect(qualitativeOf(word)).toBe('absent');
    for (const word of ['Prezent', 'Present', 'vorhanden']) expect(qualitativeOf(word)).toBe('present');
  });

  it('ignores case, accents, surrounding space and a closing full stop', () => {
    expect(qualitativeOf('  REZISTENTĂ ')).toBe('resistant');
    expect(qualitativeOf('  SENSIBIL. ')).toBe('sensitive');
  });

  it('is nothing for a number, a unit or a word that is not one, and for nothing at all', () => {
    for (const value of ['13.5', '4 mg/dL', 'normal', 'S', '', null, undefined]) expect(qualitativeOf(value)).toBeNull();
  });

  it('makes a susceptibility test of the three words of an antibiogram and of no other', () => {
    expect(isSusceptibility(qualitativeOf('Rezistent'))).toBe(true);
    expect(isSusceptibility(qualitativeOf('Intermediar'))).toBe(true);
    expect(isSusceptibility(qualitativeOf('Sensibil'))).toBe(true);
    expect(isSusceptibility(qualitativeOf('Pozitiv'))).toBe(false);
    expect(isSusceptibility(null)).toBe(false);
  });
});
