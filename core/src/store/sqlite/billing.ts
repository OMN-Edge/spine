import type { Database } from './driver.js';
import type { BillingRepository, MetricsRepository, SubscriptionRecord, WaitlistRepository } from '../types.js';

const COLUMNS = 'user_id, provider, customer_id, subscription_id, billing_interval, status, founding, current_period_end, cancel_scheduled, updated_at';

const asSubscription = (r: Record<string, unknown>): SubscriptionRecord => ({
  user_id: r.user_id as string,
  provider: r.provider as SubscriptionRecord['provider'],
  customer_id: (r.customer_id as string | null) ?? null,
  subscription_id: (r.subscription_id as string | null) ?? null,
  interval: (r.billing_interval as SubscriptionRecord['interval']) ?? null,
  status: r.status as string,
  founding: r.founding === 1,
  current_period_end: (r.current_period_end as string | null) ?? null,
  cancel_scheduled: r.cancel_scheduled === 1,
  updated_at: r.updated_at as string,
});

/** The account's own row is read with its id; the provider's side finds one by the provider's ids (store/types.ts, exceptions). */
export function billingRepository(db: Database): BillingRepository {
  const get = db.prepare(`SELECT ${COLUMNS} FROM subscriptions WHERE user_id = ?`);
  const bySubscription = db.prepare(`SELECT ${COLUMNS} FROM subscriptions WHERE subscription_id = ?`);
  const byCustomer = db.prepare(`SELECT ${COLUMNS} FROM subscriptions WHERE customer_id = ?`);
  const put = db.prepare(`INSERT INTO subscriptions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET provider = excluded.provider, customer_id = excluded.customer_id, subscription_id = excluded.subscription_id,
      billing_interval = excluded.billing_interval, status = excluded.status, founding = excluded.founding,
      current_period_end = excluded.current_period_end, cancel_scheduled = excluded.cancel_scheduled, updated_at = excluded.updated_at`);
  // Held: the founding price of a subscription that has not ended.
  const founding = db.prepare(`SELECT COUNT(*) AS n FROM subscriptions WHERE founding = 1 AND (status IN ('active', 'trialing', 'past_due') OR current_period_end > ?)`);
  const event = db.prepare('INSERT OR IGNORE INTO billing_events (id, at) VALUES (?, ?)');
  const prune = db.prepare('DELETE FROM billing_events WHERE at < ?');

  const row = (statement: ReturnType<Database['prepare']>, key: string) => {
    const r = statement.get(key) as Record<string, unknown> | undefined;
    return r ? asSubscription(r) : null;
  };

  return {
    async get(userId) { return row(get, userId); },
    async findBySubscription(id) { return row(bySubscription, id); },
    async findByCustomer(id) { return row(byCustomer, id); },
    async put(s) {
      put.run(s.user_id, s.provider, s.customer_id, s.subscription_id, s.interval, s.status, s.founding ? 1 : 0, s.current_period_end, s.cancel_scheduled ? 1 : 0, s.updated_at);
    },
    async foundingHeld(now) { return (founding.get(now) as { n: number }).n; },
    async recordEvent(id, at) { return event.run(id, at).changes === 1; },
    async pruneEvents(before) { return prune.run(before).changes; },
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
  return {
    async add(email, at, source) { return add.run(email, at, source).changes === 1; },
    async list() { return list.all() as Array<{ email: string; created_at: string; source: string | null }>; },
    async remove(email) { return remove.run(email).changes === 1; },
  };
}
