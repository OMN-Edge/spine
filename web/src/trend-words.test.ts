import { describe, expect, it } from 'vitest';
import { groupOf, unitWords, valueWords } from './trend-words';

/** What the trends say in the reader's language, and which list a test is on (T-18). */
const german = (s: string) => ({ Sensitive: 'Empfindlich', Resistant: 'Resistent', 'per field': 'pro Feld' }[s] ?? s);
const english = (s: string) => s;

describe('a value in the reader’s language', () => {
  it('turns the lab’s Romanian word into the reader’s, and leaves a number as printed', () => {
    expect(valueWords('Sensibil', german)).toBe('Empfindlich');
    expect(valueWords('Rezistent', german)).toBe('Resistent');
    expect(valueWords('Sensibil', english)).toBe('Sensitive');
    expect(valueWords('13.5', english)).toBe('13.5');
    expect(valueWords('slightly cloudy', english)).toBe('slightly cloudy');
  });

  it('turns the Romanian words inside a unit into the reader’s: UFC is CFU and /câmp is per field', () => {
    expect(unitWords('UFC/mL', english)).toBe('CFU/mL');
    expect(unitWords('/câmp', german)).toBe('pro Feld');
    expect(unitWords('/câmp', english)).toBe('per field');
    expect(unitWords('g/dL', english)).toBe('g/dL');
  });
});

describe('where a test is listed', () => {
  const name = (count: number, numeric: number, latest: string) => ({ count, numeric_count: numeric, latest_value_text: latest });

  it('is the trends only with two numbers or more', () => {
    expect(groupOf(name(5, 5, '13.5'))).toBe('trends');
    expect(groupOf(name(2, 2, '4'))).toBe('trends');
    expect(groupOf(name(1, 1, '13.5'))).toBe('single');
  });

  it('is the susceptibility tests for an antibiogram’s words', () => {
    expect(groupOf(name(1, 0, 'Sensibil'))).toBe('susceptibility');
    expect(groupOf(name(3, 0, 'Rezistent'))).toBe('susceptibility');
  });

  it('is the single results for a value that is not a number and not one of those', () => {
    expect(groupOf(name(1, 0, 'Pozitiv'))).toBe('single');
    expect(groupOf(name(4, 0, 'clear'))).toBe('single');
  });
});
