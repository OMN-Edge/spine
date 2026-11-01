import type { BillingRepository, MetricsRepository, SubscriptionRecord, WaitlistRepository } from '../types.js';
import { changed, many, one, type Query } from './query.js';

const COLUMNS = 'user_id, provider, customer_id, subscription_id, billing_interval, plan, status, founding, current_period_end, cancel_scheduled, updated_at';

const asSubscription = (r: Record<string, unknown>): SubscriptionRecord => ({
  user_id: r.user_id as string,
  provider: r.provider as SubscriptionRecord['provider'],
  customer_id: (r.customer_id as string | null) ?? null,
  subscription_id: (r.subscription_id as string | null) ?? null,
  interval: (r.billing_interval as SubscriptionRecord['interval']) ?? null,
  plan: r.plan === 'family' ? 'family' : 'premium',
  status: r.status as string,
  founding: r.founding === 1,
  current_period_end: (r.current_period_end as string | null) ?? null,
  cancel_scheduled: r.cancel_scheduled === 1,
  updated_at: r.updated_at as string,
});

export function billingRepository(q: Query): BillingRepository {
  const find = async (where: string, key: string) => {
    const r = await one(q, `SELECT ${COLUMNS} FROM subscriptions WHERE ${where} = $1`, [key]);
    return r ? asSubscription(r) : null;
  };
  return {
    get: userId => find('user_id', userId),
    findBySubscription: id => find('subscription_id', id),
    findByCustomer: id => find('customer_id', id),
    async put(s) {
      await q(`INSERT INTO subscriptions (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (user_id) DO UPDATE SET provider = excluded.provider, customer_id = excluded.customer_id, subscription_id = excluded.subscription_id,
          billing_interval = excluded.billing_interval, plan = excluded.plan, status = excluded.status, founding = excluded.founding,
          current_period_end = excluded.current_period_end, cancel_scheduled = excluded.cancel_scheduled, updated_at = excluded.updated_at`,
      [s.user_id, s.provider, s.customer_id, s.subscription_id, s.interval, s.plan, s.status, s.founding ? 1 : 0, s.current_period_end, s.cancel_scheduled ? 1 : 0, s.updated_at]);
    },
    async foundingHeld(now) {
      return Number((await one<{ n: number }>(q, `SELECT COUNT(*) AS n FROM subscriptions WHERE founding = 1 AND (status IN ('active', 'trialing', 'past_due') OR current_period_end > $1)`, [now]))!.n);
    },
    async recordEvent(id, at) { return (await changed(q, 'INSERT INTO billing_events (id, at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, at])) === 1; },
    async pruneEvents(before) { return changed(q, 'DELETE FROM billing_events WHERE at < $1', [before]); },
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
    async add(email, at, source) { return (await changed(q, 'INSERT INTO waitlist (email, created_at, source) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [email, at, source])) === 1; },
    async list() { return many<{ email: string; created_at: string; source: string | null }>(q, 'SELECT email, created_at, source FROM waitlist ORDER BY created_at, email'); },
    async remove(email) { return (await changed(q, 'DELETE FROM waitlist WHERE lower(email) = lower($1)', [email])) === 1; },
  };
}
