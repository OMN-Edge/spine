import { createHmac, timingSafeEqual } from 'node:crypto';
import { AnafError } from './error.js';
import type { InvoiceDraft, Issuer, IssuedInvoice } from './invoice.js';
import type { DocumentStore, StoredDocument } from './store.js';
import { AnafLink, pdfOf } from './anaf.js';
import { renderInvoicePdf, type DocumentBrand } from './document.js';
import { buildUbl, routeOf, UblError, type UblBuyer, type UblDocument, type UblSeller, type ZeroVat } from './ubl.js';

/**
 * The operator's own invoicing, with no service between it and ANAF: Spine numbers the invoice in the operator's series, writes it as the e-Factura XML, keeps it, and
 * sends it to ANAF with the operator's authorisation (`anaf.ts`). The queue calls it as it calls any issuer: `issue` makes the numbered document, which is only the
 * store's and the XML's, so it is repeat-safe (a payment is numbered once); `sendToAnaf` is the part that talks to ANAF, and is asked again until ANAF has decided.
 * The PDF is made here (`document.ts`) from the stored document, the same one the XML is written from; the Ministry's converter is kept as `pdfByAnaf`, to compare. What this has not got, that a service has: a ledger for the accountant (the documents are kept here, and in the buyer's and the seller's SPV).
 */
export interface EfacturaSettings {
  /** Who the invoices are made out by, read when one is made (it is copied into the document, so a later change leaves an issued invoice as it was); null where none is set. */
  seller: () => Promise<UblSeller | null>;
  /** The series' name ("SPN"); the invoice is printed as "SPN-00001". */
  series: string;
  zeroVat: ZeroVat;
  /** RON for one unit of a currency (the National Bank's), for an invoice that states VAT in another currency. */
  exchangeRate?: (currency: string, date: string) => Promise<number>;
  /** Where the PDF of a document can be fetched from, by id: a link that does not last (the server signs it). */
  pdfLink: (id: string) => string;
  /** The brand the PDF's header shows (its name, site and mark); none, and the header is left out. */
  brand?: DocumentBrand;
  now?: () => Date;
  fetcher?: typeof fetch;
}

type Store = DocumentStore;

export interface EfacturaIssuer extends Issuer {
  /** The PDF of a document, made from the stored document: no request to ANAF. */
  pdf(id: string): Promise<Buffer>;
  /** The PDF as the Ministry's converter makes it from the XML, for the operator to compare. */
  pdfByAnaf(id: string): Promise<Buffer>;
}

