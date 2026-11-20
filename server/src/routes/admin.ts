import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getAccountsStore } from 'spine-core/store/index.js';
import { requireAuth, requireRecentAuth } from 'spine-core/routes/middleware.js';
import { logger } from 'spine-core/logger.js';
import { adminEmails, marketingEmails } from '../config.js';
import { approvedMail, deleteAccount, signInLink } from '../identity/index.js';
import { getMailer } from '../mail/index.js';
import { dashboardOf, type Dashboard } from '../dashboard.js';
import { changeSetting, operatorSettings } from '../operator-settings.js';
import { changeFairUse, fairUseSections } from '../plans/fair-use-admin.js';
import { syncFairUse } from '../plans/fair-use.js';
import { pageInfo, pagingOf } from './paging.js';
import { efacturaFromSettings, retryInvoice, settleInvoice } from '../billing/invoicing/queue.js';
import { loadBillingConfig } from '../billing/config.js';
import { billingProvider } from '../billing/provider.js';
import { withdrawalAcceptedMail, withdrawalDeclinedMail } from '../billing/withdrawal-mail.js';
import { euSalesTotals } from 'spine-billing/invoicing/threshold.js';
import { usedSince } from '../usage-report.js';
import { suggestedRefund } from 'spine-billing/withdrawal-share.js';
import { adminCatalogRoutes } from './admin-catalog.js';
import { changeSeller, sellerOf } from '../billing/invoicing/seller.js';
import { loadInvoicingConfig } from '../billing/invoicing/config.js';
import { buildJournal, periodBounds } from '../billing/invoicing/journal.js';
import { changeVat, vatOf } from '../billing/invoicing/vat.js';
import { invoiceBrand } from '../billing/invoicing/brand.js';
import { EU_VAT_RATES, journalCsv, renderJournalPdf } from 'spine-anaf/index.js';

/**
 * Approving the accounts that asked for one under `SPINE_REGISTRATION=approval`, from the app. Who may is `SPINE_ADMIN_EMAILS`, checked on every
 * request against the signed-in account's own address (never a value the request carries); the CLI (`approve-user`) needs none of this. A waiting
 * account holds no records, so refusing one deletes the account and nothing else.
 */
export interface AdminRouteOptions {
  /** Who may approve; defaults to `SPINE_ADMIN_EMAILS`, read at each request. Tests give their own. */
  admins?: () => Set<string>;
  /** Who may read the numbers: the administrators and the marketing role (`SPINE_MARKETING_EMAILS`). Tests give their own. */
  readers?: () => Set<string>;
}

