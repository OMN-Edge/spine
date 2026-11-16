import { createHmac } from 'node:crypto';
import { AnafLink } from './anaf.js';
import { efacturaIssuer, signedLink, type EfacturaIssuer } from './issuer.js';
import type { UblSeller, ZeroVat } from './ubl.js';
import type { AnafStore } from './store.js';

/**
 * The ANAF link, as the rest of the server sees it: one door (S15). Behind it are the authorisation with ANAF (OAuth with the operator's qualified certificate, the tokens and
 * their refresh, sealed), e-Factura (the XML, the numbering, the upload, the answer, the PDF) and the checks and calls that go with them. What it asks of the server is the
 * store's methods in `store.ts`, the settings below and, from the caller, the day's exchange rate and where a PDF is served; it names nothing else of Spine's, so it can be lifted
 * into a package, and then a service, with a small HTTP face (docs/architecture/packages.md, docs/efactura.md).
 */
export interface AnafConfig {
  /** ANAF's test platform or the real one: a test run needs the same sign-in and certificate. */
  mode: 'test' | 'prod';
  clientId: string;
  clientSecret: string;
  /** The address ANAF sends the browser back to once the operator has signed in with the certificate (registered with the application at ANAF). */
  redirectUri: string;
  /** The 32 bytes that seal ANAF's tokens in the store. */
  key: Buffer;
  seller: UblSeller;
  series: string;
  zeroVat: ZeroVat;
  /** The address the host is served from, for the links to an invoice's PDF. */
  publicUrl: string;
}

export interface Efactura {
  config: AnafConfig;
  link: AnafLink;
  issuer: EfacturaIssuer;
  /** The key that signs the links to a PDF, made from the sealing key so there is one secret to keep. */
  pdfKey: Buffer;
}

export interface EfacturaExtras {
  /** The path under the host that serves a signed PDF link (no trailing slash). */
  pdfPath: string;
  /** RON for one unit of a currency, on a date: for an invoice that states VAT in another currency. */
  exchangeRate?: (currency: string, date: string) => Promise<number>;
  /** For the tests; the global one otherwise. */
  fetcher?: typeof fetch;
  now?: () => Date;
}

export function makeEfactura(config: AnafConfig, store: AnafStore, extra: EfacturaExtras): Efactura {
  const { pdfPath, exchangeRate, ...rest } = extra;
  const pdfKey = createHmac('sha256', config.key).update('spine-efactura-pdf-links').digest();
  const link = new AnafLink({ mode: config.mode, clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: config.redirectUri, key: config.key, ...rest }, store);
  const issuer = efacturaIssuer({
    seller: config.seller, series: config.series, zeroVat: config.zeroVat,
    ...(exchangeRate ? { exchangeRate } : {}),
    pdfLink: id => `${config.publicUrl}${pdfPath}/${encodeURIComponent(id)}?t=${signedLink(pdfKey, id, (rest.now ?? (() => new Date()))())}`,
    ...rest,
  }, store, link);
  return { config, link, issuer, pdfKey };
}

export { AnafLink } from './anaf.js';
export type { AnafStatus, AnafSettings } from './anaf.js';
export { AnafError } from './error.js';
export { linkIsValid } from './issuer.js';
export type { EfacturaIssuer } from './issuer.js';
export type { InvoiceDraft, IssuedInvoice, Issuer } from './invoice.js';
export type { AnafStore, AnafTokens, StoredDocument, DocumentPatch, DocumentKind } from './store.js';
export type { UblSeller, ZeroVat } from './ubl.js';
