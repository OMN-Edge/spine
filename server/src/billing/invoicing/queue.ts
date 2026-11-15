import { getAccountsStore } from 'spine-core/store/index.js';
import { logger } from 'spine-core/logger.js';
import type { InvoiceState, QueuedInvoice } from 'spine-core/store/types.js';
import { billingProvider, type Enabled, type Sale } from '../provider.js';
import { loadBillingConfig } from '../config.js';
import { billyouIssuer } from './billyou.js';
import { bnrRate } from './bnr.js';
import { alertOperator } from './alert.js';
import { loadInvoicingConfig, type InvoicingConfig } from './config.js';
import { euMinorOf } from './threshold.js';
import { InvoiceError, type InvoiceDraft, type InvoiceIssuer, type IssuedInvoice } from './issuer.js';

/**
 * The invoices the operator owes for payments the provider is not the seller of (`SPINE_INVOICING`, docs/billing.md, "Invoices"). A payment event puts the provider's
 * reference for it on a queue (`invoice_queue`: the reference, where its invoice has got to, the service's number; never the buyer), and an invoice is made from it by
 * reading the sale from the provider again whenever it is tried: at once after the event, and every hour by the job until it is done. So a failure of the service, or
 * of this server between the payment and the invoice, delays an invoice and loses none, and nothing of the buyer is kept here.
 */
type Active = Extract<InvoicingConfig, { enabled: true }>;

/** After this many tries an invoice is left for the operator. With the waits below that is about a day. */
export const MAX_ATTEMPTS = 10;
/** What a storno says it is for. */
const STORNO_REASON = 'Rambursare';
const isStorno = (ref: string): boolean => ref.startsWith('storno:');
/** How often ANAF is asked whether it has decided, and how many times (a day). */
const POLL_MS = 5 * 60_000;
const POLLS = 288;
const waitMs = (attempts: number): number => Math.min(2 ** attempts * 60_000, 6 * 3_600_000);

export interface InvoicingContext {
  issuer: InvoiceIssuer;
  config: Active;
  /** The sale as the payment provider says it. */
  readSale: (ref: string) => Promise<Sale>;
  now?: () => Date;
}

/** An invoice's lines: what was paid for, with the VAT the operator charges in it. */
export function draftOf(ref: string, sale: Sale, config: Active): InvoiceDraft {
  return {
    id: ref, paidAt: sale.paidAt, currency: sale.currency, buyer: sale.buyer, sendEmail: config.mail,
    lines: sale.lines.map(l => ({ name: l.name, amountMinor: l.amountMinor, quantity: l.quantity, vatPercent: config.vatPercent })),
  };
}

/** The service the operator named, made once for the process (a token is kept between calls). */
let made: { key: string; issuer: InvoiceIssuer } | null = null;
export function issuerFor(config: Active): InvoiceIssuer {
  const key = JSON.stringify([config.issuer, config.billyou, config.vatPercent]);
  if (made?.key === key) return made.issuer;
  const issuer = billyouIssuer({ apiKey: config.billyou.apiKey, seriesId: config.billyou.seriesId, exchangeRate: currency => bnrRate(currency), ...(config.billyou.zeroVat ? { zeroVat: config.billyou.zeroVat } : {}) });
  made = { key, issuer };
  return issuer;
}

/**
 * Takes an invoice one step on: issues it, then sends it to e-Factura if the operator asked. Never throws; the row says how far it got. A failure that may pass is
 * tried again later (a minute, then twice as long, up to six hours, ten times); one that will not is left for the operator. An attempt that ended with no answer at
 * a service that cannot tell a repeated request from a new one is not repeated at all (`check`): the invoice may exist, and a second would be a second.
 */
