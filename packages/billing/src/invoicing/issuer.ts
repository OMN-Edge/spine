/**
 * An invoice issuer, as far as Spine uses one: when a payment provider is not the seller of record (Stripe is not; Paddle is, and sends its own invoice), the
 * operator issues the invoice and sends it to ANAF (e-Factura) through a Romanian invoicing service. One issuer is active at a time, behind this interface, so
 * a service can be swapped without touching the billing code. **A prototype**: nothing calls it yet (docs/billing.md, "Invoices").
 *
 * What an invoice is made from is told in Spine's own terms: the amounts are in minor units (cents) as the payment provider reports them, and the buyer is
 * what the provider's checkout collected, since Spine itself keeps no name or address (the records are sealed on the device and the account has only an email).
 */
export interface InvoiceDraft {
  /** The payment provider's id of the payment: the key an invoice is issued under, so a payment delivered twice is invoiced once. */
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
  lines: InvoiceLine[];
  /** Sent to the buyer by the issuer's own mail, with the invoice. */
  sendEmail: boolean;
}

export interface InvoiceLine {
  /** What was sold, as the invoice says it ("Spine Premium, yearly"). */
  name: string;
  /** What was charged for the whole line, in minor units, tax included as the provider charged it. */
  amountMinor: number;
  quantity: number;
  /** The rate of VAT in the amount, in percent: 0 where the operator does not charge it. */
  vatPercent: number;
}

export interface IssuedInvoice {
  /** The issuer's own reference for the invoice, for later calls (where it has one id; otherwise series and number joined). */
  id: string;
  series: string;
  number: string;
  /** Where the issuer shows the invoice (the PDF), as it gave it. */
  link: string | null;
}

/** An invoice that could not be issued; `retry` says whether the same draft may succeed later (a network failure, a limit, the issuer's own fault) or not (it refused the draft). */
export class InvoiceError extends Error {
  constructor(message: string, readonly retry: boolean, readonly status: number | null = null) {
    super(message);
    this.name = 'InvoiceError';
  }
}

export interface InvoiceIssuer {
  readonly id: string;
  /** Whether asking again for the same `draft.id` after an answer was lost is safe: the issuer documents that it replays the first invoice. Where it is not, the caller must record the invoice before anything else can fail, and not ask again for a payment it cannot show was refused. */
  readonly repeatSafe: boolean;
  /** Issues the invoice for a payment, once: asked again for the same `draft.id` it must not make a second. */
  issue(draft: InvoiceDraft): Promise<IssuedInvoice>;
  /** Where the invoice's PDF can be fetched, a link that does not last (the service says for how long). */
  pdfUrl(invoice: Pick<IssuedInvoice, 'id'>): Promise<string>;
  /** Reverses an invoice with a storno (a new invoice that is its exact negative), once: null where the service says it was reversed already. */
  reverse(invoice: Pick<IssuedInvoice, 'id' | 'series' | 'number'>, reason: string): Promise<IssuedInvoice | null>;
  /** Sends an invoice already issued to ANAF's e-Factura, where `issue` did not (or the first try failed): the issuer's own word for how far it got: `code` 0 is the authority still deciding (asked again later), 1 accepted, 2 refused, -1 not applicable. */
  sendToAnaf(invoice: Pick<IssuedInvoice, 'id' | 'series' | 'number'>): Promise<{ sent: boolean; code: number; text: string }>;
}
