import { getAccountsStore } from 'spine-core/store/index.js';
import { logger } from 'spine-core/logger.js';
import { journalRowOf, type Journal, type JournalRow, type UblDocument } from 'spine-anaf/index.js';
import { bnrRate } from 'spine-billing/invoicing/bnr.js';
import { sellerOf } from './seller.js';

/**
 * The month's summary for the accountant (`packages/anaf/src/journal.ts` draws it): the invoices and credit notes dated in the month, from the documents kept for each, whichever way they
 * were issued: Spine's own e-Factura documents (`efactura_documents`, by their issue date) and the copies kept of a service's invoices (`invoice_documents`, by the date the copy says).
 * An invoice a service made before a seller was saved has no copy and is not listed, so the summary is a list of what Spine can show, and says so on the page that offers it.
 * The rate of an invoice in another currency is the National Bank's for its day (the invoice's own where it states VAT in lei), looked for once for each currency and day.
 */
export type JournalAnswer = { ok: true; journal: Journal } | { ok: false; error: string };

/** `YYYY-MM` of a date, and the first day of the next month. */
const bounds = (month: string): { from: string; to: string } => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return { from: `${month}-01`, to: m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01` };
};
const day = (iso: string): string => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' });
const shifted = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString();

export async function buildJournal(month: string, now: () => Date = () => new Date(), rateOf: typeof bnrRate = bnrRate): Promise<JournalAnswer> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return { ok: false, error: 'the month is YYYY-MM' };
  const { from, to } = bounds(month);
  const store = getAccountsStore();
  const documents: Array<{ doc: UblDocument; anaf: string | null; reference: string | null }> = [];
  for (const d of await store.billing.efacturaDocumentsDatedBetween(from, to)) {
    if (!d.input) continue; // numbered, and waiting for a seller or for its draft
    documents.push({ doc: JSON.parse(d.input) as UblDocument, anaf: d.anaf_state, reference: d.kind === 'credit' ? d.reverses : d.draft_id });
  }
  // A copy is made within days of its date (a retried invoice keeps its payment's day), so ask for a fortnight either side and keep the ones dated in the month.
  for (const k of await store.billing.invoiceDocumentsMadeBetween(shifted(from, -15), shifted(to, 15))) {
    const doc = JSON.parse(k.document) as UblDocument;
    if (doc.issueDate < from || doc.issueDate >= to) continue;
    documents.push({ doc, anaf: null, reference: k.ref.replace(/^storno:/, '').split(':')[0] ?? null });
  }
  const seller = (await sellerOf(store)) ?? documents[0]?.doc.seller ?? null;
  if (!seller) return { ok: false, error: 'no seller is saved, and there is no invoice to take it from' };

  const rates = new Map<string, Promise<number | null>>();
  const rateFor = (doc: UblDocument): Promise<number | null> => {
    const currency = doc.currency.toUpperCase();
    if (currency === 'RON') return Promise.resolve(1);
    const key = `${currency}|${doc.issueDate}`;
    if (!rates.has(key)) rates.set(key, rateOf(currency, fetch, now().getTime(), doc.issueDate).catch(err => { logger.warn('a rate for the month\'s summary could not be read', { reason: err instanceof Error ? err.message : String(err) }); return null; }));
    return rates.get(key)!;
  };
  const rows: JournalRow[] = [];
  for (const { doc, anaf, reference } of documents) rows.push(journalRowOf(doc, { rate: doc.rate ?? await rateFor(doc), anaf, reference }));
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
  return { ok: true, journal: { month, seller, preparedOn: day(now().toISOString()), rows } };
}