export async function processInvoice(ref: string, ctx: InvoicingContext): Promise<InvoiceState | null> {
  const store = getAccountsStore();
  const now = () => (ctx.now ?? (() => new Date()))();
  const row = await store.billing.invoice(ref);
  if (!row || (row.state !== 'pending' && row.state !== 'issued')) return row?.state ?? null;
  // Not yet its time, or another pass has taken it (a claim holds it for five minutes, and what the pass learns replaces the claim).
  if (row.next_attempt_at > now().toISOString()) return row.state;
  await store.billing.updateInvoice(ref, { next_attempt_at: new Date(now().getTime() + 5 * 60_000).toISOString() }, now().toISOString());

  const stop = async (r: QueuedInvoice, state: InvoiceState, reason: string): Promise<InvoiceState> => {
    await store.billing.updateInvoice(ref, { state, last_error: reason.slice(0, 200), attempts: r.attempts + 1, resume: r.state === 'issued' ? 'issued' : 'pending' }, now().toISOString());
    await store.metrics.bump(`invoice_${state}`, now().toISOString().slice(0, 10));
    logger.error('an invoice needs the operator', { ref, state, reason: reason.slice(0, 200) });
    await alertOperator('an invoice needs a look', [`Payment ${ref}: ${state === 'check' ? 'an attempt ended with no answer, and the service cannot tell a repeat from a new invoice, so nothing was sent again. Look in the service for an invoice for it.' : 'it could not be made or sent.'}`, `Why: ${reason.slice(0, 200)}`]);
    return state;
  };
  const later = async (r: QueuedInvoice, reason: string): Promise<InvoiceState> => {
    if (r.attempts + 1 >= MAX_ATTEMPTS) return stop(r, 'failed', `tried ${MAX_ATTEMPTS} times: ${reason}`);
    await store.billing.updateInvoice(ref, { attempts: r.attempts + 1, last_error: reason.slice(0, 200), next_attempt_at: new Date(now().getTime() + waitMs(r.attempts + 1)).toISOString() }, now().toISOString());
    return r.state;
  };

  let current = row;
  if (current.state === 'pending') {
    let issued: IssuedInvoice | null;
    let sale: Sale | null = null;
    try {
      if (isStorno(ref)) {
        // A storno of an invoice that is made: its own refs are the original's until it is made, and the service's word that it was reversed already is the end of it.
        if (!current.issuer_ref) throw new InvoiceError('there is no invoice to reverse', false);
        issued = await ctx.issuer.reverse({ id: current.issuer_ref, series: current.series ?? '', number: current.number ?? '' }, STORNO_REASON);
        if (!issued) {
          await store.billing.updateInvoice(ref, { state: 'done', last_error: 'the service had reversed it already' }, now().toISOString());
          return 'done';
        }
      } else {
        sale = await ctx.readSale(ref);
        issued = await ctx.issuer.issue(draftOf(ref, sale, ctx.config));
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (!(err instanceof InvoiceError)) return later(current, reason);
      if (!err.retry) return stop(current, 'failed', reason);
      // No answer, or the service's own fault, and no way to ask whether it made the invoice anyway.
      if (!ctx.issuer.repeatSafe && (err.status === null || err.status >= 500)) return stop(current, 'check', reason);
      return later(current, reason);
    }
    const next: QueuedInvoice['state'] = ctx.config.efactura ? 'issued' : 'done';
    // What it counts for in the EU consumer threshold; a storno takes the original's, taken off (set where it is queued).
    const eu = sale ? await euMinorOf(sale) : undefined;
    await store.billing.updateInvoice(ref, { state: next, attempts: 0, last_error: null, issuer_ref: issued.id, series: issued.series, number: issued.number, next_attempt_at: now().toISOString(), ...(eu === undefined ? {} : { eu_minor: eu }) }, now().toISOString());
    await store.metrics.bump('invoice_issued', now().toISOString().slice(0, 10));
    if (next === 'done') return 'done';
    current = { ...current, state: 'issued', attempts: 0, issuer_ref: issued.id, series: issued.series, number: issued.number };
  }

  // Issued, and to be sent to e-Factura.
  try {
    const sent = await ctx.issuer.sendToAnaf({ id: current.issuer_ref ?? '', series: current.series ?? '', number: current.number ?? '' });
    // Code 2 is the service's word that ANAF refused it; the operator mends the invoice or the company's data there, and sends it again from the service.
    if (sent.code === 2) return stop(current, 'failed', `e-Factura refused it: ${sent.text}`);
    // Code 0: ANAF has it and has not decided (it can take hours). It stays queued and is asked again in a few minutes, up to a day, and then left for the operator.
    if (sent.code === 0) {
      if (current.attempts + 1 >= POLLS) return stop(current, 'check', 'ANAF was still deciding after a day: look at the invoice in the service');
      await store.billing.updateInvoice(ref, { attempts: current.attempts + 1, last_error: null, next_attempt_at: new Date(now().getTime() + POLL_MS).toISOString() }, now().toISOString());
      return 'issued';
    }
    await store.billing.updateInvoice(ref, { state: 'done', last_error: sent.code === -1 ? sent.text : null }, now().toISOString());
    return 'done';
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return err instanceof InvoiceError && !err.retry ? stop(current, 'failed', reason) : later(current, reason);
  }
}

/** The context from the settings, or null where invoices are not issued. */
export function contextFromSettings(env: NodeJS.ProcessEnv = process.env): InvoicingContext | null {
  const billing = loadBillingConfig(env);
  const config = loadInvoicingConfig(billing, env);
  if (!billing.enabled || !config.enabled) return null;
  const provider = billingProvider(billing as Enabled);
  return { issuer: issuerFor(config), config, readSale: ref => provider.readSale(ref) };
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

/**
 * A payment was refunded at the provider: the invoice made for it is reversed. The refund names the references the payment may be queued under; the first that holds an
 * invoice that is made is reversed with a storno, queued and tried like an invoice (`storno:` and the payment's reference), which also takes the refs of the invoice to
 * reverse. A refund of part of a payment cannot be reversed this way (a storno is the whole invoice), and a refund of a payment whose invoice is not made cannot either:
 * both are left to the operator (`check`) with the reason. A payment that was never queued (invoices were not issued then) is left alone. Never throws.
 */
export async function reverseRefunded(refs: string[], full: boolean, refundId: string, context?: InvoicingContext | null): Promise<void> {
  try {
    const ctx = context === undefined ? contextFromSettings() : context;
    if (!ctx) return;
    const store = getAccountsStore();
    const at = (ctx.now ?? (() => new Date()))().toISOString();
    for (const ref of refs) {
      const original = await store.billing.invoice(ref);
      if (!original) continue;
      if (!full || !original.issuer_ref || (original.state !== 'done' && original.state !== 'issued')) {
        const key = `storno:${ref}:${refundId}`;
        if (await store.billing.queueInvoice(key, original.user_id, at)) {
          const reason = !full ? 'part of the payment was refunded: a storno reverses the whole invoice, so make a credit note by hand' : 'the payment was refunded before its invoice was made: cancel it, or reverse it once made';
          await store.billing.updateInvoice(key, { state: 'check', last_error: reason }, at);
          await store.metrics.bump('invoice_check', at.slice(0, 10));
          logger.error('a refund needs the operator', { ref, state: 'check', reason });
          await alertOperator('a refund needs a look', [`Refund of payment ${ref}: ${reason}.`]);
        }
        return;
      }
      const key = `storno:${ref}`;
      if (await store.billing.queueInvoice(key, original.user_id, at)) {
        await store.billing.updateInvoice(key, { issuer_ref: original.issuer_ref, series: original.series, number: original.number, ...(original.eu_minor === null ? {} : { eu_minor: -original.eu_minor }) }, at);
      }
      await processInvoice(key, ctx);
      return;
    }
  } catch (err) {
    logger.error('a refund could not be queued or tried', { reason: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * The operator's actions on an invoice that stopped (`failed`, `check`), from the admin page and the CLI. `retry` puts it back where it had got to, to be tried at once
 * (for a `check`, the operator has looked and found no invoice); `settle` marks it done, because the operator made or mended it by hand. Both say what they did, or why not.
 */
export async function retryInvoice(ref: string, at = new Date().toISOString()): Promise<{ ok: true } | { ok: false; error: string }> {
  const store = getAccountsStore();
  const row = await store.billing.invoice(ref);
  if (!row) return { ok: false, error: 'there is no such invoice' };
  if (row.state !== 'failed' && row.state !== 'check') return { ok: false, error: `it is ${row.state}, not stopped` };
  // A refund the queue cannot reverse by itself has no invoice to try again with.
  if (isStorno(ref) && !row.issuer_ref) return { ok: false, error: 'this one is for the operator to settle by hand' };
  await store.billing.updateInvoice(ref, { state: row.resume ?? 'pending', attempts: 0, next_attempt_at: at, last_error: null }, at);
  return { ok: true };
}

export async function settleInvoice(ref: string, at = new Date().toISOString()): Promise<{ ok: true } | { ok: false; error: string }> {
  const store = getAccountsStore();
  const row = await store.billing.invoice(ref);
  if (!row) return { ok: false, error: 'there is no such invoice' };
  if (row.state !== 'failed' && row.state !== 'check') return { ok: false, error: `it is ${row.state}, not stopped` };
  await store.billing.updateInvoice(ref, { state: 'done', last_error: 'settled by the operator' }, at);
  return { ok: true };
}
