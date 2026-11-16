import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { publicUrl } from 'spine-core/config.js';
import { recipientLanguage, tm } from '../../mail/i18n.js';
import { billingDetailsSchema, type BillingDetails } from 'spine-core/billing/billing-details.js';
import type { BillingProvider, Buyer, Enabled, ManageAction, PriceReading, ProviderEvent, Sale, WebhookRead } from '../provider.js';

/** The API version every request asks for, so a change Stripe makes later cannot change what this code reads. A webhook endpoint pins its own (set it to this one). */
export const STRIPE_VERSION = '2026-10-28.endive';

/** The longest a delivery's timestamp may differ from our clock; Stripe's own libraries use five minutes. A retry is signed again, and an event is applied once whatever its age. */
const TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Checks the `Stripe-Signature` header (`t=<unix>,v1=<hex>,...`; more than one `v1` while a secret is rolled, and entries it does not know, which are
 * ignored): HMAC-SHA256 of `<t>.<raw body>` under the endpoint's secret. The raw body, byte for byte.
 */
export function verifySignature(secret: string, header: string | undefined, rawBody: string, now = Date.now()): boolean {
  if (!header) return false;
  const parts = header.split(',').map(p => { const i = p.indexOf('='); return i < 0 ? [p.trim(), ''] : [p.slice(0, i).trim(), p.slice(i + 1).trim()]; });
  const t = parts.find(([k]) => k === 't')?.[1];
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v).filter((v): v is string => !!v);
  if (!t || !/^\d+$/.test(t) || signatures.length === 0) return false;
  if (Math.abs(now - Number(t) * 1000) > TOLERANCE_MS) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return signatures.some(sig => {
    const given = Buffer.from(sig, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** What a delivery says, as far as Spine uses it. Anything else in it is ignored. */
interface StripeEvent {
  id: string;
  type: string;
  /** When Stripe made it happen (unix seconds). */
  created?: number;
  data: { object: Record<string, unknown> };
}

function parseEvent(rawBody: string): StripeEvent | null {
  try {
    const e = JSON.parse(rawBody) as Partial<StripeEvent>;
    if (typeof e.id !== 'string' || typeof e.type !== 'string' || !e.data || typeof e.data !== 'object' || !e.data.object || typeof e.data.object !== 'object') return null;
    return e as StripeEvent;
  } catch {
    return null;
  }
}

/** What an invoice's line says Stripe wrote for a subscription ("1 × Spine Premium (at €4.99 / month)"), as the plain product name a checkout's line gives: what is before "(at …)" and after the count. */
function invoiceLineName(description: unknown): unknown {
  return typeof description === 'string' ? description.replace(/^\d+\s*[×x]\s*/, '').replace(/\s*\(at [^)]*\)\s*$/, '').trim() || description : description;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
/** An id that may come bare or expanded into the object it names. */
const idOf = (v: unknown): string | null => str(v) ?? (v && typeof v === 'object' ? str((v as { id?: unknown }).id) : null);
const isoOfUnix = (v: unknown): string | null => (typeof v === 'number' && Number.isFinite(v) ? new Date(v * 1000).toISOString() : null);
/** The user Spine put in the purchase: a bounded string, as for any provider. */
const userId = (v: unknown): string | null => { const id = str(v); return id && id.length <= 64 ? id : null; };

/** Stripe's statuses in Spine's: what keeps a plan, what is late, what is over, and what is not yet a subscription at all (null). */
function statusOf(status: unknown): string | null {
  switch (status) {
    case 'active': case 'trialing': case 'past_due': case 'paused': case 'canceled': return status;
    case 'unpaid': case 'incomplete_expired': return 'canceled';
    default: return null; // incomplete: the first payment has not been made
  }
}

interface StripeItem { price?: { id?: unknown; recurring?: { interval?: unknown } | null }; current_period_end?: unknown }

/** The subscription messages mean a subscription changed; the end of what is paid for is on its items since the 2025-03-31 version, and on the subscription before. */
function subscriptionEvent(event: StripeEvent): ProviderEvent {
  const s = event.data.object;
  const status = statusOf(s.status);
  if (status === null) return { kind: 'ignored', id: event.id };
  const items = ((s.items as { data?: StripeItem[] } | undefined)?.data ?? []).filter(i => i && typeof i === 'object');
  const priceIds = items.map(i => str(i.price?.id)).filter((id): id is string => id !== null);
  const interval = items.map(i => i.price?.recurring?.interval).find(v => v === 'month' || v === 'year') as 'month' | 'year' | undefined;
  const ends = items.map(i => isoOfUnix(i.current_period_end)).filter((v): v is string => v !== null).sort();
  const metadata = (s.metadata ?? {}) as Record<string, unknown>;
  return {
    kind: 'subscription', id: event.id, at: isoOfUnix(event.created), userId: userId(metadata.user_id),
    subscriptionId: str(s.id), customerId: idOf(s.customer), status, priceIds, interval: interval ?? null,
    periodEnd: ends[0] ?? isoOfUnix(s.current_period_end),
    cancelScheduled: s.cancel_at_period_end === true || typeof s.cancel_at === 'number' || status === 'canceled',
  };
}

/**
 * A payment Stripe took for a subscription after the first (a renewal, or a change that was charged): its invoice. The first payment is the checkout session's
 * own, so the invoice that goes with it (`subscription_create`) is not a second sale, and a payment of nothing is none. The subscription is named on the invoice
 * itself before API version 2025-03-31 and under `parent` since.
 */
function renewalEvent(event: StripeEvent): ProviderEvent {
  const inv = event.data.object;
  const id = str(inv.id);
  if (!id || inv.billing_reason === 'subscription_create' || typeof inv.amount_paid !== 'number' || inv.amount_paid <= 0) return { kind: 'ignored', id: event.id };
  const parent = (inv.parent as { subscription_details?: { subscription?: unknown; metadata?: Record<string, unknown> } } | null | undefined)?.subscription_details;
  const lines = ((inv.lines as { data?: Array<{ price?: { id?: unknown }; pricing?: { price_details?: { price?: unknown } } }> } | undefined)?.data ?? []);
  const priceIds = lines.map(l => str(l.price?.id) ?? str(l.pricing?.price_details?.price)).filter((p): p is string => p !== null);
  return {
    kind: 'payment', id: event.id, at: isoOfUnix(event.created), userId: userId(parent?.metadata?.user_id), subscriptionId: idOf(inv.subscription) ?? idOf(parent?.subscription),
    customerId: idOf(inv.customer), transactionId: id, priceIds, saleRef: id,
  };
}

/** The words next to the box the buyer ticks before paying: the service starts now, and the right of withdrawal ends once it is fully provided. */
export function withdrawalConsent(lang: ReturnType<typeof recipientLanguage>): string {
  return tm(lang, 'I ask for the service to start now. I understand that I lose my right of withdrawal once it has been fully provided, and that if I withdraw after using it I pay for what I used. I have read the [terms]({terms}) and the [refund policy]({refunds}).', { terms: publicUrl('/terms'), refunds: publicUrl('/refunds') });
}

export function stripeProvider(config: Enabled): BillingProvider {
  const base = 'https://api.stripe.com';
  const headers = { authorization: `Bearer ${config.apiKey}`, 'stripe-version': STRIPE_VERSION };

  /** A form-encoded request: Stripe's API takes `a[b][c]=d`, not JSON. */
  async function call(method: 'GET' | 'POST' | 'DELETE', path: string, params?: Record<string, string>, idempotencyKey?: string): Promise<Record<string, unknown>> {
    const query = method === 'GET' && params ? `?${new URLSearchParams(params)}` : '';
    const res = await fetch(`${base}${path}${query}`, {
      method,
      headers: method === 'GET' ? headers : { ...headers, 'content-type': 'application/x-www-form-urlencoded', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
      body: method !== 'GET' && params ? new URLSearchParams(params).toString() : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Stripe names what went wrong with a fixed code (`resource_missing`, `parameter_invalid_empty`, …): kept for the log. Its message is not, as it can quote what was sent.
      const code = await res.json().then(b => (b as { error?: { code?: unknown } } | null)?.error?.code, () => undefined);
      throw new Error(`the payment provider answered ${res.status}${typeof code === 'string' && /^[a-z0-9_]{1,80}$/.test(code) ? ` (${code})` : ''}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  /**
   * A refund, traced to what was queued for the payment: the charge names its payment intent, and what Spine queued is the checkout session (a thing bought once, or the
   * first payment of a subscription) or the invoice (a renewal), which the payment intent reaches through the invoice payments. All are candidates; the queue says which
   * it holds. A refund of part of a payment is said so: a storno reverses the whole invoice.
   */
  async function refundEvent(event: StripeEvent): Promise<ProviderEvent> {
    const charge = event.data.object;
    const intent = idOf(charge.payment_intent);
    const amount = typeof charge.amount === 'number' ? charge.amount : 0;
    const refunded = typeof charge.amount_refunded === 'number' ? charge.amount_refunded : 0;
    const currency = str(charge.currency)?.toUpperCase() ?? '';
    if (!intent || refunded <= 0) return { kind: 'ignored', id: event.id };
    const refs: string[] = [];
    const sessions = await call('GET', '/v1/checkout/sessions', { payment_intent: intent, limit: '1' });
    for (const s of (sessions.data as Array<{ id?: unknown }> | undefined) ?? []) if (str(s.id)) refs.push(str(s.id)!);
    const payments = await call('GET', '/v1/invoice_payments', { 'payment[type]': 'payment_intent', 'payment[payment_intent]': intent, limit: '1' });
    const invoiceId = str(((payments.data as Array<{ invoice?: unknown }> | undefined) ?? [])[0]?.invoice);
    if (invoiceId) {
      const invoice = await call('GET', `/v1/invoices/${encodeURIComponent(invoiceId)}`);
      const parent = (invoice.parent as { subscription_details?: { subscription?: unknown } } | null | undefined)?.subscription_details;
      const subscription = idOf(invoice.subscription) ?? idOf(parent?.subscription);
      // A subscription's first invoice is queued under the checkout session that made it.
      if (invoice.billing_reason === 'subscription_create' && subscription) {
        const bySubscription = await call('GET', '/v1/checkout/sessions', { subscription, limit: '5' });
        for (const s of (bySubscription.data as Array<{ id?: unknown }> | undefined) ?? []) if (str(s.id) && !refs.includes(str(s.id)!)) refs.push(str(s.id)!);
      }
      refs.push(invoiceId);
    }
    return { kind: 'refund', id: event.id, at: isoOfUnix(event.created), saleRefs: refs, full: charge.refunded === true || (amount > 0 && refunded >= amount), refundedMinor: refunded, currency };
  }

  /** What a completed Checkout Session bought: its payload does not carry the line items, so they are asked for, the prices on them being what counts (never what a message claims). */
  async function priceIdsOf(sessionId: string): Promise<string[]> {
    const out = await call('GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/line_items`, { limit: '10' });
    return ((out.data as Array<{ price?: { id?: unknown } }> | undefined) ?? []).map(l => str(l.price?.id)).filter((id): id is string => id !== null);
  }

  return {
    id: 'stripe',

    async readWebhook(requestHeaders: IncomingHttpHeaders, rawBody: string, now?: number): Promise<WebhookRead> {
      if (!verifySignature(config.webhookSecret, requestHeaders['stripe-signature'] as string | undefined, rawBody, now)) return { ok: false, status: 401, error: 'bad signature' };
      const event = parseEvent(rawBody);
      if (!event) return { ok: false, status: 400, error: 'not an event' };
      if (event.type.startsWith('customer.subscription.')) {
        return ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(event.type)
          ? { ok: true, event: subscriptionEvent(event) }
          : { ok: true, event: { kind: 'ignored', id: event.id } };
      }
      if (event.type === 'invoice.paid') return { ok: true, event: renewalEvent(event) };
      if (event.type === 'charge.refunded') return { ok: true, event: await refundEvent(event) };
      if (event.type === 'checkout.session.completed') {
        const s = event.data.object;
        // A session paid later (a delayed method) completes without the money; its own event follows.
        if (s.payment_status !== 'paid' && s.payment_status !== 'no_payment_required') return { ok: true, event: { kind: 'ignored', id: event.id } };
        const sessionId = str(s.id);
        if (!sessionId) return { ok: false, status: 400, error: 'not an event' };
        return {
          ok: true,
          event: {
            kind: 'payment', id: event.id, at: isoOfUnix(event.created), userId: userId(s.client_reference_id), subscriptionId: idOf(s.subscription),
            customerId: idOf(s.customer),
            // A purchase is the session, whatever the payments inside it: its id is what a thing bought once is applied by, once.
            transactionId: sessionId, priceIds: await priceIdsOf(sessionId),
            // Something was paid (a session of nothing, a free one, has no invoice to make): the operator's to invoice.
            saleRef: typeof s.amount_total === 'number' && s.amount_total > 0 ? sessionId : null,
          },
        };
      }
      return { ok: true, event: { kind: 'ignored', id: event.id } };
    },

    /** A Checkout Session on Stripe's own page, naming the account (as the session's reference and on the subscription it makes); the answer is its address. */
    async createCheckout(priceId: string, user: string, addon?: string, buyer?: Buyer): Promise<string> {
      const back = publicUrl('/account');
      const params: Record<string, string> = {
        mode: addon ? 'payment' : 'subscription',
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': '1',
        client_reference_id: user,
        success_url: back,
        cancel_url: back,
      };
      // Without the billing details (a Stripe account that does not issue invoices through Spine) the page asks for the address; with them the customer holds it.
      if (!buyer?.hasDetails) params.billing_address_collection = 'required';
      if (addon) { params['metadata[user_id]'] = user; params['metadata[addon]'] = addon; } else params['subscription_data[metadata][user_id]'] = user;
      // Where the operator is the seller, the buyer asks for the service to start at once and is told that this ends the right of withdrawal once it is fully provided (EU
      // consumer law for digital services): a box that has to be ticked, with these words in the buyer's language. Stripe keeps the answer with the session.
      const lang = recipientLanguage({ email: '', language: buyer?.language });
      params['consent_collection[terms_of_service]'] = 'required';
      params['custom_text[terms_of_service_acceptance][message]'] = withdrawalConsent(lang);
      if (lang !== 'en' || buyer?.language === 'en') params.locale = lang;
      // An account that has a customer at Stripe buys as that customer; a new one is made by the session, and is given the account's address so the form is filled in.
      if (buyer?.customerId) params.customer = buyer.customerId;
      else if (buyer?.email) params.customer_email = buyer.email;
      const out = await call('POST', '/v1/checkout/sessions', params);
      const url = str(out.url) ?? '';
      if (!url.startsWith('https://')) throw new Error('the payment provider gave no checkout address');
      return url;
    },

    /** The customer portal, opened where `action` says (cancelling the subscription, or the card); where Stripe refuses that (the portal's settings do not allow it) the overview, so a person is never sent nowhere. */
    async manageUrl(customerId: string, subscriptionId: string | null, action: ManageAction): Promise<string> {
      const base = { customer: customerId, return_url: publicUrl('/account') };
      const flow: Record<string, string> | null = action === 'cancel' && subscriptionId
        ? { 'flow_data[type]': 'subscription_cancel', 'flow_data[subscription_cancel][subscription]': subscriptionId }
        : action === 'payment_method' ? { 'flow_data[type]': 'payment_method_update' } : null;
      let out: Record<string, unknown>;
      try {
        out = await call('POST', '/v1/billing_portal/sessions', flow ? { ...base, ...flow } : base);
      } catch (err) {
        if (!flow) throw err;
        out = await call('POST', '/v1/billing_portal/sessions', base);
      }
      const url = str(out.url) ?? '';
      if (!url.startsWith('https://')) throw new Error('the payment provider gave no portal address');
      return url;
    },

    /** The billing details as the Stripe customer: made for the account, or changed if it has one. The county goes in the address's state, the rest of what Stripe has no place for in the metadata. */
    async saveBuyer({ userId: user, email, customerId, details }: { userId: string; email: string; customerId: string | null; details: BillingDetails }): Promise<string> {
      const params: Record<string, string> = {
        name: details.name, email,
        'address[line1]': details.address, 'address[city]': details.city, 'address[country]': details.country,
        'address[postal_code]': details.postalCode ?? '', 'address[state]': details.county ?? '',
        'metadata[user_id]': user, 'metadata[tax_id]': details.taxId ?? '', 'metadata[sector]': details.sector ?? '',
      };
      const out = await call('POST', customerId ? `/v1/customers/${encodeURIComponent(customerId)}` : '/v1/customers', params);
      const id = str(out.id);
      if (!id) throw new Error('the payment provider made no customer');
      return id;
    },

    /** What the customer holds, as billing details; null when it is not complete (a customer made by a checkout that asked for no county). */
    async readBuyer(customerId: string): Promise<BillingDetails | null> {
      const c = await call('GET', `/v1/customers/${encodeURIComponent(customerId)}`);
      const a = (c.address ?? {}) as Record<string, unknown>;
      const meta = (c.metadata ?? {}) as Record<string, unknown>;
      const parsed = billingDetailsSchema.safeParse({
        name: str(c.name) ?? '', country: str(a.country) ?? '', city: str(a.city) ?? '', address: str(a.line1) ?? '',
        ...(str(a.state) ? { county: str(a.state)! } : {}), ...(str(meta.sector) ? { sector: str(meta.sector)! } : {}),
        ...(str(a.postal_code) ? { postalCode: str(a.postal_code)! } : {}), ...(str(meta.tax_id) ? { taxId: str(meta.tax_id)! } : {}),
      });
      return parsed.success ? parsed.data : null;
    },

    /** A payment as an invoice needs it, read from the checkout session (`cs_…`) or the invoice (`in_…`) the event named; nothing of the buyer is kept between the event and here. */
    async readSale(ref: string): Promise<Sale> {
      const session = ref.startsWith('cs_');
      if (!session && !ref.startsWith('in_')) throw new Error('not a payment the provider knows');
      const out = session
        ? await call('GET', `/v1/checkout/sessions/${encodeURIComponent(ref)}`, { 'expand[0]': 'line_items' })
        : await call('GET', `/v1/invoices/${encodeURIComponent(ref)}`);
      const checkoutDetails = (session ? out.customer_details : { name: out.customer_name, email: out.customer_email, address: out.customer_address, tax_ids: out.customer_tax_ids }) as
        { name?: unknown; email?: unknown; address?: Record<string, unknown> | null; tax_ids?: Array<{ value?: unknown }> | null } | null | undefined;
      // The buyer is the customer record when the account gave its billing details (what the invoice needs, county included, as the app collected it); the page's own
      // address is the fallback, for a payment made before the details were asked for.
      const customerId = idOf(out.customer);
      // A customer that is gone is the only thing the page's address stands in for: any other failure (a key that may not read customers, Stripe down) is the invoice's to try again, not hidden.
      const held = customerId ? await call('GET', `/v1/customers/${encodeURIComponent(customerId)}`).catch(err => { if (/\(resource_missing\)/.test(String(err))) return null; throw err; }) : null;
      const heldAddress = (held?.address ?? null) as Record<string, unknown> | null;
      const useHeld = !!held && !!str(held.name) && !!str(heldAddress?.country) && !!str(heldAddress?.line1);
      const details = useHeld ? { name: held!.name, email: str(held!.email) ?? checkoutDetails?.email, address: heldAddress, tax_ids: null } : checkoutDetails;
      const heldMeta = useHeld ? ((held!.metadata ?? {}) as Record<string, unknown>) : {};
      const name = str(details?.name);
      const email = str(details?.email);
      const country = str(details?.address?.country);
      const currency = str(out.currency);
      if (!name || !email || !country || !currency) throw new Error('a payment the provider returned has no buyer or currency to invoice');
      const raw = session
        ? ((out.line_items as { data?: Array<{ description?: unknown; amount_total?: unknown; quantity?: unknown }> } | undefined)?.data ?? []).map(l => ({ name: l.description, amount: l.amount_total, quantity: l.quantity }))
        : ((out.lines as { data?: Array<{ description?: unknown; amount?: unknown; quantity?: unknown }> } | undefined)?.data ?? []).map(l => ({ name: invoiceLineName(l.description), amount: l.amount, quantity: l.quantity }));
      const lines = raw.flatMap(l => (str(l.name) && typeof l.amount === 'number' && l.amount > 0 ? [{ name: str(l.name)!, amountMinor: l.amount, quantity: typeof l.quantity === 'number' && l.quantity >= 1 ? l.quantity : 1 }] : []));
      if (lines.length === 0) throw new Error('a payment the provider returned has nothing to invoice');
      const paidAt = isoOfUnix(session ? out.created : (out.status_transitions as { paid_at?: unknown } | undefined)?.paid_at) ?? isoOfUnix(out.created) ?? new Date().toISOString();
      const taxId = str(heldMeta.tax_id) ?? str(details?.tax_ids?.[0]?.value);
      const sector = str(heldMeta.sector);
      const address = [str(details?.address?.line1), str(details?.address?.line2)].filter(Boolean).join(', ');
      return {
        paidAt, currency: currency.toUpperCase(), lines,
        buyer: { name, email, country: country.toUpperCase(), ...(str(details?.address?.city) ? { city: str(details?.address?.city)! } : {}), ...(str(details?.address?.state) ? { region: str(details?.address?.state)! } : {}), ...(sector ? { sector } : {}), ...(address ? { address } : {}), ...(taxId ? { taxId } : {}) },
      };
    },

    /**
     * A buyer's withdrawal, as the operator decided it: the subscription is ended at once (nothing is billed for the rest of the period), and its last payment is paid back in full
     * or the part named, to the way it was paid. The subscription first, so that a refund that fails leaves a plan that has ended and no money paid back, which the operator
     * sees and repeats (each step is made once for the key, and a subscription already ended is not an error), and never the other way round. The refund's own event
     * then has the invoice reversed.
     */
    async withdraw({ subscriptionId, amountMinor, key }: { subscriptionId: string; amountMinor: number | null; key: string }): Promise<{ refundedMinor: number; currency: string }> {
      const invoices = await call('GET', '/v1/invoices', { subscription: subscriptionId, status: 'paid', limit: '1' });
      const invoiceId = str(((invoices.data as Array<{ id?: unknown }> | undefined) ?? [])[0]?.id);
      if (!invoiceId) throw new Error('there is no payment of the subscription to pay back');
      const payments = await call('GET', '/v1/invoice_payments', { invoice: invoiceId, limit: '1' });
      const intent = str((((payments.data as Array<{ payment?: { payment_intent?: unknown } }> | undefined) ?? [])[0]?.payment ?? {}).payment_intent);
      if (!intent) throw new Error('the payment of the subscription cannot be found to pay back');
      await call('DELETE', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, { invoice_now: 'false', prorate: 'false' }, `${key}:end`).catch(err => { if (!/\(resource_missing\)/.test(String(err))) throw err; });
      const refund = await call('POST', '/v1/refunds', { payment_intent: intent, ...(amountMinor ? { amount: String(amountMinor) } : {}) }, `${key}:refund`);
      const refunded = refund.amount;
      if (typeof refunded !== 'number') throw new Error('the payment provider gave no refund');
      return { refundedMinor: refunded, currency: str(refund.currency)?.toUpperCase() ?? '' };
    },

    async lastPaid(subscriptionId: string): Promise<{ amountMinor: number; currency: string } | null> {
      const invoices = await call('GET', '/v1/invoices', { subscription: subscriptionId, status: 'paid', limit: '1' });
      const last = ((invoices.data as Array<{ amount_paid?: unknown; currency?: unknown }> | undefined) ?? [])[0];
      const currency = str(last?.currency)?.toUpperCase();
      return typeof last?.amount_paid === 'number' && last.amount_paid > 0 && currency ? { amountMinor: last.amount_paid, currency } : null;
    },

    /** What Stripe says about a price: its amount in the major unit, its currency and how often it repeats (null for a thing bought once). */
    async readPrice(id: string): Promise<PriceReading> {
      const price = await call('GET', `/v1/prices/${encodeURIComponent(id)}`);
      const minor = price.unit_amount;
      const currency = str(price.currency)?.toUpperCase();
      if (price.active === false || typeof minor !== 'number' || !Number.isInteger(minor) || minor < 0 || !currency) throw new Error('a price the payment provider returned cannot be shown');
      const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
      const interval = (price.recurring as { interval?: unknown } | null | undefined)?.interval;
      return { amount: minor / 10 ** digits, currency, interval: typeof interval === 'string' ? interval : null };
    },
  };
}
