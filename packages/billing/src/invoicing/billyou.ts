import type { InvoiceDraft, InvoiceIssuer, IssuedInvoice } from './issuer.js';
import { InvoiceError } from './issuer.js';

/**
 * Billyou (billyou.ro, run by Billu SRL), a Romanian invoicing service with an API. What is used is Billyou's own API reference (`openapi-snapshot.json`, as the
 * operator saved it 2026-11-15) and **a run against a sandbox account the same day**, because its public guides disagree with it: the host is
 * `https://app.billyou.ro/api`, the key is the `X-API-Key` header, and an invoice is made from a client's id and a series' id that already exist.
 * What the run showed: a repeated `Idempotency-Key` returns the first invoice (not in the reference, found by trying); `unitPrice` is without VAT; a Romanian
 * client must have a valid CUI or CNP (thirteen zeros are taken for a person who gave none), a client abroad takes "-" for its tax id; a 0% line needs a `taxCategory`; e-Factura is only for a Romanian client (a
 * foreign one's invoice is `not-required`, and asking is refused with `NON_ROMANIAN_CLIENT`); a series' number comes in `serialNumber` ("TEST-00001").
 * The payment is recorded on the invoice (`POST /invoices/{id}/payments`, listed by its `reference`), or Billyou shows it unpaid. A submission accepted by the sandbox's simulated e-Factura was seen on 2026-11-18 (after Billyou gave the account its address); not seen: the sandbox's own mail, and a submission to ANAF's test platform ("Sandbox ANAF", which needs the SPV authorisation).
 */
export interface BillyouSettings {
  apiKey: string;
  /** The id of the series to issue under, as `GET /series` lists it. */
  seriesId: string;
  /** Another host, for a different environment; the API's own by default. */
  baseUrl?: string;
  /** RON for one unit of a currency on a day (ISO date), for an invoice in another currency: Billyou needs it to state the tax in RON and takes no default. */
  exchangeRate?: (currency: string, date: string) => Promise<number>;
  /** How a 0% line is classed where the operator does not charge VAT (EN 16931: 'O' outside scope, 'Z' zero-rated, 'E' exempt with a code, 'AE' reverse charge): the accountant's word, and Billyou refuses a 0% line without it. */
  zeroVat?: { taxCategory: 'O' | 'Z' | 'E' | 'AE'; vatExemptionCode?: string };
  /** For the tests; the global one otherwise. */
  fetcher?: typeof fetch;
}

const BASE = 'https://app.billyou.ro/api';

/** A submission to e-Factura as Billyou tells it: `pending`, `processing` and `uploaded` are ANAF still deciding, `validated` is accepted, `rejected` needs the invoice corrected, `failed` did not reach ANAF. */
interface Submission {
  status?: string;
  error?: { message?: string; details?: { errorCode?: string; translatedErrors?: Array<{ titleEn?: string; fixEn?: string }> } };
  validationErrors?: Array<{ message?: string }>;
}