export async function adminRoutes(app: FastifyInstance, opts: AdminRouteOptions = {}) {
  const admins = opts.admins ?? (() => adminEmails());
  // The marketing role reads the numbers and can change nothing.
  const readers = opts.readers ?? (() => new Set([...admins(), ...marketingEmails()]));

  const onlyAdmins = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await getAccountsStore().users.findById(req.userId);
    if (!user || !admins().has(user.email.toLowerCase())) return reply.status(403).send({ error: 'only an administrator can do this' });
  };

  // Whether the signed-in account has a place on the operator's page (administrator, or the marketing role that only reads), so the account page can offer a way there to those who do and show nothing to anyone else.
  app.get('/api/admin/role', { preHandler: [requireAuth] }, async (req, reply) => {
    const user = await getAccountsStore().users.findById(req.userId);
    const email = user?.email.toLowerCase() ?? '';
    return reply.header('Cache-Control', 'no-store').send({ role: admins().has(email) ? 'admin' : readers().has(email) ? 'reader' : null });
  });

  // The numbers the operator and the marketing role look at: counts and the plans accounts are on, never a person (`dashboard.ts`). Worked out at most once a minute.
  let memo: { at: number; value: Dashboard } | null = null;
  // The numbers walk every account, so a second request while they are being worked out waits for the same answer instead of starting another walk.
  let working: Promise<Dashboard> | null = null;
  const onlyReaders = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await getAccountsStore().users.findById(req.userId);
    if (!user || !readers().has(user.email.toLowerCase())) return reply.status(403).send({ error: 'only an administrator can do this' });
  };
  app.get('/api/admin/dashboard', { preHandler: [requireAuth, onlyReaders] }, async (_req, reply) => {
    if (!memo || Date.now() - memo.at > 60_000) {
      working ??= dashboardOf(getAccountsStore()).finally(() => { working = null; });
      memo = { at: Date.now(), value: await working };
    }
    return reply.header('Cache-Control', 'no-store').send(memo.value);
  });

  // The invoices the operator owes (docs/billing.md): how many are in each state, the ones that stopped and why, and the EU consumer sales against the yearly threshold. A
  // reference and the service's own words, never a buyer. The operator mends one (retry, or settle by hand) with a recently typed password.
  app.get<{ Querystring: { page?: string; limit?: string } }>('/api/admin/invoices', { preHandler: [requireAuth, onlyReaders] }, async (req, reply) => {
    const store = getAccountsStore();
    const paging = pagingOf(req.query);
    const [counts, stopped, eu] = await Promise.all([store.billing.invoiceCounts(), store.billing.invoicesStopped(paging.limit, paging.offset), euSalesTotals(store)]);
    return reply.header('Cache-Control', 'no-store').send({
      counts, ...pageInfo(paging, counts.failed + counts.check),
      stopped: stopped.map(r => ({ ref: r.ref, state: r.state, attempts: r.attempts, reason: r.last_error, invoice: r.series ? `${r.series}-${r.number}` : null, at: r.updated_at, can_retry: r.state !== 'issued' && !(r.ref.startsWith('storno:') && !r.issuer_ref) })),
      eu: { year: eu.year, this_year: eu.thisYear / 100, last_year: eu.lastYear / 100, limit: eu.limit / 100 },
    });
  });
  app.post<{ Body: { ref?: unknown; action?: unknown } }>('/api/admin/invoices', { preHandler: [requireAuth, onlyAdmins, requireRecentAuth] }, async (req, reply) => {
    const { ref, action } = req.body ?? {};
    if (typeof ref !== 'string' || ref.length === 0 || ref.length > 200 || (action !== 'retry' && action !== 'settle')) return reply.status(400).send({ error: 'ref and an action, retry or settle, are needed' });
    const done = await (action === 'retry' ? retryInvoice(ref) : settleInvoice(ref));
    return done.ok ? reply.send({ ok: true }) : reply.status(409).send({ error: done.error });
  });

  // Spine's own link to ANAF's e-Factura (`SPINE_INVOICING_PROVIDER=efactura`, docs/efactura.md): whether the operator has authorised it, until when, and the newest documents with ANAF's word on each.
  // The operator starts the authorisation here and finishes it in a browser that holds the certificate; ANAF sends the browser back to the callback, which has no session to rely on (the
  // cookie is SameSite=strict and the redirect comes from another site), so what it checks is the one-time `state` that only a recently typed password could have asked for.
  app.get<{ Querystring: { page?: string; limit?: string } }>('/api/admin/efactura', { preHandler: [requireAuth, onlyReaders] }, async (req, reply) => {
    const efactura = efacturaFromSettings();
    if (!efactura) return reply.header('Cache-Control', 'no-store').send({ enabled: false });
    const paging = pagingOf(req.query);
    const [status, documents, total] = await Promise.all([efactura.link.status(), getAccountsStore().billing.efacturaDocuments(paging.limit, paging.offset), getAccountsStore().billing.efacturaDocumentCount()]);
    const { series, mode, redirectUri } = efactura.config;
    const seller = await sellerOf(getAccountsStore());
    return reply.header('Cache-Control', 'no-store').send({
      enabled: true, ...pageInfo(paging, total), mode, series, redirect_uri: redirectUri, seller: seller ? { name: seller.name, cif: seller.cif } : null, ...status,
      documents: documents.map(d => ({ id: d.draft_id, number: `${d.series}-${String(d.number).padStart(5, '0')}`, kind: d.kind, date: d.issue_date, state: d.anaf_state, message: d.anaf_message })),
    });
  });
  // An invoice as the Ministry's own converter draws it from the XML ANAF takes, for the operator to compare with Spine's (`GET /api/billing/invoice-pdf/:id` is the buyer's). The service is public; it needs nothing from ANAF.
  app.get<{ Params: { id: string } }>('/api/admin/efactura/:id/anaf-pdf', { preHandler: [requireAuth, onlyReaders], config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const efactura = efacturaFromSettings();
    if (!efactura) return reply.status(404).send({ error: 'e-Factura is not on here' });
    try {
      return reply.header('Cache-Control', 'private, no-store').header('Content-Type', 'application/pdf').header('Content-Disposition', 'inline; filename="anaf-view.pdf"').send(await efactura.issuer.pdfByAnaf(req.params.id));
    } catch (err) {
      return reply.status(502).send({ error: err instanceof Error ? err.message : 'the Ministry’s converter did not answer' });
    }
  });
  app.post('/api/admin/efactura/authorise', { preHandler: [requireAuth, onlyAdmins, requireRecentAuth] }, async (_req, reply) => {
    const efactura = efacturaFromSettings();
    if (!efactura) return reply.status(404).send({ error: 'e-Factura is not on here' });
    return reply.header('Cache-Control', 'no-store').send({ url: await efactura.link.authorisationUrl() });
  });
  // ANAF's test service for the token: whether the authorisation is accepted, with nothing sent to e-Factura. An administrator's, since it uses the operator's token.
  app.post('/api/admin/efactura/test', { preHandler: [requireAuth, onlyAdmins], config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (_req, reply) => {
    const efactura = efacturaFromSettings();
    if (!efactura) return reply.status(404).send({ error: 'e-Factura is not on here' });
    return reply.header('Cache-Control', 'no-store').send(await efactura.link.hello());
  });
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/api/admin/efactura/callback', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { code, state } = req.query;
    const back = (outcome: 'ok' | 'error') => reply.header('Cache-Control', 'no-store').redirect(`/admin/invoices?efactura=${outcome}`);
    const efactura = efacturaFromSettings();
    if (!efactura || typeof code !== 'string' || typeof state !== 'string' || code.length > 2000 || state.length > 200) return back('error');
    try {
      await efactura.link.complete(code, state);
      return back('ok');
    } catch (err) {
      logger.warn('the ANAF authorisation was not completed', { reason: err instanceof Error ? err.message : String(err) });
      return back('error');
    }
  });

  // What is sold and for how much (`billing/products.ts`): the catalog an administrator edits and sends to the payment provider.
  await adminCatalogRoutes(app, onlyAdmins);

  // Buyers' requests to withdraw from a purchase. The operator decides each: pays back (all of the last payment, or an amount) and ends the plan, or declines with a reason.
  // The refund then reaches `charge.refunded`, which has the invoice reversed. The buyer is told either way.
  app.get<{ Querystring: { page?: string; limit?: string } }>('/api/admin/withdrawals', { preHandler: [requireAuth, onlyReaders] }, async (req, reply) => {
    const store = getAccountsStore();
    const paging = pagingOf(req.query);
    const [open, total] = await Promise.all([store.billing.withdrawals('requested', paging.limit, paging.offset), store.billing.withdrawalCount('requested')]);
    const config = loadBillingConfig();
    const rows = await Promise.all(open.map(async w => {
      const [user, sub, first] = await Promise.all([store.users.findById(w.user_id), store.billing.get(w.user_id), store.billing.firstPaymentAt(w.user_id)]);
      // Whether the service was used since the purchase, and how many times the account has asked and been paid back before: what the operator weighs in deciding.
      const used = first ? await usedSince(store, w.user_id, new Date(first)) : null;
      // What to pay back, as a suggestion (`packages/billing/src/withdrawal-share.ts`): needs the last payment, which only the provider knows; a provider that cannot say gives none.
      let suggested: ReturnType<typeof suggestedRefund> | null = null;
      if (first && sub?.subscription_id && sub.interval && config.enabled && sub.provider === config.provider) {
        const paid = await billingProvider(config).lastPaid(sub.subscription_id).catch(() => null);
        if (paid) suggested = suggestedRefund({ paidMinor: paid.amountMinor, currency: paid.currency, interval: sub.interval, paidAt: new Date(first), asked: new Date(w.requested_at), used });
      }
      return {
        id: w.id, email: user?.email ?? null, plan: sub?.plan ?? null, interval: sub?.interval ?? null, requested_at: w.requested_at, first_payment: first, used, suggested,
        earlier_refunds: await store.billing.refundedWithdrawalsOf(w.user_id),
      };
    }));
    return reply.header('Cache-Control', 'no-store').send({ requests: rows, ...pageInfo(paging, total) });
  });
  app.post<{ Body: { id?: unknown; action?: unknown; amount?: unknown; note?: unknown } }>('/api/admin/withdrawals', { preHandler: [requireAuth, onlyAdmins, requireRecentAuth] }, async (req, reply) => {
    const { id, action, amount, note } = req.body ?? {};
    if (typeof id !== 'string' || (action !== 'refund' && action !== 'decline')) return reply.status(400).send({ error: 'id and an action, refund or decline, are needed' });
    if (amount !== undefined && amount !== null && !(typeof amount === 'number' && Number.isFinite(amount) && amount > 0 && amount <= 100_000)) return reply.status(400).send({ error: 'amount must be a positive number' });
    if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > 500)) return reply.status(400).send({ error: 'note must be at most 500 characters' });
    const store = getAccountsStore();
    const request = await store.billing.withdrawal(id);
    if (!request || request.state !== 'requested') return reply.status(409).send({ error: 'there is no open request with this id' });
    const user = await store.users.findById(request.user_id);
    const at = new Date().toISOString();
    const mailer = getMailer();
    const tell = async (message: ReturnType<typeof withdrawalDeclinedMail>) => { if (mailer.enabled) await mailer.send(message).catch(err => logger.warn('a withdrawal mail could not be sent', { reason: err instanceof Error ? err.message : String(err) })); };
    if (action === 'decline') {
      await store.billing.decideWithdrawal(id, { state: 'declined', refundedMinor: null, note: typeof note === 'string' && note.trim() ? note.trim() : null }, at);
      if (user) await tell(withdrawalDeclinedMail({ email: user.email, language: user.language }, typeof note === 'string' && note.trim() ? note.trim() : null));
      return reply.send({ ok: true });
    }
    const config = loadBillingConfig();
    const sub = await store.billing.get(request.user_id);
    if (!config.enabled || sub?.provider !== config.provider || !sub.subscription_id) return reply.status(409).send({ error: 'there is no subscription to end and pay back here: refund it at the payment provider' });
    try {
      const paid = await billingProvider(config).withdraw({ subscriptionId: sub.subscription_id, amountMinor: typeof amount === 'number' ? Math.round(amount * 100) : null, key: `withdrawal:${id}` });
      await store.billing.decideWithdrawal(id, { state: 'refunded', refundedMinor: paid.refundedMinor, note: null }, at);
      await store.metrics.bump('withdrawal_refunded', at.slice(0, 10));
      if (user) await tell(withdrawalAcceptedMail({ email: user.email, language: user.language }, `${(paid.refundedMinor / 100).toFixed(2)} ${paid.currency}`));
      return reply.send({ ok: true, refunded: paid.refundedMinor / 100, currency: paid.currency });
    } catch (err) {
      logger.warn('a withdrawal could not be paid back', { reason: err instanceof Error ? err.message : String(err) });
      return reply.status(502).send({ error: 'the payment provider could not do it; nothing is marked as decided, so it can be tried again' });
    }
  });

  // The settings the admin page changes (`operator-settings.ts`): the marketing role may read them, an administrator change them. A change is
  // checked against the setting's bounds and takes effect within half a minute everywhere, the numbers at once.
  app.get('/api/admin/settings', { preHandler: [requireAuth, onlyReaders] }, async (req, reply) => {
    const settings = await operatorSettings(getAccountsStore());
    const user = await getAccountsStore().users.findById(req.userId);
    return reply.header('Cache-Control', 'no-store').send({ settings: settings.map(({ fallbackOf: _f, ...s }) => s), can_edit: !!user && admins().has(user.email.toLowerCase()) });
  });
  app.put<{ Body: { key?: unknown; value?: unknown } }>('/api/admin/settings', { preHandler: [requireAuth, onlyAdmins, requireRecentAuth] }, async (req, reply) => {
    const problem = await changeSetting(getAccountsStore(), req.body?.key, req.body?.value ?? null, new Date().toISOString());
    if (problem) return reply.status(400).send({ error: problem });
    memo = null;
    logger.info('an operator setting was changed', { event: 'operator_setting', key: req.body?.key, account: req.userId });
    const settings = await operatorSettings(getAccountsStore());
    return reply.send({ settings: settings.map(({ fallbackOf: _f, ...s }) => s) });
  });

  // Who the invoices are made out by (`billing/invoicing/seller.ts`): read by the marketing role too, changed by an administrator. It is what Spine's own PDF of an invoice a service issued shows.
  app.get('/api/admin/seller', { preHandler: [requireAuth, onlyReaders] }, async (req, reply) => {
    const user = await getAccountsStore().users.findById(req.userId);
    let issuer: string | null = null;
    try { const config = loadInvoicingConfig(loadBillingConfig()); issuer = config.enabled ? config.issuer : null; } catch { issuer = null; }
    return reply.header('Cache-Control', 'no-store').send({ seller: await sellerOf(getAccountsStore()), issuer, can_edit: !!user && admins().has(user.email.toLowerCase()) });
  });
  app.put<{ Body: unknown }>('/api/admin/seller', { preHandler: [requireAuth, onlyAdmins, requireRecentAuth] }, async (req, reply) => {
    const problem = await changeSeller(getAccountsStore(), req.body, new Date().toISOString());
    if (problem) return reply.status(400).send({ error: problem });
    logger.info('the seller on invoices was changed', { event: 'invoice_seller', account: req.userId });
    return reply.send({ seller: await sellerOf(getAccountsStore()) });
  });

  // The month's invoices and credit notes in one document for the accountant (`billing/invoicing/journal.ts`): a CSV a spreadsheet opens, or a PDF to print and sign. An administrator only:
  // it lists every buyer of the month by name. Nothing is kept of it; it is drawn from the documents each time.
  app.get<{ Querystring: { period?: string; format?: string } }>('/api/admin/invoices/export', { preHandler: [requireAuth, onlyAdmins], config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    let config;
    try { config = loadInvoicingConfig(loadBillingConfig()); } catch { config = { enabled: false as const }; }
    if (!config.enabled) return reply.status(404).send({ error: 'the operator does not issue invoices here' });
    const period = req.query.period ?? '';
    const format = req.query.format ?? 'csv';
    if (format !== 'csv' && format !== 'pdf') return reply.status(400).send({ error: 'the format is csv or pdf' });
    const made = await buildJournal(period);
    if (!made.ok) return reply.status(made.error.startsWith('the period') ? 400 : 409).send({ error: made.error });
    if (periodBounds(period).from > new Date().toISOString().slice(0, 10)) return reply.status(400).send({ error: 'that period has not begun' });
    logger.info('the period\'s invoices were exported', { event: 'invoice_export', period, format, account: req.userId, rows: made.journal.rows.length });
    const name = `centralizator-facturi-${period}.${format}`;
    reply.header('Cache-Control', 'private, no-store').header('Content-Disposition', `attachment; filename="${name}"`);
    if (format === 'csv') return reply.header('Content-Type', 'text/csv; charset=utf-8').send(journalCsv(made.journal));
    return reply.header('Content-Type', 'application/pdf').send(await renderJournalPdf(made.journal, { brand: invoiceBrand() }));
  });

  // Whether the company is registered for VAT, from which day, and whether it has joined the One Stop Shop (`billing/invoicing/vat.ts`): what decides the VAT on each invoice Spine's own e-Factura link makes.
  // Read by the marketing role too, changed by an administrator who has typed the password lately.
  app.get('/api/admin/vat', { preHandler: [requireAuth, onlyReaders] }, async (req, reply) => {
    const user = await getAccountsStore().users.findById(req.userId);
    let issuer: string | null = null;
    try { const config = loadInvoicingConfig(loadBillingConfig()); issuer = config.enabled ? config.issuer : null; } catch { issuer = null; }
    const seller = await sellerOf(getAccountsStore());
    return reply.header('Cache-Control', 'no-store').send({ vat: await vatOf(getAccountsStore()), issuer, seller_has_vat_id: !!seller?.vatId, romania_rate: EU_VAT_RATES.RO, oss_available: issuer === 'efactura', can_edit: !!user && admins().has(user.email.toLowerCase()) });
  });
  app.put<{ Body: unknown }>('/api/admin/vat', { preHandler: [requireAuth, onlyAdmins, requireRecentAuth] }, async (req, reply) => {
    let issuer: string | null = null;
    try { const config = loadInvoicingConfig(loadBillingConfig()); issuer = config.enabled ? config.issuer : null; } catch { issuer = null; }
    const problem = await changeVat(getAccountsStore(), req.body, new Date().toISOString(), { oss: issuer === 'efactura' });
    if (problem) return reply.status(400).send({ error: problem });
    logger.info('the VAT settings were changed', { event: 'invoice_vat', account: req.userId });
    return reply.send({ vat: await vatOf(getAccountsStore()) });
  });

  // The hidden fair-use ceilings (`plans/fair-use-admin.ts`): an administrator only, for both reading and changing, because they are never shown to anyone
  // else, the marketing role included.
  app.get('/api/admin/fair-use', { preHandler: [requireAuth, onlyAdmins] }, async (_req, reply) => {
    await syncFairUse(getAccountsStore());
    return reply.header('Cache-Control', 'no-store').send({ sections: fairUseSections() });
  });
  app.put<{ Body: { path?: unknown; value?: unknown } }>('/api/admin/fair-use', { preHandler: [requireAuth, onlyAdmins, requireRecentAuth] }, async (req, reply) => {
    const problem = await changeFairUse(getAccountsStore(), req.body?.path, req.body?.value ?? null, new Date().toISOString());
    if (problem) return reply.status(400).send({ error: problem });
    logger.info('a fair-use ceiling was changed', { event: 'fair_use_change', path: req.body?.path, account: req.userId });
    return reply.send({ sections: fairUseSections() });
  });

  // What each account with a subscription has: the plan, who bills it, its state and when it ends or renews. The operator's list, so an administrator's only.
  app.get<{ Querystring: { page?: string; limit?: string } }>('/api/admin/subscriptions', { preHandler: [requireAuth, onlyAdmins] }, async (req, reply) => {
    const store = getAccountsStore();
    const paging = pagingOf(req.query);
    const [rows, total] = await Promise.all([store.billing.subscriptions(paging.limit, paging.offset), store.billing.subscriptionCount()]);
    const out = await Promise.all(rows.map(async r => ({
      email: (await store.users.findById(r.user_id))?.email ?? null, plan: r.plan, interval: r.interval, provider: r.provider, status: r.status, founding: r.founding,
      until: r.current_period_end, ends: r.cancel_scheduled,
    })));
    return reply.header('Cache-Control', 'no-store').send({ subscriptions: out, ...pageInfo(paging, total) });
  });

  app.get<{ Querystring: { page?: string; limit?: string } }>('/api/admin/accounts', { preHandler: [requireAuth, onlyAdmins] }, async (req, reply) => {
    const paging = pagingOf(req.query);
    const store = getAccountsStore();
    const [waiting, total] = await Promise.all([store.users.listWaiting(paging.limit, paging.offset), store.users.countWaiting()]);
    return reply.send({ ...pageInfo(paging, total), pending: waiting.map(u => ({ id: u.id, email: u.email, created_at: u.created_at, email_confirmed: !!u.email_verified_at })) });
  });

  app.post<{ Params: { id: string } }>('/api/admin/accounts/:id/approve', { preHandler: [requireAuth, onlyAdmins, requireRecentAuth] }, async (req, reply) => {
    const store = getAccountsStore();
    const user = await store.users.findById(req.params.id);
    if (!user || !(await store.users.approve(user.id, new Date().toISOString()))) return reply.status(404).send({ error: 'no such account waiting for approval' });
    logger.info('an account was approved', { by: req.userId, userId: user.id });
    const mailer = getMailer();
    if (mailer.enabled) {
      mailer.send(approvedMail(user, signInLink())).catch(err => logger.error('could not send the approval mail', { err: err instanceof Error ? err.message : String(err) }));
    }
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string } }>('/api/admin/accounts/:id/refuse', { preHandler: [requireAuth, onlyAdmins, requireRecentAuth] }, async (req, reply) => {
    const user = await getAccountsStore().users.findById(req.params.id);
    // Only one that is still waiting: an approved account's records are its owner's, and are not the administrator's to remove.
    if (!user || user.approved !== 0) return reply.status(404).send({ error: 'no such account waiting for approval' });
    await deleteAccount(user.id);
    logger.info('an account request was refused', { by: req.userId, userId: user.id });
    return reply.send({ ok: true });
  });
}
