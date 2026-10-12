import type { ExtractionResult, MeasurementFlag } from '../types.js';

/**
 * What a model reads off a lab sheet is text: "13,5", "<0.5", "H", "12 - 16". These turn it into
 * what a chart needs, without rejecting a document for the way one value was written.
 */

/**
 * A plain number, or null. Romanian reports write the decimal comma ("13,5"), and some
 * write a thousands separator ("1.234,5" or "1 234"). A comparison ("<0.5") or a word
 * ("pozitiv") is not a number: it stays as text and is not drawn on a chart.
 */
export function parseNumber(text: string | null | undefined): number | null {
  if (text == null) return null;
  let t = text.trim().replace(/\s+/g, '').replace(/^\+/, '');
  if (!/^-?[\d.,]+$/.test(t) || !/\d/.test(t)) return null;

  const comma = t.lastIndexOf(',');
  const dot = t.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    // Both: whichever comes last is the decimal mark, the other groups thousands.
    t = comma > dot ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (comma >= 0) {
    // One comma: a decimal mark ("13,5"), or a thousands group ("1,234") if exactly three digits follow.
    t = /,\d{3}$/.test(t) && t.split(',').length === 2 && t.indexOf(',') > 0 && !/^0,/.test(t) ? t.replace(',', '') : t.replace(',', '.');
  } else if ((t.match(/\./g) ?? []).length > 1) {
    t = t.replace(/\./g, ''); // "1.234.567"
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const HIGH = new Set(['h', 'high', 'hi', '↑', '↑↑', 'crescut', 'ridicat', 'peste', '+', '*h']);
const LOW = new Set(['l', 'low', 'lo', '↓', '↓↓', 'scazut', 'scăzut', 'sub', '-', '*l']);
const NORMAL = new Set(['n', 'normal', 'ok', 'wnl', 'in limite', 'în limite']);

/**
 * Low, high or normal. Computed from the value and the printed range when all three are
 * numbers, since arithmetic is more reliable than a model's reading of a margin mark; the
 * model's flag is used when they are not.
 */
export function flagFor(
  value: number | null,
  low: number | null,
  high: number | null,
  printed: string | null | undefined,
): MeasurementFlag | null {
  if (value !== null && (low !== null || high !== null)) {
    if (low !== null && value < low) return 'low';
    if (high !== null && value > high) return 'high';
    return 'normal';
  }
  const word = (printed ?? '').trim().toLowerCase();
  if (HIGH.has(word)) return 'high';
  if (LOW.has(word)) return 'low';
  if (NORMAL.has(word)) return 'normal';
  return null;
}

/** The same test under one name: lower case, one space between words. */
export function canonicalName(canonical: string | null | undefined, name: string): string {
  const pick = (canonical ?? '').trim() || name;
  return pick.toLowerCase().replace(/\s+/g, ' ').trim();
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
export const validDay = (text: string | null | undefined): string | null =>
  text && ISO_DAY.test(text) && !Number.isNaN(Date.parse(text)) ? text : null;

/** A month alone ("03.2026" on a report): `YYYY-MM`. Charted at the start of that month. */
const ISO_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const validMonth = (text: string | null | undefined): string | null => (text && ISO_MONTH.test(text) ? text : null);

/** The date a value was taken, as precisely as it was printed: a day, else a month, else nothing. */
export const validWhen = (text: string | null | undefined): string | null => validDay(text) ?? validMonth(text);

export interface NormalisedMeasurement {
  name: string;
  canonical: string;
  value_text: string;
  value_num: number | null;
  unit: string | null;
  ref_low: number | null;
  ref_high: number | null;
  flag: MeasurementFlag | null;
  taken_on: string | null;
  source_snippet: string;
  page_number: number;
  confidence: number;
}

/** A model's measurement as it will be stored. A row with no name or no value is dropped. */
export function normaliseMeasurements(
  measurements: ExtractionResult['measurements'],
  documentDate: string | null,
): NormalisedMeasurement[] {
  const out: NormalisedMeasurement[] = [];
  for (const m of measurements) {
    const name = m.name.trim();
    const valueText = m.value.trim();
    if (!name || !valueText) continue;

    const value = parseNumber(valueText);
    const low = parseNumber(m.ref_low);
    const high = parseNumber(m.ref_high);
    out.push({
      name,
      canonical: canonicalName(m.canonical, name),
      value_text: valueText,
      value_num: value,
      unit: m.unit?.trim() || null,
      ref_low: low,
      ref_high: high,
      flag: flagFor(value, low, high, m.flag),
      // The row's own date if it has a real one, otherwise the document's.
      taken_on: validWhen(m.date) ?? documentDate,
      source_snippet: m.source_snippet,
      page_number: m.page_number,
      confidence: m.confidence,
    });
  }
  return out;
}