const printed = (d: Pick<StoredDocument, 'series' | 'number'>): string => `${d.series}-${String(d.number).padStart(5, '0')}`;
/** The date in Romania, which an invoice is dated by. */
const romanianDate = (d: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bucharest', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

/** What each line of a payment is without its VAT, the lines adding up to the whole's net exactly (the last takes the cent that rounding leaves). */
export function netLines(lines: InvoiceDraft['lines']): UblDocument['lines'] {
  const out: UblDocument['lines'] = [];
  const byRate = new Map<number, number[]>();
  lines.forEach((l, i) => byRate.set(l.vatPercent, [...(byRate.get(l.vatPercent) ?? []), i]));
  const nets = new Array<number>(lines.length).fill(0);
  for (const [percent, indexes] of byRate) {
    const gross = indexes.reduce((sum, i) => sum + lines[i]!.amountMinor, 0);
    const net = percent > 0 ? Math.round((gross * 100) / (100 + percent)) : gross;
    let left = net;
    indexes.forEach((i, n) => {
      const share = n === indexes.length - 1 ? left : Math.round((net * lines[i]!.amountMinor) / (gross || 1));
      nets[i] = share;
      left -= share;
    });
  }
  lines.forEach((l, i) => out.push({ name: l.name, quantity: l.quantity, netMinor: nets[i]!, vatPercent: l.vatPercent }));
  return out;
}

function buyerOf(draft: InvoiceDraft['buyer']): UblBuyer {
  const ro = draft.country.toUpperCase() === 'RO';
  return {
    name: draft.name, country: draft.country,
    ...(draft.address ? { street: draft.address } : {}), ...(draft.city ? { city: draft.city } : {}),
    ...(ro && draft.region ? { county: draft.region } : {}), ...(draft.sector ? { sector: draft.sector } : {}),
    ...(draft.taxId ? { taxId: draft.taxId } : {}), ...(draft.email ? { email: draft.email } : {}),
  };
}

/** The document an invoice is, from a draft, the number a service gave it and the seller: what Spine's own PDF is made from where the service issued the invoice (`kind` is a credit note's, with `reverses` naming the invoice). */
export function documentOfDraft(input: { draft: InvoiceDraft; id: string; issueDate: string; seller: UblSeller; zeroVat: ZeroVat; rate?: number | undefined; note?: string | undefined }): UblDocument {
  const { draft } = input;
  return {
    kind: 'invoice', id: input.id, issueDate: input.issueDate, currency: draft.currency.toUpperCase(), ...(input.rate ? { rate: input.rate } : {}),
    seller: input.seller, buyer: buyerOf(draft.buyer), lines: netLines(draft.lines), zeroVat: input.zeroVat, paid: true, ...(input.note ? { note: input.note } : {}),
  };
}

export function efacturaIssuer(settings: EfacturaSettings, store: Store, link: AnafLink): EfacturaIssuer {
  const now = () => (settings.now ?? (() => new Date()))();
  const fetcher: typeof fetch = (input, init) => (settings.fetcher ?? fetch)(input, init);

  const issued = (d: StoredDocument): IssuedInvoice => ({ id: d.draft_id, series: d.series, number: String(d.number).padStart(5, '0'), link: null });
  const need = async (id: string): Promise<StoredDocument> => {
    const d = await store.efacturaDocument(id);
    if (!d) throw new AnafError(`there is no invoice ${id}`, false);
    return d;
  };
  const written = (input: UblDocument): string => {
    try { return buildUbl(input); } catch (err) {
      // A draft that cannot be written as an invoice (a county missing, a sector, a number with no digit) will not pass by waiting.
      if (err instanceof UblError) throw new AnafError(err.message, false);
      throw err;
    }
  };

  return {
    id: 'efactura',
    repeatSafe: true,

    async issue(draft) {
      const today = romanianDate(now());
      // Dated the day it was paid, never after today.
      const paidDay = romanianDate(new Date(draft.paidAt));
      const issueDate = paidDay > today ? today : paidDay;
      const doc = await store.efacturaReserve(draft.id, 'invoice', settings.series, issueDate, now().toISOString(), null);
      if (doc.xml) return issued(doc);
      const taxed = draft.lines.some(l => l.vatPercent > 0);
      let rate: number | undefined;
      if (taxed && draft.currency.toUpperCase() !== 'RON') {
        if (!settings.exchangeRate) throw new AnafError('an invoice with VAT in another currency needs the National Bank\'s rate', false);
        try { rate = await settings.exchangeRate(draft.currency, doc.issue_date); } catch (err) { throw new AnafError(`the exchange rate could not be read: ${err instanceof Error ? err.message : String(err)}`, true); }
      }
      // No seller yet: the invoice is numbered and waits, and is made once an administrator has saved one.
      const seller = await settings.seller();
      if (!seller) throw new AnafError('no seller is set: an administrator saves it on the invoices page', true);
      const input: UblDocument = {
        kind: 'invoice', id: printed(doc), issueDate: doc.issue_date, currency: draft.currency.toUpperCase(), ...(rate ? { rate } : {}),
        seller, buyer: buyerOf(draft.buyer), lines: netLines(draft.lines), zeroVat: settings.zeroVat, paid: true,
      };
      const xml = written(input);
      await store.efacturaUpdateDocument(draft.id, { xml, input: JSON.stringify(input) }, now().toISOString());
      return issued(doc);
    },

    async pdfUrl(invoice) { return settings.pdfLink(invoice.id); },

    async pdf(id) {
      const d = await need(id);
      if (!d.xml || !d.input) throw new AnafError(`invoice ${id} has no document yet`, true);
      return renderInvoicePdf(JSON.parse(d.input) as UblDocument, { ...(settings.brand ? { brand: settings.brand } : {}), efacturaIndex: d.anaf_index });
    },

    async pdfByAnaf(id) {
      const d = await need(id);
      if (!d.xml) throw new AnafError(`invoice ${id} has no document yet`, true);
      return pdfOf(d.xml, d.kind, fetcher);
    },

    async reverse(invoice, reason) {
      const original = await need(invoice.id);
      if (original.kind !== 'invoice' || !original.input) throw new AnafError(`${invoice.id} is not an invoice that can be reversed`, false);
      const doc = await store.efacturaReserve(`credit:${invoice.id}`, 'credit', settings.series, romanianDate(now()), now().toISOString(), invoice.id);
      if (doc.xml) return issued(doc);
      const before = JSON.parse(original.input) as UblDocument;
      const input: UblDocument = { ...before, kind: 'credit', id: printed(doc), issueDate: doc.issue_date, reverses: before.id, note: reason.slice(0, 300) };
      const xml = written(input);
      await store.efacturaUpdateDocument(doc.draft_id, { xml, input: JSON.stringify(input) }, now().toISOString());
      return issued(doc);
    },

    async sendToAnaf(invoice) {
      const d = await need(invoice.id);
      if (!d.xml || !d.input) throw new AnafError(`${invoice.id} has no document to send`, false);
      const input = JSON.parse(d.input) as UblDocument;
      const route = routeOf(input.buyer);
      // E-Factura is for a buyer in Romania; a buyer abroad has the invoice from the account's history and is nothing to send.
      if (route === 'abroad') {
        if (d.anaf_state !== 'abroad') await store.efacturaUpdateDocument(d.draft_id, { anaf_state: 'abroad' }, now().toISOString());
        return { sent: false, code: -1, text: 'the buyer is outside Romania: e-Factura does not take it' };
      }
      if (d.anaf_state === 'ok') return { sent: true, code: 1, text: '' };

      const stamp = () => now().toISOString();
      let current = d;
      // ANAF refused the file (or never took it) and the operator asks again: the XML is made again from what it was made from, in case the writer has been mended since, and sent as new.
      if (d.anaf_state === 'nok') {
        current = { ...d, xml: written(input), anaf_index: null, anaf_state: null };
        await store.efacturaUpdateDocument(d.draft_id, { xml: current.xml, anaf_index: null, anaf_state: null, anaf_message: null }, stamp());
      }

      if (!current.anaf_index) {
        // ANAF's own check first: a file it says it would refuse is not sent, and says why here and not as a refusal after the upload.
        const checked = await link.validate(current.xml!, current.kind === 'credit' ? 'FCN' : 'FACT1');
        if (checked.result === 'refused') {
          const text = `ANAF's check refused the file: ${checked.message}`;
          await store.efacturaUpdateDocument(d.draft_id, { anaf_state: 'nok', anaf_message: text.slice(0, 1000) }, stamp());
          return { sent: false, code: 2, text };
        }
        const sent = await link.upload(current.xml!, input.seller.cif, current.kind === 'credit' ? 'CN' : 'UBL', route);
        if (!sent.ok) {
          await store.efacturaUpdateDocument(d.draft_id, { anaf_state: 'nok', anaf_message: sent.message.slice(0, 1000) }, stamp());
          return { sent: false, code: 2, text: sent.message };
        }
        await store.efacturaUpdateDocument(d.draft_id, { anaf_index: sent.index, anaf_state: 'sent', anaf_message: null }, stamp());
        return { sent: true, code: 0, text: `uploaded as ${sent.index}` };
      }

      const answer = await link.state(current.anaf_index);
      if (answer.state === 'sent') return { sent: true, code: 0, text: 'ANAF has it and has not decided' };
      if (answer.state === 'rejected') {
        await store.efacturaUpdateDocument(d.draft_id, { anaf_state: 'nok', anaf_message: 'ANAF did not take the file' }, stamp());
        return { sent: false, code: 2, text: 'ANAF did not take the file' };
      }
      if (answer.state === 'ok') {
        // The signed answer is kept: ANAF has it for 60 days. Taken before the document is marked, so a download that fails is asked for again.
        const got = answer.downloadId ? await link.download(answer.downloadId) : null;
        await store.efacturaUpdateDocument(d.draft_id, { anaf_state: 'ok', anaf_message: null, ...(got ? { signed: got.zip.toString('base64') } : {}) }, stamp());
        return { sent: true, code: 1, text: '' };
      }
      const got = answer.downloadId ? await link.download(answer.downloadId) : null;
      const why = (got && AnafLink.errorsFrom(got.files)) || 'ANAF refused the file';
      await store.efacturaUpdateDocument(d.draft_id, { anaf_state: 'nok', anaf_message: why.slice(0, 1000) }, stamp());
      return { sent: false, code: 2, text: why };
    },
  };
}

/** A link to a document's PDF that lasts a while: the id, when it ends, and a signature over both under the server's key. */
export function signedLink(key: Buffer, id: string, now: Date, ttlMs = 10 * 60_000): string {
  const expires = now.getTime() + ttlMs;
  return `${expires}.${createHmac('sha256', key).update(`pdf:${id}:${expires}`).digest('base64url')}`;
}

export function linkIsValid(key: Buffer, id: string, token: string, now: Date): boolean {
  const [expires, signature] = token.split('.');
  if (!expires || !signature || !/^\d+$/.test(expires) || Number(expires) < now.getTime()) return false;
  const want = createHmac('sha256', key).update(`pdf:${id}:${expires}`).digest();
  const got = Buffer.from(signature, 'base64url');
  return got.length === want.length && timingSafeEqual(got, want);
}
