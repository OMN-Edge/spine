import type { TrendName } from './api';
import { groupOf } from './trend-words';

type Say = (english: string, values?: Record<string, string | number>) => string;

/**
 * The questions the chat offers outside a document. They are asked of what the person has: the test with the most numbers is the one whose change is worth asking about, and
 * nothing here names a specialty or a test the archive may not hold (a person with no hemoglobin result was offered one, and the answer was "nothing found").
 */
export function suggestionsFor(page: string, t: Say, tests: TrendName[] = []): string[] {
  if (page === 'document') return [t('Explain this document in plain words'), t('Is anything outside the reference range?')];
  const followed = tests.filter(n => groupOf(n) === 'trends').sort((a, b) => b.numeric_count - a.numeric_count || a.name.localeCompare(b.name))[0];
  return [
    followed ? t('How has my {test} changed over time?', { test: followed.name }) : t('How have my test results changed over time?'),
    t('What did my latest consultation ask for, and where are the results?'),
    t('Prepare a link to share my latest visit and its tests'),
  ];
}
