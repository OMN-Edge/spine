import { getAccountsStore } from 'spine-core/store/index.js';
import { logger } from 'spine-core/logger.js';
import { billyouIssuer } from 'spine-billing/invoicing/billyou.js';
import { bnrRate } from 'spine-billing/invoicing/bnr.js';
import { openEfactura, type EfacturaForBilling as Efactura } from 'spine-billing/invoicing/efactura.js';
import type { InvoiceIssuer } from 'spine-billing/invoicing/issuer.js';
import { processInvoice, reverseRefunded as reverse, type InvoicingContext } from 'spine-billing/invoicing/queue.js';
import { billingProvider, type Enabled } from '../provider.js';
import { loadBillingConfig } from '../config.js';
import '../host.js';
import { invoiceBrand } from './brand.js';
import { invoiceReadyMail } from '../invoice-mail.js';
import { getMailer } from '../../mail/index.js';
import { loadInvoicingConfig, type InvoicingConfig } from './config.js';
import { keepDocument } from './own-pdf.js';

/**
 * The queue of invoices (`spine-billing`, `invoicing/queue.ts`) with Spine's settings: which issuer the operator named, made once for the process, the context a pass runs in, and the
 * entry points the payment route and the hourly job call. What the queue does with an invoice is the package's.
 */
export * from 'spine-billing/invoicing/queue.js';
type Active = Extract<InvoicingConfig, { enabled: true }>;

/** The service the operator named, made once for the process (a token is kept between calls). */
let made: { key: string; issuer: InvoiceIssuer; efactura: Efactura | null } | null = null;

function build(config: Active): NonNullable<typeof made> {
  const key = JSON.stringify([config.issuer, config.issuer === 'billyou' ? config.billyou : { ...config.direct, key: config.direct.key.toString('base64') }, config.vatPercent]);
  if (made?.key === key) return made;
  if (config.issuer === 'efactura') {
    const efactura = openEfactura(config.direct, getAccountsStore().billing, { brand: invoiceBrand() });
    return (made = { key, issuer: efactura.issuer, efactura });
  }
  const issuer = billyouIssuer({ apiKey: config.billyou.apiKey, seriesId: config.billyou.seriesId, exchangeRate: currency => bnrRate(currency), ...(config.billyou.zeroVat ? { zeroVat: config.billyou.zeroVat } : {}) });
  return (made = { key, issuer, efactura: null });
}

export function issuerFor(config: Active): InvoiceIssuer { return build(config).issuer; }

/** Spine's own e-Factura link, where that is the issuer: the operator's page and the PDF route use it; null where invoices go through a service or are off. */
export function efacturaFromSettings(env: NodeJS.ProcessEnv = process.env): Efactura | null {
  const billing = loadBillingConfig(env);
  const config = loadInvoicingConfig(billing, env);
  return config.enabled && config.issuer === 'efactura' ? build(config).efactura : null;
}


/** The context from the settings, or null where invoices are not issued. */
export function contextFromSettings(env: NodeJS.ProcessEnv = process.env): InvoicingContext | null {
  const billing = loadBillingConfig(env);
  const config = loadInvoicingConfig(billing, env);
  if (!billing.enabled || !config.enabled) return null;
  const provider = billingProvider(billing as Enabled);
  return { issuer: issuerFor(config), config, readSale: ref => provider.readSale(ref), made: tellOfInvoice, keep: keepDocument(config) };
}


/** Puts a payment on the queue and tries it once, where the operator issues invoices. Called with the event; never throws, since a payment is acknowledged whatever happens to its invoice (the job tries again). */
export async function invoiceNewPayment(ref: string, userId: string | null): Promise<void> {
  try {
    const ctx = contextFromSettings();
    if (!ctx) return;
    const store = getAccountsStore();
    await store.billing.queueInvoice(ref, userId, new Date().toISOString());
    await processInvoice(ref, ctx);
  } catch (err) {
    logger.error('an invoice could not be queued or tried', { ref, reason: err instanceof Error ? err.message : String(err) });
  }
}


/** Every invoice whose time has come, a few at a time (the hourly job). */
export async function processDueInvoices(limit = 20): Promise<number> {
  const ctx = contextFromSettings();
  if (!ctx) return 0;
  const due = await getAccountsStore().billing.invoicesDue(new Date().toISOString(), limit);
  for (const row of due) await processInvoice(row.ref, ctx);
  return due.length;
}


/** A payment was refunded at the provider: the invoice made for it is reversed (`spine-billing`), in the context from the settings unless one is given. */
export async function reverseRefunded(refs: string[], full: boolean, refundId: string, context?: InvoicingContext | null): Promise<void> {
  return reverse(refs, full, refundId, context === undefined ? contextFromSettings() : context);
}

/** Tells the account that an invoice or a credit note is ready, by a short mail with a link and nothing attached (and nothing of the records); no mail where none is set up or the account is gone. */
async function tellOfInvoice(document: { userId: string | null; number: string; credit: boolean }): Promise<void> {
  const mailer = getMailer();
  if (!mailer.enabled || !document.userId) return;
  const user = await getAccountsStore().users.findById(document.userId);
  if (!user) return;
  await mailer.send(invoiceReadyMail({ email: user.email, language: user.language }, document.number, document.credit));
}
