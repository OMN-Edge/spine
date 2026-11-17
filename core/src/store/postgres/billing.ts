import type { BillingRepository, CatalogLink, CatalogPrice, CatalogProduct, CatalogRepository, EfacturaDocument, EfacturaDocumentPatch, EfacturaTokens, InvoicePatch, InvoiceState, QueuedInvoice, WithdrawalRecord, MetricsRepository, OperatorSettingsRepository, SubscriptionRecord, WaitlistRepository } from '../types.js';
import { changed, many, one, type Begin, type Query } from './query.js';

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
const asWithdrawal = (r: Record<string, unknown>): WithdrawalRecord => ({
  id: r.id as string, user_id: r.user_id as string, state: r.state as WithdrawalRecord['state'], requested_at: r.requested_at as string, decided_at: (r.decided_at as string | null) ?? null,
  refunded_minor: r.refunded_minor === null || r.refunded_minor === undefined ? null : Number(r.refunded_minor), note: (r.note as string | null) ?? null,
});
const EFACTURA_FIELDS = ['xml', 'input', 'anaf_index', 'anaf_state', 'anaf_message', 'signed'];
const EFACTURA_COLUMNS = 'draft_id, kind, series, number, issue_date, reverses, xml, input, anaf_index, anaf_state, anaf_message, signed, created_at, updated_at';
const asDocument = (r: Record<string, unknown>): EfacturaDocument => ({
  draft_id: r.draft_id as string, kind: r.kind as EfacturaDocument['kind'], series: r.series as string, number: Number(r.number), issue_date: r.issue_date as string,
  reverses: (r.reverses as string | null) ?? null, xml: (r.xml as string | null) ?? null, input: (r.input as string | null) ?? null, anaf_index: (r.anaf_index as string | null) ?? null,
  anaf_state: (r.anaf_state as EfacturaDocument['anaf_state']) ?? null, anaf_message: (r.anaf_message as string | null) ?? null, signed: (r.signed as string | null) ?? null,
  created_at: r.created_at as string, updated_at: r.updated_at as string,
});
const INVOICE_COLUMNS = 'ref, user_id, state, attempts, next_attempt_at, last_error, issuer_ref, series, number, resume, eu_minor, created_at, updated_at';
const asInvoice = (r: Record<string, unknown>): QueuedInvoice => ({
  ref: r.ref as string, user_id: (r.user_id as string | null) ?? null, state: r.state as QueuedInvoice['state'], attempts: Number(r.attempts), next_attempt_at: r.next_attempt_at as string,
  last_error: (r.last_error as string | null) ?? null, issuer_ref: (r.issuer_ref as string | null) ?? null, series: (r.series as string | null) ?? null, number: (r.number as string | null) ?? null,
  resume: (r.resume as QueuedInvoice['resume']) ?? null, eu_minor: r.eu_minor === null || r.eu_minor === undefined ? null : Number(r.eu_minor),
  created_at: r.created_at as string, updated_at: r.updated_at as string,
});

