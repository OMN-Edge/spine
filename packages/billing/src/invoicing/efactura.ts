import type { AnafStore } from 'spine-anaf/index.js';
import { AnafError, makeEfactura, type Efactura as AnafEfactura, type EfacturaIssuer, type AnafConfig } from 'spine-anaf/index.js';
import { bnrRate } from './bnr.js';
import { InvoiceError, type InvoiceIssuer } from './issuer.js';

/**
 * Spine's own e-Factura link as the billing code uses it: the ANAF package (`packages/anaf/`) does the work and throws its own error; this turns it into the one the queue
 * decides by (`InvoiceError`, with the same `retry` and status), and gives the folder the two things that are Spine's: the National Bank's rate and the path a PDF is served at.
 */
export const PDF_PATH = '/api/billing/invoice-pdf';

/** The issuer the queue calls, with the PDF the route serves. */
export type EfacturaForBilling = Omit<AnafEfactura, 'issuer'> & { issuer: InvoiceIssuer & Pick<EfacturaIssuer, 'pdf'> };

/** Every call of `issuer` answers as `InvoiceIssuer` says: an error of the ANAF folder is the same error in the billing code's class. */
function asInvoiceIssuer(issuer: EfacturaIssuer): EfacturaForBilling['issuer'] {
  const wrapped = <A extends unknown[], R>(call: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    try { return await call(...args); } catch (err) { throw err instanceof AnafError ? new InvoiceError(err.message, err.retry, err.status) : err; }
  };
  return {
    id: issuer.id,
    repeatSafe: issuer.repeatSafe,
    issue: wrapped(issuer.issue.bind(issuer)),
    pdfUrl: wrapped(issuer.pdfUrl.bind(issuer)),
    reverse: wrapped(issuer.reverse.bind(issuer)),
    sendToAnaf: wrapped(issuer.sendToAnaf.bind(issuer)),
    pdf: wrapped(issuer.pdf.bind(issuer)),
  };
}

export function openEfactura(config: AnafConfig, store: AnafStore, extra: { fetcher?: typeof fetch; now?: () => Date } = {}): EfacturaForBilling {
  const made = makeEfactura(config, store, { pdfPath: PDF_PATH, exchangeRate: currency => bnrRate(currency), ...extra });
  return { ...made, issuer: asInvoiceIssuer(made.issuer) };
}
