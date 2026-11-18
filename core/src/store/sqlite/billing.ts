import type { Database } from './driver.js';
import type { BillingRepository, CatalogLink, CatalogPrice, CatalogProduct, CatalogRepository, EfacturaDocument, EfacturaDocumentPatch, InvoicePatch, InvoiceState, QueuedInvoice, WithdrawalRecord, MetricsRepository, OperatorSettingsRepository, SubscriptionRecord, WaitlistRepository } from '../types.js';

const COLUMNS = 'user_id, provider, customer_id, subscription_id, billing_interval, plan, status, founding, current_period_end, cancel_scheduled, updated_at';

const asSubscription = (r: Record<string, unknown>): SubscriptionRecord => ({
  user_id: r.user_id as string,
  provider: r.provider as SubscriptionRecord['provider'],
  customer_id: (r.customer_id as string | null) ?? null,
  subscription_id: (r.subscription_id as string | null) ?? null,
  interval: (r.billing_interval as SubscriptionRecord['interval']) ?? null,
  plan: r.plan === 'family' ? 'family' : r.plan === 'essential' ? 'essential' : 'premium',
  status: r.status as string,
  founding: r.founding === 1,
  current_period_end: (r.current_period_end as string | null) ?? null,
  cancel_scheduled: r.cancel_scheduled === 1,
  updated_at: r.updated_at as string,
});

const INVOICE_FIELDS = ['state', 'attempts', 'next_attempt_at', 'last_error', 'issuer_ref', 'series', 'number', 'resume', 'eu_minor'];
const WITHDRAWAL_COLUMNS = 'id, user_id, state, requested_at, decided_at, refunded_minor, note';
const EFACTURA_FIELDS = ['xml', 'input', 'anaf_index', 'anaf_state', 'anaf_message', 'signed'];
const EFACTURA_COLUMNS = 'draft_id, kind, series, number, issue_date, reverses, xml, input, anaf_index, anaf_state, anaf_message, signed, created_at, updated_at';
const INVOICE_COLUMNS = 'ref, user_id, state, attempts, next_attempt_at, last_error, issuer_ref, series, number, resume, eu_minor, created_at, updated_at';

type EfacturaTokensRow = NonNullable<Awaited<ReturnType<BillingRepository['efacturaTokens']>>>;