export function billingRepository(q: Query, begin: Begin): BillingRepository {
  const find = async (where: string, key: string) => {
    const r = await one(q, `SELECT ${COLUMNS} FROM subscriptions WHERE ${where} = $1`, [key]);
    return r ? asSubscription(r) : null;
  };
  return {
    get: userId => find('user_id', userId),
    subscriptions: async (limit, offset = 0) => (await many(q, `SELECT ${COLUMNS} FROM subscriptions ORDER BY updated_at DESC, user_id LIMIT $1 OFFSET $2`, [limit, offset])).map(asSubscription),
    subscriptionCount: async () => Number((await one<{ n: number }>(q, 'SELECT COUNT(*) AS n FROM subscriptions', []))!.n),
    findBySubscription: id => find('subscription_id', id),
    findByCustomer: id => find('customer_id', id),
    async put(s) {
      await q(`INSERT INTO subscriptions (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (user_id) DO UPDATE SET provider = excluded.provider, customer_id = excluded.customer_id, subscription_id = excluded.subscription_id,
          billing_interval = excluded.billing_interval, plan = excluded.plan, status = excluded.status, founding = excluded.founding,
          current_period_end = excluded.current_period_end, cancel_scheduled = excluded.cancel_scheduled, updated_at = excluded.updated_at`,
      [s.user_id, s.provider, s.customer_id, s.subscription_id, s.interval, s.plan, s.status, s.founding ? 1 : 0, s.current_period_end, s.cancel_scheduled ? 1 : 0, s.updated_at]);
    },
    async foundingHeld() {
      const rows = Number((await one<{ n: number }>(q, `SELECT COUNT(*) AS n FROM subscriptions WHERE founding = 1`, []))!.n);
      // Each founding place is also counted once, by the day, with no account in it, so a place stays taken when the account is deleted.
      const taken = Number((await one<{ n: number }>(q, `SELECT COALESCE(SUM(n), 0) AS n FROM metrics WHERE name = 'founding_taken'`, []))!.n);
      return Math.max(rows, taken);
    },
    async recordEvent(id, at) { return (await changed(q, 'INSERT INTO billing_events (id, at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, at])) === 1; },
    async pruneEvents(before) { return changed(q, 'DELETE FROM billing_events WHERE at < $1', [before]); },
    async customerOf(userId) { return (await one<{ customer_id: string }>(q, 'SELECT customer_id FROM billing_customers WHERE user_id = $1', [userId]))?.customer_id ?? null; },
    async setCustomer(userId, customerId, at) {
      await q('INSERT INTO billing_customers (user_id, customer_id, updated_at) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET customer_id = excluded.customer_id, updated_at = excluded.updated_at', [userId, customerId, at]);
    },
    async requestWithdrawal(id, userId, at) {
      return (await changed(q, `INSERT INTO withdrawal_requests (id, user_id, state, requested_at) VALUES ($1, $2, 'requested', $3) ON CONFLICT DO NOTHING`, [id, userId, at])) === 1;
    },
    async withdrawals(state, limit, offset = 0) {
      const rows = state === null
        ? await many(q, `SELECT ${WITHDRAWAL_COLUMNS} FROM withdrawal_requests ORDER BY requested_at DESC, id LIMIT $1 OFFSET $2`, [limit, offset])
        : await many(q, `SELECT ${WITHDRAWAL_COLUMNS} FROM withdrawal_requests WHERE state = $1 ORDER BY requested_at DESC, id LIMIT $2 OFFSET $3`, [state, limit, offset]);
      return rows.map(asWithdrawal);
    },
    async refundedWithdrawalsOf(userId) { return Number((await one<{ n: number }>(q, `SELECT COUNT(*) AS n FROM withdrawal_requests WHERE user_id = $1 AND state = 'refunded'`, [userId]))!.n); },
    async withdrawalCount(state) {
      return Number((await one<{ n: number }>(q, state === null ? 'SELECT COUNT(*) AS n FROM withdrawal_requests' : 'SELECT COUNT(*) AS n FROM withdrawal_requests WHERE state = $1', state === null ? [] : [state]))!.n);
    },
    async withdrawal(id) { const r = await one(q, `SELECT ${WITHDRAWAL_COLUMNS} FROM withdrawal_requests WHERE id = $1`, [id]); return r ? asWithdrawal(r) : null; },
    async openWithdrawalOf(userId) { const r = await one(q, `SELECT ${WITHDRAWAL_COLUMNS} FROM withdrawal_requests WHERE user_id = $1 AND state = 'requested'`, [userId]); return r ? asWithdrawal(r) : null; },
    async decideWithdrawal(id, d, at) { await q('UPDATE withdrawal_requests SET state = $1, decided_at = $2, refunded_minor = $3, note = $4 WHERE id = $5', [d.state, at, d.refundedMinor, d.note, id]); },
    async invoicesOf(userId) { return (await many(q, `SELECT ${INVOICE_COLUMNS} FROM invoice_queue WHERE user_id = $1 ORDER BY created_at DESC`, [userId])).map(asInvoice); },
    async invoicesMadeOf(userId, limit, offset = 0) {
      return (await many(q, `SELECT ${INVOICE_COLUMNS} FROM invoice_queue WHERE user_id = $1 AND number IS NOT NULL AND number <> '' AND state IN ('done', 'issued') ORDER BY created_at DESC, ref LIMIT $2 OFFSET $3`, [userId, limit, offset])).map(asInvoice);
    },
    async invoicesMadeCountOf(userId) {
      return Number((await one<{ n: number }>(q, `SELECT COUNT(*) AS n FROM invoice_queue WHERE user_id = $1 AND number IS NOT NULL AND number <> '' AND state IN ('done', 'issued')`, [userId]))!.n);
    },
    async firstPaymentAt(userId) { return (await one<{ at: string | null }>(q, `SELECT MIN(created_at) AS at FROM invoice_queue WHERE user_id = $1 AND ref NOT LIKE 'storno:%'`, [userId]))?.at ?? null; },
    async invoicesStopped(limit, offset = 0) {
      return (await many(q, `SELECT ${INVOICE_COLUMNS} FROM invoice_queue WHERE state IN ('failed', 'check') ORDER BY updated_at DESC, ref LIMIT $1 OFFSET $2`, [limit, offset])).map(asInvoice);
    },
    async invoiceCounts() {
      const counts: Record<string, number> = { pending: 0, issued: 0, done: 0, failed: 0, check: 0 };
      for (const r of await many<{ state: string; n: number }>(q, 'SELECT state, COUNT(*) AS n FROM invoice_queue GROUP BY state', [])) counts[r.state] = Number(r.n);
      return counts as Record<InvoiceState, number>;
    },
    async euSalesMinor(year) {
      return Number((await one<{ n: number | null }>(q, 'SELECT SUM(eu_minor) AS n FROM invoice_queue WHERE created_at >= $1 AND created_at < $2', [`${year}-01-01`, `${year + 1}-01-01`]))?.n ?? 0);
    },
    async queueInvoice(ref, userId, at) {
      return (await changed(q, `INSERT INTO invoice_queue (ref, user_id, state, attempts, next_attempt_at, created_at, updated_at) VALUES ($1, $2, 'pending', 0, $3, $3, $3) ON CONFLICT DO NOTHING`, [ref, userId, at])) === 1;
    },
    async invoicesDue(now, limit) {
      return (await many(q, `SELECT ${INVOICE_COLUMNS} FROM invoice_queue WHERE state IN ('pending', 'issued') AND next_attempt_at <= $1 ORDER BY created_at LIMIT $2`, [now, limit])).map(asInvoice);
    },
    async invoice(ref) {
      const r = await one(q, `SELECT ${INVOICE_COLUMNS} FROM invoice_queue WHERE ref = $1`, [ref]);
      return r ? asInvoice(r) : null;
    },
    async updateInvoice(ref, patch: InvoicePatch, at) {
      const known = Object.entries(patch).filter(([k]) => INVOICE_FIELDS.includes(k));
      if (known.length === 0) return;
      await q(`UPDATE invoice_queue SET ${known.map(([k], i) => `${k} = $${i + 1}`).join(', ')}, updated_at = $${known.length + 1} WHERE ref = $${known.length + 2}`, [...known.map(([, v]) => v), at, ref]);
    },
    async efacturaTokens() {
      const r = await one<EfacturaTokens>(q, 'SELECT sealed, access_expires_at, refresh_expires_at, authorised_at, updated_at FROM efactura_auth WHERE id = 1');
      return r ? { sealed: r.sealed, access_expires_at: r.access_expires_at, refresh_expires_at: r.refresh_expires_at, authorised_at: r.authorised_at, updated_at: r.updated_at } : null;
    },
    async efacturaSaveTokens(t) {
      await q(`INSERT INTO efactura_auth (id, sealed, access_expires_at, refresh_expires_at, authorised_at, updated_at) VALUES (1, $1, $2, $3, $4, $5)
        ON CONFLICT (id) DO UPDATE SET sealed = excluded.sealed, access_expires_at = excluded.access_expires_at, refresh_expires_at = excluded.refresh_expires_at, authorised_at = excluded.authorised_at, updated_at = excluded.updated_at`,
      [t.sealed, t.access_expires_at, t.refresh_expires_at, t.authorised_at, t.updated_at]);
    },
    async efacturaBeginAuthorisation(state, at) {
      await q('INSERT INTO efactura_pending (id, state, created_at) VALUES (1, $1, $2) ON CONFLICT (id) DO UPDATE SET state = excluded.state, created_at = excluded.created_at', [state, at]);
    },
    async efacturaFinishAuthorisation(state, now, maxAgeMs) {
      // Only the state asked for is taken: anyone can call the callback, and a wrong state must not spend the right one.
      const pending = await one<{ created_at: string }>(q, 'DELETE FROM efactura_pending WHERE id = 1 AND state = $1 RETURNING created_at', [state]);
      return !!pending && Date.parse(now) - Date.parse(pending.created_at) <= maxAgeMs;
    },
    async efacturaReserve(draftId, kind, series, issueDate, at, reverses) {
      return begin(async tq => {
        const existing = await one(tq, `SELECT ${EFACTURA_COLUMNS} FROM efactura_documents WHERE draft_id = $1`, [draftId]);
        if (existing) return asDocument(existing);
        await tq('INSERT INTO efactura_series (series, next_number) VALUES ($1, 1) ON CONFLICT DO NOTHING', [series]);
        // The counter's row lock makes two requests take turns. If both were for one draft, the second fails on the draft's key and rolls back with the counter, so no number is given and lost; asked again, it finds the first's document above.
        const taken = await one<{ n: number }>(tq, 'UPDATE efactura_series SET next_number = next_number + 1 WHERE series = $1 RETURNING next_number - 1 AS n', [series]);
        await tq('INSERT INTO efactura_documents (draft_id, kind, series, number, issue_date, reverses, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)', [draftId, kind, series, Number(taken!.n), issueDate, reverses, at]);
        return asDocument((await one(tq, `SELECT ${EFACTURA_COLUMNS} FROM efactura_documents WHERE draft_id = $1`, [draftId]))!);
      });
    },
    async efacturaDocument(draftId) {
      const r = await one(q, `SELECT ${EFACTURA_COLUMNS} FROM efactura_documents WHERE draft_id = $1`, [draftId]);
      return r ? asDocument(r) : null;
    },
    async efacturaUpdateDocument(draftId, patch: EfacturaDocumentPatch, at) {
      const known = Object.entries(patch).filter(([k]) => EFACTURA_FIELDS.includes(k));
      if (known.length === 0) return;
      await q(`UPDATE efactura_documents SET ${known.map(([k], i) => `${k} = $${i + 1}`).join(', ')}, updated_at = $${known.length + 1} WHERE draft_id = $${known.length + 2}`, [...known.map(([, v]) => v), at, draftId]);
    },
    async efacturaDocuments(limit, offset = 0) {
      return (await many(q, `SELECT ${EFACTURA_COLUMNS} FROM efactura_documents ORDER BY created_at DESC, number DESC LIMIT $1 OFFSET $2`, [limit, offset])).map(asDocument);
    },
    async efacturaDocumentCount() { return Number((await one<{ n: number }>(q, 'SELECT COUNT(*) AS n FROM efactura_documents', []))!.n); },
  };
}

export function metricsRepository(q: Query): MetricsRepository {
  return {
    async bump(name, day) { await q('INSERT INTO metrics (name, day, n) VALUES ($1, $2, 1) ON CONFLICT (name, day) DO UPDATE SET n = metrics.n + 1', [name, day]); },
    async totals(sinceDay) { return (await many<{ name: string; total: number }>(q, 'SELECT name, SUM(n) AS total FROM metrics WHERE day >= $1 GROUP BY name ORDER BY name', [sinceDay])).map(r => ({ name: r.name, total: Number(r.total) })); },
  };
}

export function waitlistRepository(q: Query): WaitlistRepository {
  return {
    async count() { return Number((await one<{ n: number }>(q, 'SELECT COUNT(*) AS n FROM waitlist', []))!.n); },
    async add(email, at, source) { return (await changed(q, 'INSERT INTO waitlist (email, created_at, source) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [email, at, source])) === 1; },
    async list() { return many<{ email: string; created_at: string; source: string | null }>(q, 'SELECT email, created_at, source FROM waitlist ORDER BY created_at, email'); },
    async remove(email) { return (await changed(q, 'DELETE FROM waitlist WHERE lower(email) = lower($1)', [email])) === 1; },
  };
}

export function settingsRepository(q: Query): OperatorSettingsRepository {
  return {
    async all() { return many<{ key: string; value: string; updated_at: string }>(q, 'SELECT key, value, updated_at FROM operator_settings ORDER BY key'); },
    async set(key, value, at) { await q('INSERT INTO operator_settings (key, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', [key, value, at]); },
    async clear(key) { await q('DELETE FROM operator_settings WHERE key = $1', [key]); },
  };
}

export function catalogRepository(q: Query): CatalogRepository {
  const PRICE = 'id, product_id, period, currency, amount_minor, version, created_at';
  return {
    async products() { return many<CatalogProduct>(q, 'SELECT id, name, description, on_sale, updated_at FROM catalog_products ORDER BY id'); },
    async saveProduct(p, at) {
      await q('INSERT INTO catalog_products (id, name, description, on_sale, updated_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description, on_sale = excluded.on_sale, updated_at = excluded.updated_at',
        [p.id, p.name, p.description, p.on_sale, at]);
    },
    async prices() { return (await many<CatalogPrice>(q, `SELECT ${PRICE} FROM catalog_prices ORDER BY created_at, version, id`)).map(r => ({ ...r, amount_minor: Number(r.amount_minor), version: Number(r.version) })); },
    async addPrice(p, at) {
      const row = (await one<CatalogPrice>(q, `INSERT INTO catalog_prices (id, product_id, period, currency, amount_minor, version, created_at)
        SELECT $1 || ':' || $2 || ':' || $3 || ':' || (COALESCE(MAX(version), 0) + 1), $1, $2, $3, $4, COALESCE(MAX(version), 0) + 1, $5 FROM catalog_prices WHERE product_id = $1 AND period = $2 AND currency = $3
        RETURNING ${PRICE}`, [p.product_id, p.period, p.currency, p.amount_minor, at]))!;
      return { ...row, amount_minor: Number(row.amount_minor), version: Number(row.version) };
    },
    async links(provider) { return many<CatalogLink>(q, 'SELECT price_id, provider, provider_product_id, provider_price_id, synced_at, archived_at FROM catalog_links WHERE provider = $1 ORDER BY price_id', [provider]); },
    async saveLink(l) {
      await q('INSERT INTO catalog_links (price_id, provider, provider_product_id, provider_price_id, synced_at, archived_at) VALUES ($1, $2, $3, $4, $5, NULL) ON CONFLICT (price_id, provider) DO UPDATE SET provider_product_id = excluded.provider_product_id, provider_price_id = excluded.provider_price_id, synced_at = excluded.synced_at',
        [l.price_id, l.provider, l.provider_product_id, l.provider_price_id, l.synced_at]);
    },
    async archiveLink(priceId, provider, at) { await q('UPDATE catalog_links SET archived_at = $1 WHERE price_id = $2 AND provider = $3 AND archived_at IS NULL', [at, priceId, provider]); },
  };
}
