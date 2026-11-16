/**
 * What an invoice is made from, and what the issuer answers, in this folder's own words. They are the same shape as the billing code's (`billing/invoicing/issuer.ts`), which
 * is how that code uses this one with no conversion (checked by the compiler where `queue.ts` hands the issuer over), and they are written here so this folder names nothing
 * of Spine's. The amounts are in minor units, as the payment provider charged them.
 */
export interface InvoiceDraft {
  /** The key an invoice is issued under, so a payment delivered twice is invoiced once. */
  id: string;
  /** When it was paid (ISO). */
  paidAt: string;
  currency: string;
  buyer: {
    name: string;
    email: string;
    /** Two-letter country, as the checkout collected it. */
    country: string;
    city?: string;
    /** The county or state, as the buyer gave it (the code of a Romanian county). */
    region?: string;
    /** Bucharest's sector (1 to 6), which an invoice to an address there needs. */
    sector?: string;
    address?: string;
    /** The tax id a company gave at checkout, if any: its presence makes the buyer a company (B2B). */
    taxId?: string;
  };
  lines: Array<{
    name: string;
    /** What was charged for the whole line, tax included as the provider charged it. */
    amountMinor: number;
    quantity: number;
    /** The rate of VAT in the amount, in percent: 0 where the seller does not charge it. */
    vatPercent: number;
  }>;
  /** Whether the issuer mails the buyer; this one does not, and ignores it. */
  sendEmail: boolean;
}

export interface IssuedInvoice {
  id: string;
  series: string;
  number: string;
  link: string | null;
}

export interface Issuer {
  readonly id: string;
  readonly repeatSafe: boolean;
  issue(draft: InvoiceDraft): Promise<IssuedInvoice>;
  pdfUrl(invoice: Pick<IssuedInvoice, 'id'>): Promise<string>;
  reverse(invoice: Pick<IssuedInvoice, 'id' | 'series' | 'number'>, reason: string): Promise<IssuedInvoice | null>;
  /** `code` 0 is ANAF still deciding (asked again later), 1 accepted, 2 refused, -1 nothing to send. */
  sendToAnaf(invoice: Pick<IssuedInvoice, 'id' | 'series' | 'number'>): Promise<{ sent: boolean; code: number; text: string }>;
}
