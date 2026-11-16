import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { log as logger } from '../host.js';
import type { BillingProvider, Enabled, ManageAction, PriceReading, ProviderEvent, WebhookRead } from '../provider.js';

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
    custom_data?: { user_id?: unknown; addon?: unknown } | null;
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
const userOf = (event: PaddleEvent): string | null => {
  const id = event.data.custom_data?.user_id;
  return typeof id === 'string' && id.length > 0 && id.length <= 64 ? id : null;
};

async function call(config: Enabled, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const base = config.environment === 'sandbox' ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    // Paddle names what went wrong with a fixed code (`transaction_default_checkout_url_not_set`, `not_found`, …): kept for the log, since
    // an operator cannot act on a bare status. Its free-text detail is not, as it can quote what was sent.
    const code = await res.json().then(b => (b as { error?: { code?: unknown } } | null)?.error?.code, () => undefined);
    throw new Error(`the payment provider answered ${res.status}${typeof code === 'string' && /^[a-z0-9_]{1,80}$/.test(code) ? ` (${code})` : ''}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

/**
 * A transaction for one price; the answer is where to send the person. Its checkout is Paddle's default payment link, which is the page at
 * `SPINE_CHECKOUT_URL`: naming that page in the request instead would need its domain approved at Paddle, in the sandbox too, while the
 * default needs no approval there. A default that is some other page is logged, since the person would be sent there.
 */
export async function createCheckout(config: Enabled, priceId: string, userId: string, addon?: string): Promise<string> {
  const out = await call(config, 'POST', '/transactions', {
    items: [{ price_id: priceId, quantity: 1 }],
    custom_data: addon ? { user_id: userId, addon } : { user_id: userId },
  });
  const url = ((out.data as { checkout?: { url?: string } } | undefined)?.checkout?.url) ?? '';
  if (!/^https?:\/\//.test(url)) throw new Error('the payment provider gave no checkout address');
  if (config.checkoutUrl && new URL(url).origin !== new URL(config.checkoutUrl).origin) {
    logger.warn('the payment provider\'s default payment link is not SPINE_CHECKOUT_URL', { default_origin: new URL(url).origin, expected_origin: new URL(config.checkoutUrl).origin });
  }
  return url;
}

/**
 * The page where the customer changes the card, switches plan, cancels and reads invoices. A portal session made with the subscription's id comes with
 * a link for that subscription's own page, one with the cancellation form open and one with the card form open (`urls.subscriptions[]`); where the
 * link asked for is not there, the overview, which always is, so a person is never sent nowhere.
 */
export async function portalUrl(config: Enabled, customerId: string, subscriptionId: string | null, action: ManageAction = 'overview'): Promise<string> {
  const out = await call(config, 'POST', `/customers/${encodeURIComponent(customerId)}/portal-sessions`, subscriptionId ? { subscription_ids: [subscriptionId] } : {});
  const urls = (out.data as { urls?: { general?: { overview?: string }; subscriptions?: Array<Record<string, unknown>> } } | undefined)?.urls;
  const deep = action === 'cancel' ? 'cancel_subscription' : action === 'payment_method' ? 'update_subscription_payment_method' : null;
  const own = deep && subscriptionId ? urls?.subscriptions?.find(entry => entry.id === subscriptionId)?.[deep] : undefined;
  const url = typeof own === 'string' && own.startsWith('https://') ? own : urls?.general?.overview ?? '';
  if (!url.startsWith('https://')) throw new Error('the payment provider gave no portal address');
  return url;
}

/** What a Paddle delivery means in Spine's words (`provider.ts`): subscription messages, a completed transaction, and nothing else. */
export function toProviderEvent(event: PaddleEvent): ProviderEvent {
  const d = event.data;
  const priceIds = (d.items ?? []).map(i => i.price?.id).filter((id): id is string => typeof id === 'string');
  const at = isoOrNull(event.occurred_at);
  if (event.event_type.startsWith('subscription.')) {
    return {
      kind: 'subscription', id: event.event_id, at, userId: userOf(event), subscriptionId: d.id ?? null, customerId: d.customer_id ?? null,
      status: d.status ?? null, priceIds,
      interval: d.billing_cycle?.interval === 'month' || d.billing_cycle?.interval === 'year' ? d.billing_cycle.interval : null,
      // A subscription that ended keeps the end it had: that is what was paid for.
      periodEnd: isoOrNull(d.current_billing_period?.ends_at) ?? isoOrNull(d.next_billed_at),
      cancelScheduled: d.scheduled_change?.action === 'cancel' || d.status === 'canceled',
    };
  }
  if (event.event_type === 'transaction.completed') {
    return { kind: 'payment', id: event.event_id, at, userId: userOf(event), subscriptionId: d.subscription_id ?? null, customerId: d.customer_id ?? null, saleRef: null, transactionId: d.id ?? null, priceIds };
  }
  return { kind: 'ignored', id: event.event_id };
}

interface PaddlePrice { unit_price?: { amount?: string; currency_code?: string }; billing_cycle?: { interval?: string; frequency?: number } | null; status?: string }

/** What Paddle says about a price: its amount in the major unit, its currency and how often it repeats. */
export async function readPrice(config: Enabled, id: string): Promise<PriceReading> {
  const base = config.environment === 'sandbox' ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
  const res = await fetch(`${base}/prices/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`the payment provider answered ${res.status} for a price`);
  const price = ((await res.json()) as { data?: PaddlePrice }).data;
  const minor = Number(price?.unit_price?.amount);
  const currency = price?.unit_price?.currency_code;
  if (!price || price.status === 'archived' || !Number.isInteger(minor) || minor < 0 || !currency) throw new Error('a price the payment provider returned cannot be shown');
  // Paddle's amounts are in the currency's lowest unit; most have two decimals, a few none.
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  return { amount: minor / 10 ** digits, currency, interval: price.billing_cycle?.interval ?? null };
}

export function paddleProvider(config: Enabled): BillingProvider {
  return {
    id: 'paddle',
    async readWebhook(headers: IncomingHttpHeaders, rawBody: string, now?: number): Promise<WebhookRead> {
      if (!verifySignature(config.webhookSecret, headers['paddle-signature'] as string | undefined, rawBody, now)) return { ok: false, status: 401, error: 'bad signature' };
      const event = parseEvent(rawBody);
      if (!event) return { ok: false, status: 400, error: 'not an event' };
      return { ok: true, event: toProviderEvent(event) };
    },
    createCheckout: (priceId, userId, addon) => createCheckout(config, priceId, userId, addon),
    manageUrl: (customerId, subscriptionId, action) => portalUrl(config, customerId, subscriptionId, action),
    readPrice: id => readPrice(config, id),
    // Paddle is the seller of record and sends the invoice itself: no event of its carries a `saleRef`, so nothing asks.
    readSale: async () => { throw new Error('Paddle issues its own invoices'); },
    // Paddle's checkout asks for the address itself and Paddle issues the invoice: there are no billing details to keep.
    saveBuyer: async () => { throw new Error('Paddle asks for the address at its checkout'); },
    readBuyer: async () => null,
    // Paddle is the seller and refunds in its own dashboard.
    withdraw: async () => { throw new Error('Paddle refunds from its own dashboard'); },
    lastPaid: async () => null,
  };
}
