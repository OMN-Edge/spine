import { createHmac } from 'node:crypto';
import { getAccountsStore } from 'spine-core/store/index.js';
import { documentOfDraft, renderInvoicePdf, type UblDocument, type ZeroVat } from 'spine-anaf/index.js';
import { bnrRate } from 'spine-billing/invoicing/bnr.js';
import type { InvoicingContext } from 'spine-billing/invoicing/queue.js';
import { logger } from 'spine-core/logger.js';
import { invoiceBrand } from './brand.js';
import { sellerOf } from './seller.js';
import type { InvoicingConfig } from './config.js';

/**
 * Spine's own PDF of an invoice a service issued (Billyou): the service numbers the invoice and sends it to e-Factura, and the document the buyer reads is Spine's, made by the
 * same code as the PDF of Spine's own e-Factura link (`spine-anaf`, `document.ts`). It is made from a copy of the invoice kept when the invoice is made (`invoice_documents`:
 * the buyer, the lines, the date, the number the service gave and the seller as it was then), so the PDF says the same tomorrow whatever the buyer or the seller changes.
 * Where there is no seller saved (`seller.ts`) or the copy could not be kept, there is no copy and the service's own PDF is the one served.
 */
type Active = Extract<InvoicingConfig, { enabled: true }>;

/** The date an invoice is dated by: the day of the payment, never after today (as the service does). */
const dateOf = (paidAt: string, now: number): string => new Date(Math.min(Date.parse(paidAt), now)).toISOString().slice(0, 10);

const zeroVatOf = (config: Active): ZeroVat => {
  if (config.issuer !== 'billyou' || !config.billyou.zeroVat) return { category: 'O' };
  const { taxCategory, vatExemptionCode } = config.billyou.zeroVat;
  return { category: taxCategory, ...(vatExemptionCode ? { exemptionCode: vatExemptionCode } : {}) };
};

/** What the queue calls when a document is made: keeps the copy the PDF is made from. */
export function keepDocument(config: Active, now: () => Date = () => new Date()): NonNullable<InvoicingContext['keep']> {
  return async ({ ref, credit, draft, reverses, issued }) => {
    if (config.issuer !== 'billyou') return;
    const store = getAccountsStore();
    const printed = `${issued.series}-${issued.number}`;
    if (!credit) {
      if (!draft) return;
      const seller = await sellerOf(store);
      if (!seller) return;
      const date = dateOf(draft.paidAt, now().getTime());
      // VAT in another currency is also stated in lei (BR-RO-030); none charged, nothing to state.
      const taxed = draft.lines.some(l => l.vatPercent > 0);
      const rate = taxed && draft.currency.toUpperCase() !== 'RON' ? await bnrRate(draft.currency).catch(err => { logger.warn('the rate for an invoice could not be read', { reason: err instanceof Error ? err.message : String(err) }); return undefined; }) : undefined;
      const document = documentOfDraft({ draft, id: printed, issueDate: date, seller, zeroVat: zeroVatOf(config), rate, note: `Payment ${ref}` });
      await store.billing.keepInvoiceDocument(ref, JSON.stringify(document), now().toISOString());
      return;
    }
    // A credit note is the invoice it reverses, with its own number and the day it was made, naming that invoice.
    const original = reverses ? await store.billing.invoiceDocument(reverses) : null;
    if (!original) return;
    const before = JSON.parse(original) as UblDocument;
    const credited: UblDocument = { ...before, kind: 'credit', id: printed, issueDate: now().toISOString().slice(0, 10), reverses: before.id, note: 'Rambursare' };
    delete credited.rate;
    await store.billing.keepInvoiceDocument(ref, JSON.stringify(credited), now().toISOString());
  };
}

/** The PDF of a kept document, or null where there is none (the service's PDF is served then). */
export async function ownPdf(ref: string): Promise<Buffer | null> {
  const kept = await getAccountsStore().billing.invoiceDocument(ref);
  if (!kept) return null;
  return renderInvoicePdf(JSON.parse(kept) as UblDocument, { brand: invoiceBrand() });
}

/** The key that signs the links to such a PDF: made from the server's session secret, so there is no new secret to keep. */
export const pdfKeyOf = (sessionSecret: string): Buffer => createHmac('sha256', sessionSecret).update('spine-invoice-pdf-links').digest();
