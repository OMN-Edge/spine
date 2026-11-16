import { createHmac } from 'node:crypto';
import type { BillingRepository } from 'spine-core/store/types.js';
import type { EfacturaConfig } from '../config.js';
import { bnrRate } from '../bnr.js';
import { AnafLink } from './anaf.js';
import { efacturaIssuer, signedLink, type EfacturaIssuer } from './issuer.js';

/**
 * Spine's own e-Factura link, as the rest of the server sees it: one door, so the whole of it (the XML, the numbering, the authorisation with ANAF, the PDF) can be
 * lifted into a service of its own later by giving it a small HTTP face; what it asks of the server is the store's six methods named in `ports` below and the
 * settings in `EfacturaConfig`, and nothing else of Spine's. See docs/efactura.md.
 */
export type EfacturaStore = Pick<BillingRepository,
  'efacturaTokens' | 'efacturaSaveTokens' | 'efacturaBeginAuthorisation' | 'efacturaFinishAuthorisation' | 'efacturaReserve' | 'efacturaDocument' | 'efacturaUpdateDocument' | 'efacturaDocuments'>;

export interface Efactura {
  config: EfacturaConfig;
  link: AnafLink;
  issuer: EfacturaIssuer;
  /** The key that signs the links to a PDF, made from the sealing key so there is one secret to keep. */
  pdfKey: Buffer;
}

/** The path under the server that serves a signed PDF link. */
export const PDF_PATH = '/api/billing/invoice-pdf';

export function makeEfactura(config: EfacturaConfig, store: EfacturaStore, extra: { fetcher?: typeof fetch; now?: () => Date } = {}): Efactura {
  const pdfKey = createHmac('sha256', config.key).update('spine-efactura-pdf-links').digest();
  const link = new AnafLink({ mode: config.mode, clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: config.redirectUri, key: config.key, ...extra }, store);
  const issuer = efacturaIssuer({
    seller: config.seller, series: config.series, zeroVat: config.zeroVat,
    exchangeRate: currency => bnrRate(currency),
    pdfLink: id => `${config.publicUrl}${PDF_PATH}/${encodeURIComponent(id)}?t=${signedLink(pdfKey, id, (extra.now ?? (() => new Date()))())}`,
    ...extra,
  }, store, link);
  return { config, link, issuer, pdfKey };
}

export { AnafLink } from './anaf.js';
export type { AnafStatus } from './anaf.js';
export { linkIsValid } from './issuer.js';
export type { EfacturaIssuer } from './issuer.js';