/** The account's own row is read with its id; the provider's side finds one by the provider's ids (store/types.ts, exceptions). */
export function billingRepository(db: Database): BillingRepository {
  const get = db.prepare(`SELECT ${COLUMNS} FROM subscriptions WHERE user_id = ?`);
  const all = db.prepare(`SELECT ${COLUMNS} FROM subscriptions ORDER BY updated_at DESC, user_id LIMIT ? OFFSET ?`);
  const subscriptionCount = db.prepare('SELECT COUNT(*) AS n FROM subscriptions');
  const bySubscription = db.prepare(`SELECT ${COLUMNS} FROM subscriptions WHERE subscription_id = ?`);
  const byCustomer = db.prepare(`SELECT ${COLUMNS} FROM subscriptions WHERE customer_id = ?`);
  const put = db.prepare(`INSERT INTO subscriptions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET provider = excluded.provider, customer_id = excluded.customer_id, subscription_id = excluded.subscription_id,
      billing_interval = excluded.billing_interval, plan = excluded.plan, status = excluded.status, founding = excluded.founding,
      current_period_end = excluded.current_period_end, cancel_scheduled = excluded.cancel_scheduled, updated_at = excluded.updated_at`);
  // Held: the founding price of a subscription that has not ended.
  const founding = db.prepare(`SELECT COUNT(*) AS n FROM subscriptions WHERE founding = 1`);
  // Each founding place is also counted once, by the day, with no account in it, so a place stays taken when the account is deleted (`routes/billing.ts`).
  const taken = db.prepare(`SELECT COALESCE(SUM(n), 0) AS n FROM metrics WHERE name = 'founding_taken'`);
  const event = db.prepare('INSERT OR IGNORE INTO billing_events (id, at) VALUES (?, ?)');
  const prune = db.prepare('DELETE FROM billing_events WHERE at < ?');
  const customer = db.prepare('SELECT customer_id FROM billing_customers WHERE user_id = ?');
  const setCustomer = db.prepare('INSERT INTO billing_customers (user_id, customer_id, updated_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET customer_id = excluded.customer_id, updated_at = excluded.updated_at');
  const queue = db.prepare(`INSERT OR IGNORE INTO invoice_queue (ref, user_id, state, attempts, next_attempt_at, created_at, updated_at) VALUES (?, ?, 'pending', 0, ?, ?, ?)`);
  const due = db.prepare(`SELECT ${INVOICE_COLUMNS} FROM invoice_queue WHERE state IN ('pending', 'issued') AND next_attempt_at <= ? ORDER BY created_at LIMIT ?`);
  const requestW = db.prepare(`INSERT OR IGNORE INTO withdrawal_requests (id, user_id, state, requested_at) VALUES (?, ?, 'requested', ?)`);
  const allW = db.prepare(`SELECT ${WITHDRAWAL_COLUMNS} FROM withdrawal_requests ORDER BY requested_at DESC, id LIMIT ? OFFSET ?`);
  const refundedW = db.prepare(`SELECT COUNT(*) AS n FROM withdrawal_requests WHERE user_id = ? AND state = 'refunded'`);
  const countW = db.prepare('SELECT COUNT(*) AS n FROM withdrawal_requests');
  const countByStateW = db.prepare('SELECT COUNT(*) AS n FROM withdrawal_requests WHERE state = ?');
  const byStateW = db.prepare(`SELECT ${WITHDRAWAL_COLUMNS} FROM withdrawal_requests WHERE state = ? ORDER BY requested_at DESC, id LIMIT ? OFFSET ?`);
  const oneW = db.prepare(`SELECT ${WITHDRAWAL_COLUMNS} FROM withdrawal_requests WHERE id = ?`);
  const openW = db.prepare(`SELECT ${WITHDRAWAL_COLUMNS} FROM withdrawal_requests WHERE user_id = ? AND state = 'requested'`);
  const decideW = db.prepare('UPDATE withdrawal_requests SET state = ?, decided_at = ?, refunded_minor = ?, note = ? WHERE id = ?');
  const ofUser = db.prepare(`SELECT ${INVOICE_COLUMNS} FROM invoice_queue WHERE user_id = ? ORDER BY created_at DESC`);
  const made = db.prepare(`SELECT ${INVOICE_COLUMNS} FROM invoice_queue WHERE user_id = ? AND number IS NOT NULL AND number <> '' AND state IN ('done', 'issued') ORDER BY created_at DESC, ref LIMIT ? OFFSET ?`);
  const madeCount = db.prepare(`SELECT COUNT(*) AS n FROM invoice_queue WHERE user_id = ? AND number IS NOT NULL AND number <> '' AND state IN ('done', 'issued')`);
  const firstPay = db.prepare(`SELECT MIN(created_at) AS at FROM invoice_queue WHERE user_id = ? AND ref NOT LIKE 'storno:%'`);
  const stopped = db.prepare(`SELECT ${INVOICE_COLUMNS} FROM invoice_queue WHERE state IN ('failed', 'check') ORDER BY updated_at DESC, ref LIMIT ? OFFSET ?`);
  const countsByState = db.prepare('SELECT state, COUNT(*) AS n FROM invoice_queue GROUP BY state');
  const euSales = db.prepare('SELECT SUM(eu_minor) AS n FROM invoice_queue WHERE created_at >= ? AND created_at < ?');
  const oneInvoice = db.prepare(`SELECT ${INVOICE_COLUMNS} FROM invoice_queue WHERE ref = ?`);
  const keepDocument = db.prepare('INSERT OR IGNORE INTO invoice_documents (ref, document, created_at) VALUES (?, ?, ?)');
  const oneInvoiceDocument = db.prepare('SELECT document FROM invoice_documents WHERE ref = ?');

  const tokens = db.prepare('SELECT sealed, access_expires_at, refresh_expires_at, authorised_at, updated_at FROM efactura_auth WHERE id = 1');
  const saveTokens = db.prepare(`INSERT INTO efactura_auth (id, sealed, access_expires_at, refresh_expires_at, authorised_at, updated_at) VALUES (1, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET sealed = excluded.sealed, access_expires_at = excluded.access_expires_at, refresh_expires_at = excluded.refresh_expires_at, authorised_at = excluded.authorised_at, updated_at = excluded.updated_at`);
  const beginAuth = db.prepare('INSERT INTO efactura_pending (id, state, created_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state, created_at = excluded.created_at');
  // Only the state asked for is taken: anyone can call the callback, and a wrong state must not spend the right one.
  const takePending = db.prepare('DELETE FROM efactura_pending WHERE id = 1 AND state = ? RETURNING created_at');
  const oneDocument = db.prepare(`SELECT ${EFACTURA_COLUMNS} FROM efactura_documents WHERE draft_id = ?`);
  const newSeries = db.prepare('INSERT OR IGNORE INTO efactura_series (series, next_number) VALUES (?, 1)');
  const takeNumber = db.prepare('UPDATE efactura_series SET next_number = next_number + 1 WHERE series = ? RETURNING next_number - 1 AS n');
  const putDocument = db.prepare(`INSERT INTO efactura_documents (draft_id, kind, series, number, issue_date, reverses, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const newestDocuments = db.prepare(`SELECT ${EFACTURA_COLUMNS} FROM efactura_documents ORDER BY created_at DESC, number DESC LIMIT ? OFFSET ?`);
  const countDocuments = db.prepare('SELECT COUNT(*) AS n FROM efactura_documents');
  const reserve = db.transaction((draftId: string, kind: string, series: string, issueDate: string, at: string, reverses: string | null) => {
    const existing = oneDocument.get(draftId) as EfacturaDocument | undefined;
    if (existing) return existing;
    newSeries.run(series);
    const { n } = takeNumber.get(series) as { n: number };
    putDocument.run(draftId, kind, series, n, issueDate, reverses, at, at);
    return oneDocument.get(draftId) as EfacturaDocument;
  });
  const finish = db.transaction((state: string, now: string, maxAgeMs: number) => {
    const pending = takePending.get(state) as { created_at: string } | undefined;
    return !!pending && Date.parse(now) - Date.parse(pending.created_at) <= maxAgeMs;
  });

  const row = (statement: ReturnType<Database['prepare']>, key: string) => {
    const r = statement.get(key) as Record<string, unknown> | undefined;
    return r ? asSubscription(r) : null;
  };

  return {
    async get(userId) { return row(get, userId); },
    async subscriptions(limit, offset = 0) { return (all.all(limit, offset) as Array<Record<string, unknown>>).map(asSubscription); },
    async subscriptionCount() { return Number((subscriptionCount.get() as { n: number }).n); },
    async findBySubscription(id) { return row(bySubscription, id); },
    async findByCustomer(id) { return row(byCustomer, id); },
    async put(s) {
      put.run(s.user_id, s.provider, s.customer_id, s.subscription_id, s.interval, s.plan, s.status, s.founding ? 1 : 0, s.current_period_end, s.cancel_scheduled ? 1 : 0, s.updated_at);
    },
    async foundingHeld() { return Math.max((founding.get() as { n: number }).n, Number((taken.get() as { n: number }).n)); },
    async recordEvent(id, at) { return event.run(id, at).changes === 1; },
    async pruneEvents(before) { return prune.run(before).changes; },
    async customerOf(userId) { return ((customer.get(userId) as { customer_id: string } | undefined)?.customer_id) ?? null; },
    async setCustomer(userId, customerId, at) { setCustomer.run(userId, customerId, at); },
    async requestWithdrawal(id, userId, at) { return requestW.run(id, userId, at).changes === 1; },
    async withdrawals(state, limit, offset = 0) { return (state === null ? allW.all(limit, offset) : byStateW.all(state, limit, offset)) as WithdrawalRecord[]; },
    async refundedWithdrawalsOf(userId) { return Number((refundedW.get(userId) as { n: number }).n); },
    async withdrawalCount(state) { return Number(((state === null ? countW.get() : countByStateW.get(state)) as { n: number }).n); },
    async withdrawal(id) { return (oneW.get(id) as WithdrawalRecord | undefined) ?? null; },
    async openWithdrawalOf(userId) { return (openW.get(userId) as WithdrawalRecord | undefined) ?? null; },
    async decideWithdrawal(id, d, at) { decideW.run(d.state, at, d.refundedMinor, d.note, id); },
    async invoicesOf(userId) { return ofUser.all(userId) as QueuedInvoice[]; },
    async invoicesMadeOf(userId, limit, offset = 0) { return made.all(userId, limit, offset) as QueuedInvoice[]; },
    async invoicesMadeCountOf(userId) { return Number((madeCount.get(userId) as { n: number }).n); },
    async firstPaymentAt(userId) { return ((firstPay.get(userId) as { at: string | null }).at) ?? null; },
    async invoicesStopped(limit, offset = 0) { return stopped.all(limit, offset) as QueuedInvoice[]; },
    async invoiceCounts() {
      const counts: Record<string, number> = { pending: 0, issued: 0, done: 0, failed: 0, check: 0 };
      for (const r of countsByState.all() as Array<{ state: string; n: number }>) counts[r.state] = Number(r.n);
      return counts as Record<InvoiceState, number>;
    },
    async euSalesMinor(year) { return Number((euSales.get(`${year}-01-01`, `${year + 1}-01-01`) as { n: number | null }).n ?? 0); },
    async queueInvoice(ref, userId, at) { return queue.run(ref, userId, at, at, at).changes === 1; },
    async invoicesDue(now, limit) { return due.all(now, limit) as QueuedInvoice[]; },
    async invoice(ref) { return (oneInvoice.get(ref) as QueuedInvoice | undefined) ?? null; },
    async keepInvoiceDocument(ref, document, at) { keepDocument.run(ref, document, at); },
    async invoiceDocument(ref) { return ((oneInvoiceDocument.get(ref) as { document: string } | undefined)?.document) ?? null; },
    async updateInvoice(ref, patch: InvoicePatch, at) {
      const known = Object.entries(patch).filter(([k]) => INVOICE_FIELDS.includes(k));
      if (known.length === 0) return;
      db.prepare(`UPDATE invoice_queue SET ${known.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE ref = ?`).run(...known.map(([, v]) => v as string | number | null), at, ref);
    },
    async efacturaTokens() { return (tokens.get() as EfacturaTokensRow | undefined) ?? null; },
    async efacturaSaveTokens(t) { saveTokens.run(t.sealed, t.access_expires_at, t.refresh_expires_at, t.authorised_at, t.updated_at); },
    async efacturaBeginAuthorisation(state, at) { beginAuth.run(state, at); },
    async efacturaFinishAuthorisation(state, now, maxAgeMs) { return finish(state, now, maxAgeMs); },
    async efacturaReserve(draftId, kind, series, issueDate, at, reverses) { return reserve(draftId, kind, series, issueDate, at, reverses); },
    async efacturaDocument(draftId) { return (oneDocument.get(draftId) as EfacturaDocument | undefined) ?? null; },
    async efacturaUpdateDocument(draftId, patch: EfacturaDocumentPatch, at) {
      const known = Object.entries(patch).filter(([k]) => EFACTURA_FIELDS.includes(k));
      if (known.length === 0) return;
      db.prepare(`UPDATE efactura_documents SET ${known.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE draft_id = ?`).run(...known.map(([, v]) => v as string | null), at, draftId);
    },
    async efacturaDocuments(limit, offset = 0) { return newestDocuments.all(limit, offset) as EfacturaDocument[]; },
    async efacturaDocumentCount() { return Number((countDocuments.get() as { n: number }).n); },
  };
}

export function metricsRepository(db: Database): MetricsRepository {
  const bump = db.prepare('INSERT INTO metrics (name, day, n) VALUES (?, ?, 1) ON CONFLICT (name, day) DO UPDATE SET n = n + 1');
  const totals = db.prepare('SELECT name, SUM(n) AS total FROM metrics WHERE day >= ? GROUP BY name ORDER BY name');
  return {
    async bump(name, day) { bump.run(name, day); },
    async totals(sinceDay) { return (totals.all(sinceDay) as Array<{ name: string; total: number }>).map(r => ({ name: r.name, total: Number(r.total) })); },
  };
}

export function waitlistRepository(db: Database): WaitlistRepository {
  const add = db.prepare('INSERT OR IGNORE INTO waitlist (email, created_at, source) VALUES (?, ?, ?)');
  const list = db.prepare('SELECT email, created_at, source FROM waitlist ORDER BY created_at, email');
  const remove = db.prepare('DELETE FROM waitlist WHERE email = ?');
  const count = db.prepare('SELECT COUNT(*) AS n FROM waitlist');
  return {
    async count() { return (count.get() as { n: number }).n; },
    async add(email, at, source) { return add.run(email, at, source).changes === 1; },
    async list() { return list.all() as Array<{ email: string; created_at: string; source: string | null }>; },
    async remove(email) { return remove.run(email).changes === 1; },
  };
}

export function settingsRepository(db: Database): OperatorSettingsRepository {
  const all = db.prepare('SELECT key, value, updated_at FROM operator_settings ORDER BY key');
  const set = db.prepare('INSERT INTO operator_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');
  const clear = db.prepare('DELETE FROM operator_settings WHERE key = ?');
  return {
    async all() { return all.all() as Array<{ key: string; value: string; updated_at: string }>; },
    async set(key, value, at) { set.run(key, value, at); },
    async clear(key) { clear.run(key); },
  };
}

export function catalogRepository(db: Database): CatalogRepository {
  const PRICE = 'id, product_id, period, currency, amount_minor, version, created_at';
  const products = db.prepare('SELECT id, name, description, on_sale, updated_at FROM catalog_products ORDER BY id');
  const saveProduct = db.prepare('INSERT INTO catalog_products (id, name, description, on_sale, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description, on_sale = excluded.on_sale, updated_at = excluded.updated_at');
  const prices = db.prepare(`SELECT ${PRICE} FROM catalog_prices ORDER BY created_at, version, id`);
  const addPrice = db.prepare(`INSERT INTO catalog_prices (id, product_id, period, currency, amount_minor, version, created_at)
    SELECT @product || ':' || @period || ':' || @currency || ':' || (COALESCE(MAX(version), 0) + 1), @product, @period, @currency, @amount, COALESCE(MAX(version), 0) + 1, @at FROM catalog_prices WHERE product_id = @product AND period = @period AND currency = @currency
    RETURNING ${PRICE}`);
  const links = db.prepare('SELECT price_id, provider, provider_product_id, provider_price_id, synced_at, archived_at FROM catalog_links WHERE provider = ? ORDER BY price_id');
  const saveLink = db.prepare('INSERT INTO catalog_links (price_id, provider, provider_product_id, provider_price_id, synced_at, archived_at) VALUES (?, ?, ?, ?, ?, NULL) ON CONFLICT (price_id, provider) DO UPDATE SET provider_product_id = excluded.provider_product_id, provider_price_id = excluded.provider_price_id, synced_at = excluded.synced_at');
  const archiveLink = db.prepare('UPDATE catalog_links SET archived_at = ? WHERE price_id = ? AND provider = ? AND archived_at IS NULL');
  return {
    async products() { return products.all() as CatalogProduct[]; },
    async saveProduct(p, at) { saveProduct.run(p.id, p.name, p.description, p.on_sale, at); },
    async prices() { return prices.all() as CatalogPrice[]; },
    async addPrice(p, at) { return addPrice.get({ product: p.product_id, period: p.period, currency: p.currency, amount: p.amount_minor, at }) as CatalogPrice; },
    async links(provider) { return links.all(provider) as CatalogLink[]; },
    async saveLink(l) { saveLink.run(l.price_id, l.provider, l.provider_product_id, l.provider_price_id, l.synced_at); },
    async archiveLink(priceId, provider, at) { archiveLink.run(at, priceId, provider); },
  };
}