/** What a submission's state means for the invoice, in the codes the other issuers use (0 still being decided, 1 accepted, 2 refused). */
async function outcomeOf(sub: Submission | undefined, submitAgain: () => Promise<void>): Promise<{ sent: boolean; code: number; text: string }> {
  const code = sub?.error?.details?.errorCode ?? '';
  const why = [sub?.error?.message, ...(sub?.error?.details?.translatedErrors ?? []).map(t => t.fixEn), ...(sub?.validationErrors ?? []).map(v => v.message)].filter(Boolean).join('; ');
  switch (sub?.status) {
    case 'validated': return { sent: true, code: 1, text: why };
    case 'pending': case 'processing': case 'uploaded': return { sent: true, code: 0, text: sub.status };
    case 'rejected': return { sent: false, code: 2, text: why };
    case 'failed':
      // ANAF's own faults pass: ask for the upload again. The daily limit, and an authorisation that ended or has no SPV rights, wait for the next day or for the operator.
      if (['ANAF_TEMPORARY_ERROR', 'ANAF_TECHNICAL_ERROR', 'EFACTURA_UPLOAD_FAILED', 'EFACTURA_UPLOAD_ERROR'].includes(code)) { await submitAgain(); return { sent: true, code: 0, text: `${code}: submitted again` }; }
      if (['ANAF_DAILY_LIMIT', 'SPV_TOKEN_UNAUTHORIZED', 'ANAF_NO_SPV_RIGHTS', 'ANAF_NO_SPV_RIGHTS_FOR_CIF'].includes(code)) throw new InvoiceError(`Billyou: ${code}: ${why || 'e-Factura cannot take it for now'}`, true);
      if (code === 'ANAF_DUPLICATE_UPLOAD') return { sent: true, code: 1, text: 'ANAF already has it' };
      return { sent: false, code: 2, text: `${code ? `${code}: ` : ''}${why}` };
    default: return { sent: false, code: -1, text: sub?.status ?? '' };
  }
}

interface BillyouAnswer { success?: boolean; errorCode?: string; message?: string; data?: Record<string, unknown> }

