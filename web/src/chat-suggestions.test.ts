import { describe, expect, it } from 'vitest';
import type { TrendName } from './api';
import { suggestionsFor } from './chat-suggestions';

const en = (s: string, v?: Record<string, string | number>) => (v ? s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k])) : s);
const test = (name: string, numeric_count: number, over: Partial<TrendName> = {}): TrendName => ({ canonical: name, name, unit: null, count: numeric_count, numeric_count, latest_value_text: '1.0', latest_taken_on: null, latest_flag: null, ...over });

describe('the questions the chat offers', () => {
  it('name the test with the most numbers, from what the person has', () => {
    const asked = suggestionsFor('timeline', en, [test('Hemoglobin', 1), test('TSH', 4), test('LDL', 2)]);
    expect(asked[0]).toBe('How has my TSH changed over time?');
  });

  it('do not name a test where none has two numbers, and never one the archive may not hold', () => {
    for (const tests of [[], [test('Hemoglobin', 1)], [test('Urine culture', 0, { count: 3, latest_value_text: 'Escherichia coli' })]]) {
      const asked = suggestionsFor('timeline', en, tests as TrendName[]);
      expect(asked[0]).toBe('How have my test results changed over time?');
      expect(asked.join(' ')).not.toMatch(/hemoglobin|cardiolog/i);
    }
  });

  it('are about the document on a document page', () => {
    expect(suggestionsFor('document', en)).toEqual(['Explain this document in plain words', 'Is anything outside the reference range?']);
  });
});
