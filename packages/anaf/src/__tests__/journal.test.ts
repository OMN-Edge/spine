import { describe, expect, it } from 'vitest';
import { csvText, journalByCountry, journalCsv, journalTotals, monthName, periodName, renderJournalPdf, type Journal, type JournalRow } from '../journal.js';

/** The month's summary (`journal.ts`): the cells a spreadsheet must not run, the totals, and a PDF that goes on to a second page. */
const row = (over: Partial<JournalRow> = {}): JournalRow => ({
  kind: 'invoice', number: 'SPN-00001', date: '2026-11-05', buyer: 'Ion Popescu', country: 'RO', taxId: '', currency: 'EUR', vatPercent: 0, netMinor: 1190, vatMinor: 0, grossMinor: 1190,
  rate: 5, ronMinor: 5950, reverses: null, reference: null, anaf: null, ...over,
});
const journal = (rows: JournalRow[]): Journal => ({ period: '2026-11', preparedOn: '2026-12-01', seller: { name: 'Omni Edge SRL', cif: '12345678', street: 'Str. Exemplului 1', city: 'Sector 1', postalCode: '010101' }, rows });

describe('a cell of the file', () => {
  it('is quoted where it holds the separator, a quote or a line break, and a formula is made a text by a single quote', () => {
    expect(csvText('Ion Popescu')).toBe('Ion Popescu');
    expect(csvText('Popescu; Ion')).toBe('"Popescu; Ion"');
    expect(csvText('a "b"')).toBe('"a ""b"""');
    for (const formula of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx']) expect(csvText(formula).replace(/^"/, '')).toMatch(/^'/);
  });
});

describe('the totals of a month', () => {
  it('are kept apart by currency, count invoices and credit notes, and have no total in lei where one row has no rate', () => {
    const totals = journalTotals([row(), row({ kind: 'credit', netMinor: -1190, grossMinor: -1190, ronMinor: -5950 }), row({ currency: 'USD', rate: null, ronMinor: null })]);
    expect(totals).toEqual([
      { currency: 'EUR', invoices: 1, credits: 1, netMinor: 0, vatMinor: 0, grossMinor: 0, ronMinor: 0 },
      { currency: 'USD', invoices: 1, credits: 0, netMinor: 1190, vatMinor: 0, grossMinor: 1190, ronMinor: null },
    ]);
  });
});

describe('the sums by country and rate', () => {
  it('are kept apart by the buyer\u2019s country, the rate and the currency, credit notes taken off, the way the One Stop Shop declaration asks', () => {
    const rows = [
      row({ country: 'DE', vatPercent: 19, netMinor: 1000, vatMinor: 190, grossMinor: 1190 }), row({ country: 'DE', vatPercent: 19, netMinor: 1000, vatMinor: 190, grossMinor: 1190 }),
      row({ kind: 'credit', country: 'DE', vatPercent: 19, netMinor: -1000, vatMinor: -190, grossMinor: -1190 }), row({ country: 'FR', vatPercent: 20, netMinor: 500, vatMinor: 100, grossMinor: 600 }),
      row({ country: 'RO', vatPercent: 21, netMinor: 1000, vatMinor: 210, grossMinor: 1210 }),
    ];
    expect(journalByCountry(rows)).toEqual([
      { country: 'DE', vatPercent: 19, currency: 'EUR', documents: 3, netMinor: 1000, vatMinor: 190, grossMinor: 1190 },
      { country: 'FR', vatPercent: 20, currency: 'EUR', documents: 1, netMinor: 500, vatMinor: 100, grossMinor: 600 },
      { country: 'RO', vatPercent: 21, currency: 'EUR', documents: 1, netMinor: 1000, vatMinor: 210, grossMinor: 1210 },
    ]);
  });
});

describe('the file', () => {
  it('has the mark, the header and one line for each document, and no line of totals', () => {
    const text = journalCsv(journal([row(), row({ number: 'SPN-00002' })]));
    expect(text.startsWith('﻿Tip;Număr;')).toBe(true);
    expect(text.trim().split('\r\n')).toHaveLength(3);
    expect(text).not.toMatch(/^Total/m);
  });

  it('names the month or the quarter in Romanian', () => {
    expect(monthName('2026-11')).toBe('noiembrie 2026');
    expect(periodName('2026-Q4')).toBe('trimestrul 4 2026');
    expect(periodName('2026-11')).toBe('noiembrie 2026');
  });
});

describe('the PDF', () => {
  it('is a PDF for a month with nothing, and goes on to a second page when the lines do not fit', async () => {
    const pages = (pdf: Buffer): number => Number(/\/Count (\d+)/.exec(pdf.toString('latin1'))?.[1]);
    const empty = await renderJournalPdf(journal([]));
    expect(empty.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pages(empty)).toBe(1);
    const many = await renderJournalPdf(journal(Array.from({ length: 60 }, (_, i) => row({ number: `SPN-${String(i + 1).padStart(5, '0')}` }))));
    expect(pages(many)).toBeGreaterThan(1);
  });
});
