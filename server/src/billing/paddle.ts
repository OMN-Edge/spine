import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SubscriptionRecord } from 'spine-core/store/types.js';
import type { BillingConfig } from './config.js';

type Enabled = Extract<BillingConfig, { enabled: true }>;

/** The longest a delivery's timestamp may differ from our clock. Paddle's own libraries use five seconds; a retry is signed again, and an event is applied once whatever its age. */
const TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Checks the `Paddle-Signature` header (`ts=<unix>;h1=<hex>`, more than one `h1` while a secret is being rotated): HMAC-SHA256 of
 * `<ts>:<raw body>` under the destination's secret. The raw body, byte for byte: a parsed and printed copy would not match.
 */
export function verifySignature(secret: string, header: string | undefined, rawBody: string, now = Date.now()): boolean {
  if (!header) return false;
  const parts = header.split(';').map(p => p.trim().split('='));
  const ts = parts.find(([k]) => k === 'ts')?.[1];
  const signatures = parts.filter(([k]) => k === 'h1').map(([, v]) => v).filter((v): v is string => !!v);
  if (!ts || !/^\d+$/.test(ts) || signatures.length === 0) return false;
  if (Math.abs(now - Number(ts) * 1000) > TOLERANCE_MS) return false;
  const expected = createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest();
  return signatures.some(sig => {
    const given = Buffer.from(sig, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** What a webhook delivery says, as far as Spine uses it. Anything else in it is ignored. */
export interface PaddleEvent {
  event_id: string;
  event_type: string;
  /** When the provider made it happen; a delivery older than what is already known is not applied. */
  occurred_at?: string;
  data: {
    id?: string;
    status?: string;
    customer_id?: string;
    subscription_id?: string;
    custom_data?: { user_id?: unknown } | null;
    items?: Array<{ price?: { id?: string } }>;
    billing_cycle?: { interval?: string };
    current_billing_period?: { ends_at?: string } | null;
    next_billed_at?: string | null;
    scheduled_change?: { action?: string } | null;
  };
}

export function parseEvent(rawBody: string): PaddleEvent | null {
  try {
    const e = JSON.parse(rawBody) as Partial<PaddleEvent>;
    if (typeof e.event_id !== 'string' || typeof e.event_type !== 'string' || !e.data || typeof e.data !== 'object') return null;
    return e as PaddleEvent;
  } catch {
    return null;
  }
}

const isoOrNull = (value: string | null | undefined): string | null => {
  const t = value ? Date.parse(value) : NaN;
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

/** The user a delivery names, if it names one: the id Spine put in the transaction's custom data. */
export const userOf = (event: PaddleEvent): string | null => {
  const id = event.data.custom_data?.user_id;
  return typeof id === 'string' && id.length > 0 && id.length <= 64 ? id : null;
};

/** What a purchase is for, from the prices on it: the family plan if one of its prices is there, else Premium. */
export function planOfItems(items: PaddleEvent['data']['items'], config: Enabled): 'premium' | 'family' {
  const family = config.family;
  return family && (items ?? []).some(i => i.price?.id === family.year || i.price?.id === family.month) ? 'family' : 'premium';
}

/** The account's row after a `subscription.*` delivery. Fields the delivery lacks keep what was known. */
export function applySubscriptionEvent(previous: SubscriptionRecord | null, userId: string, event: PaddleEvent, config: Enabled, now: string): SubscriptionRecord {
  const d = event.data;
  const interval = d.billing_cycle?.interval === 'month' || d.billing_cycle?.interval === 'year' ? d.billing_cycle.interval : previous?.interval ?? null;
  return {
    user_id: userId,
    provider: 'paddle',
    customer_id: d.customer_id ?? previous?.customer_id ?? null,
    subscription_id: d.id ?? previous?.subscription_id ?? null,
    interval,
    // Which plan is what the prices on the subscription say; a message that lists none keeps what was known.
    plan: (d.items ?? []).length > 0 ? planOfItems(d.items, config) : previous?.plan ?? 'premium',
    status: d.status ?? previous?.status ?? 'active',
    founding: previous?.founding === true || (d.items ?? []).some(i => i.price?.id === config.prices.founding),
    // A subscription that ended keeps the end it had: that is what was paid for.
    current_period_end: isoOrNull(d.current_billing_period?.ends_at) ?? isoOrNull(d.next_billed_at) ?? previous?.current_period_end ?? null,
    cancel_scheduled: d.scheduled_change?.action === 'cancel' || d.status === 'canceled',
    updated_at: now,
  };
}

async function call(config: Enabled, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const base = config.environment === 'sandbox' ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`the payment provider answered ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** A transaction for one price whose checkout is the page at `SPINE_CHECKOUT_URL`; the answer is where to send the person. */
export async function createCheckout(config: Enabled, priceId: string, userId: string): Promise<string> {
  const out = await call(config, 'POST', '/transactions', {
    items: [{ price_id: priceId, quantity: 1 }],
    custom_data: { user_id: userId },
    checkout: { url: config.checkoutUrl },
  });
  const url = ((out.data as { checkout?: { url?: string } } | undefined)?.checkout?.url) ?? '';
  if (!/^https?:\/\//.test(url)) throw new Error('the payment provider gave no checkout address');
  return url;
}

/** The provider's page where the customer changes the card, switches plan, cancels and reads invoices. */
export async function portalUrl(config: Enabled, customerId: string, subscriptionId: string | null): Promise<string> {
  const out = await call(config, 'POST', `/customers/${encodeURIComponent(customerId)}/portal-sessions`, subscriptionId ? { subscription_ids: [subscriptionId] } : {});
  const url = ((out.data as { urls?: { general?: { overview?: string } } } | undefined)?.urls?.general?.overview) ?? '';
  if (!url.startsWith('https://')) throw new Error('the payment provider gave no portal address');
  return url;
}
