import { isSusceptibility, qualitativeOf, type Qualitative } from 'spine-core/qualitative';
import { msg } from './i18n';
import type { TrendName } from './api';

type Translate = (english: string) => string;

/** The English words of the qualitative values (`core/src/qualitative.ts`), so each follows the reader's language. */
export const QUALITATIVE_NAMES: Record<Qualitative, string> = {
  sensitive: msg('Sensitive'), intermediate: msg('Intermediate'), resistant: msg('Resistant'), positive: msg('Positive'), negative: msg('Negative'), absent: msg('Absent'), present: msg('Present'),
};

/** A value as the reader's language says it: a qualitative word in their language, any other value as printed. */
export function valueWords(text: string, t: Translate): string {
  const key = qualitativeOf(text);
  return key ? t(QUALITATIVE_NAMES[key]) : text;
}

/** The Romanian words that appear inside units of measurement: "UFC/mL" is CFU/mL and "/câmp" is "per field". The number and the rest of the unit are as printed. */
export function unitWords(unit: string, t: Translate): string {
  return unit
    .replace(/\bUFC\b/g, 'CFU')
    .replace(/\s*\/\s*c[aâ]mp\b/gi, ` ${t('per field')}`)
    .trim();
}

export type TestGroup = 'trends' | 'susceptibility' | 'single';

/** Where a test is listed: a trend needs two numbers; an antibiogram's words are a susceptibility test; anything else with one value, or with values that are not numbers, is a single result. */
export function groupOf(n: Pick<TrendName, 'count' | 'numeric_count' | 'latest_value_text'>): TestGroup {
  if (n.numeric_count >= 2) return 'trends';
  return isSusceptibility(qualitativeOf(n.latest_value_text)) ? 'susceptibility' : 'single';
}