export function billyouIssuer(settings: BillyouSettings): InvoiceIssuer {
  // Looked up at each call, so a process that swaps `fetch` (a test) is not held to the one there was when the adapter was made.
  const fetcher: typeof fetch = (input, init) => (settings.fetcher ?? fetch)(input, init);

  async function call(method: 'GET' | 'POST', path: string, body?: unknown, idempotencyKey?: string): Promise<BillyouAnswer> {
    let res: Response;
    try {
      res = await fetcher(`${(settings.baseUrl ?? BASE).replace(/\/$/, '')}${path}`, {
        method,
        signal: AbortSignal.timeout(10_000),
        headers: { 'x-api-key': settings.apiKey, 'content-type': 'application/json', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw new InvoiceError(`Billyou could not be reached: ${err instanceof Error ? err.message : String(err)}`, true);
    }
    const answer = (await res.json().catch(() => ({}))) as BillyouAnswer;
    if (!res.ok || answer.success === false) {
      // A limit or the service's own fault may pass, and so may the connection to ANAF: it ends from time to time and the operator renews it in Billyou's settings (`SPV_TOKEN_UNAUTHORIZED`), after which the same invoice goes through. A refused draft (a tax id, a county, a VAT class) will not.
      throw new InvoiceError(`Billyou answered ${res.status}${answer.errorCode ? ` ${answer.errorCode}` : ''}: ${answer.message ?? 'no reason given'}`, res.status === 429 || res.status >= 500 || answer.errorCode === 'SPV_TOKEN_UNAUTHORIZED', res.status);
    }
    return answer;
  }

  /** The client record for the buyer: the one already holding the same email, name and tax id, else a new one. (A search by email also returns others, so what comes back is checked.) */
  async function client(buyer: InvoiceDraft['buyer']): Promise<string> {
    // A person gives no tax id: abroad it is "-"; in Romania thirteen zeros, which Billyou takes for an individual who gave no CNP (the sandbox accepted it; ANAF's own way for e-Factura is the accountant's to confirm).
    const taxId = buyer.taxId ?? (buyer.country.toUpperCase() === 'RO' ? '0000000000000' : '-');
    const found = (await call('GET', `/clients?search=${encodeURIComponent(buyer.email)}`)).data as unknown as Array<{ _id: string; name: string; taxId: string; contactEmails?: Array<{ email: string }> }> | undefined;
    const clients = Array.isArray(found) ? found : [];
    // A tax id a company gave is one company however its contact is written, and Billyou refuses a second client under it (`CLIENT_DUPLICATE_TAX_ID`, 2026-11-18): the holder of it is the client. The sandbox does not apply the search (every client comes back), so what comes back is always checked.
    const company = buyer.taxId ? clients.find(c => c.taxId.replace(/\s/g, '').toUpperCase() === taxId.replace(/\s/g, '').toUpperCase()) : undefined;
    const same = company ?? clients.find(c => c.name.trim().toLowerCase() === buyer.name.trim().toLowerCase() && c.taxId === taxId && c.contactEmails?.some(e => e.email.toLowerCase() === buyer.email.toLowerCase()));
    if (same) return same._id;
    const made = await call('POST', '/clients', {
      name: buyer.name,
      taxId,
      address: { ...(buyer.address ? { street: buyer.address } : {}), city: buyer.city ?? buyer.region ?? '-', county: buyer.region ?? buyer.city ?? '-', ...(buyer.sector ? { sector: buyer.sector } : {}), country: buyer.country.toUpperCase() },
      contactEmails: [buyer.email],
    });
    const id = (made.data as { _id?: string } | undefined)?._id;
    if (!id) throw new InvoiceError('Billyou made no client', false);
    return id;
  }

  /** Records what the buyer paid on the invoice, once: a payment with the same reference is not recorded again. */
  async function recordPayment(invoiceId: string, draft: InvoiceDraft, exchangeRate: number | undefined): Promise<void> {
    const path = `/invoices/${encodeURIComponent(invoiceId)}/payments`;
    const listed = (await call('GET', path)).data as { data?: Array<{ reference?: string }> } | undefined;
    if (listed?.data?.some(p => p.reference === draft.id)) return;
    await call('POST', path, {
      amount: draft.lines.reduce((sum, l) => sum + l.amountMinor, 0) / 100,
      paymentDate: draft.paidAt, paymentMethod: 'card', currency: draft.currency.toUpperCase(),
      ...(exchangeRate === undefined ? {} : { exchangeRate }), reference: draft.id,
    });
  }

  return {
    id: 'billyou',
    // Tried: the same key twice made one invoice.
    repeatSafe: true,

    async issue(given: InvoiceDraft): Promise<IssuedInvoice> {
      // Billyou refuses a date after today in Bucharest (`INVOICE_DATE_IN_FUTURE`): a payment time that is ahead of this clock (a skewed clock, a test clock) is dated now.
      const draft = { ...given, paidAt: new Date(Math.min(Date.parse(given.paidAt), Date.now())).toISOString() };
      const currency = draft.currency.toUpperCase();
      const date = draft.paidAt.slice(0, 10);
      let exchangeRate: number | undefined;
      if (currency !== 'RON') {
        if (!settings.exchangeRate) throw new InvoiceError(`An invoice in ${currency} needs the day's rate in RON, and none was given`, false);
        exchangeRate = await settings.exchangeRate(currency, date);
      }
      const clientId = await client(draft.buyer);
      const made = await call('POST', '/invoices', invoiceBody(settings, draft, clientId, exchangeRate), draft.id);
      const { invoiceId, serialNumber } = (made.data ?? {}) as { invoiceId?: string; serialNumber?: string };
      if (!invoiceId || !serialNumber) throw new InvoiceError('Billyou answered with no invoice', false);
      // The buyer paid before the invoice existed (the provider took the money), so the invoice is recorded as paid. If this fails the invoice stands and the attempt is
      // told to be repeated: a repeat finds the same invoice (the key) and the payment is not recorded twice (it is looked for by the payment's reference first).
      await recordPayment(invoiceId, draft, exchangeRate);
      let link: string | null = null;
      if (draft.sendEmail) {
        // The invoice exists whatever happens to the mail; its link is what a mail would have carried. Billyou refused the mail to a client's own address until it was added to the contacts in the same call (`EMAIL_NOT_AUTHORIZED`).
        link = await call('POST', `/invoices/${invoiceId}/email`, { to: draft.buyer.email, subject: `Factura ${serialNumber}`, body: 'Va transmitem factura.', language: 'ro', addToContacts: true })
          .then(a => (a.data as { shareLink?: string } | undefined)?.shareLink ?? null).catch(() => null);
      }
      const cut = serialNumber.lastIndexOf('-');
      return { id: invoiceId, series: cut < 0 ? '' : serialNumber.slice(0, cut), number: serialNumber.slice(cut + 1), link };
    },

    async pdfUrl(invoice) {
      const answer = await call('GET', `/invoices/${encodeURIComponent(invoice.id)}/pdf`);
      const url = (answer.data as { downloadUrl?: string } | undefined)?.downloadUrl;
      if (!url || !/^https:\/\//.test(url)) throw new InvoiceError('Billyou gave no address for the PDF', false);
      return url;
    },

    async reverse(invoice, reason) {
      let made: BillyouAnswer;
      try {
        made = await call('POST', `/invoices/${encodeURIComponent(invoice.id)}/storno`, { reason: reason.slice(0, 500) });
      } catch (err) {
        // "The invoice has already been reversed" (409): an earlier attempt did it, and a second is refused.
        if (err instanceof InvoiceError && err.status === 409) return null;
        throw err;
      }
      const { invoiceId, serialNumber } = (made.data ?? {}) as { invoiceId?: string; serialNumber?: string };
      if (!invoiceId || !serialNumber) throw new InvoiceError('Billyou answered with no storno', false);
      const cut = serialNumber.lastIndexOf('-');
      return { id: invoiceId, series: cut < 0 ? '' : serialNumber.slice(0, cut), number: serialNumber.slice(cut + 1), link: null };
    },

    async sendToAnaf(invoice) {
      // Billyou's submission is asynchronous (the sandbox's mock answers at once): read what there is before submitting, since a second submission of an invoice ANAF holds is refused.
      const id = encodeURIComponent(invoice.id);
      let submission: Submission | undefined;
      try {
        submission = (await call('GET', `/efactura/submissions/${id}`)).data as Submission | undefined;
      } catch (err) {
        if (!(err instanceof InvoiceError && err.status === 404)) throw err;
      }
      if (!submission) {
        try {
          submission = (await call('POST', `/invoices/${id}/efactura/submissions`, {})).data as Submission | undefined;
        } catch (err) {
          // A buyer abroad is not sent to e-Factura: that is an answer, not a failure.
          if (err instanceof InvoiceError && err.message.includes('NON_ROMANIAN_CLIENT')) return { sent: false, code: -1, text: 'not required: the buyer is not Romanian' };
          throw err;
        }
      }
      return outcomeOf(submission, async () => { await call('POST', `/efactura/submissions/${id}/retry`, {}); });
    },
  };
}

/** The body Billyou's invoice call takes, from a draft and the buyer's client id. Exported so the mapping can be read and tested without a request. */
export function invoiceBody(settings: BillyouSettings, draft: InvoiceDraft, clientId: string, exchangeRate?: number): Record<string, unknown> {
  return {
    clientId,
    seriesId: settings.seriesId,
    issueDate: draft.paidAt.slice(0, 10),
    currency: draft.currency.toUpperCase(),
    ...(exchangeRate === undefined ? {} : { exchangeRate }),
    services: draft.lines.map(line => ({
      // Billyou cuts a name at 100 characters (an ANAF rule).
      description: line.name.slice(0, 100),
      quantity: line.quantity,
      // `unitPrice` is without VAT; the provider's amount is what the buyer paid, tax in it. Four decimals, so the total on the invoice stays at the cent that was paid.
      unitPrice: Math.round((line.amountMinor / line.quantity / 100 / (1 + line.vatPercent / 100)) * 10_000) / 10_000,
      unitOfMeasure: 'buc',
      vatRate: line.vatPercent,
      ...(line.vatPercent === 0 && settings.zeroVat ? settings.zeroVat : {}),
    })),
    notes: `Plata ${draft.id}`,
    language: 'ro',
  };
}
