import type { IncomingHttpHeaders } from 'node:http';
import type { BillingConfig } from './config.js';
import { paddleProvider } from './providers/paddle.js';
import type { BillingDetails } from 'spine-core/billing/billing-details.js';
import { stripeProvider } from './providers/stripe.js';

export type Enabled = Extract<BillingConfig, { enabled: true }>;
export type ProviderId = Enabled['provider'];

/**
 * What a payment provider's message says, in Spine's own words: the one thing the plan engine (`events.ts`) understands, whoever sent it. A provider's adapter
 * turns its own events into these; nothing past this file names a provider's event, field or header.
 */
export type ProviderEvent =
  /** A subscription began, changed or ended. A field the message does not carry is null, and the engine keeps what it knew. */
  | {
      kind: 'subscription';
      /** The provider's id for this delivery: a delivery is applied once whatever its age, however many times it is sent. */
      id: string;
      /** When the provider made it happen (ISO), or null: a delivery older than what is known is not applied. */
      at: string | null;
      /** The account Spine put in the purchase, if the message names one. */
      userId: string | null;
      subscriptionId: string | null;
      customerId: string | null;
      status: string | null;
      /** The provider's ids of the prices on the subscription. */
      priceIds: string[];
      interval: 'month' | 'year' | null;
      /** The end of what is paid for (ISO), or null. */
      periodEnd: string | null;
      cancelScheduled: boolean;
    }
  /** A payment completed: a subscription's first one (it links the account to the provider's customer and subscription at once) or a thing bought once. */
  | {
      kind: 'payment'; id: string; at: string | null; userId: string | null; subscriptionId: string | null; customerId: string | null; transactionId: string | null; priceIds: string[];
      /** The provider's reference for what was paid, when the operator issues the invoice (the provider is not the seller); null when the provider does (`readSale` reads it). */
      saleRef: string | null;
    }
  /** A payment was refunded: the references (`saleRef`s) it may be queued under, and whether the whole of it was. */
  | { kind: 'refund'; id: string; at: string | null; saleRefs: string[]; full: boolean; refundedMinor: number; currency: string }
  /** Anything else the provider tells of. It is acknowledged and recorded, and changes nothing. */
  | { kind: 'ignored'; id: string };

/** A delivery read: refused with the status to answer (a bad signature, or not a message at all), or what it says. */
export type WebhookRead = { ok: true; event: ProviderEvent } | { ok: false; status: 400 | 401; error: string };

/** Where on the provider's page the customer is sent: its overview (card, invoices, switching, cancelling), or straight to cancelling or to changing the card. */
export type ManageAction = 'overview' | 'cancel' | 'payment_method';
export const MANAGE_ACTIONS: readonly ManageAction[] = ['overview', 'cancel', 'payment_method'];

/** Who is buying, as far as the provider needs to know: the customer it already has for the account, if any, and the address of the account, to fill in the form. */
export interface Buyer { customerId: string | null; email: string; /** The account's language, for the words of the payment page. */ language?: string | null; /** The customer holds the billing details the account gave, so the provider's page need not ask for an address. */ hasDetails?: boolean }

/** What one payment was, for an invoice: when, in what currency, who paid and what for. The amounts are what the buyer paid, tax included as the provider charged it. */
export interface Sale {
  paidAt: string;
  currency: string;
  buyer: { name: string; email: string; country: string; city?: string; region?: string; sector?: string; address?: string; taxId?: string };
  lines: Array<{ name: string; amountMinor: number; quantity: number }>;
}

/** What the provider says one of its prices is: the amount in the major unit, its currency, and how often it repeats (null for a thing bought once). */
export interface PriceReading { amount: number; currency: string; interval: string | null }

/**
 * A payment provider, as far as Spine uses one: the server holds which plan an account has and never a card. One provider is active at a time
 * (`SPINE_BILLING_PROVIDER`); an account's own row says who bills it, so subscriptions made under another keep working.
 */
export interface BillingProvider {
  readonly id: ProviderId;
  /** Checks a delivery's signature over the raw body, and says what it means (a provider may need to ask something of its own API to say it). */
  readWebhook(headers: IncomingHttpHeaders, rawBody: string, now?: number): Promise<WebhookRead>;
  /** A purchase of one price by one account (and what for, when it is a thing bought once); the answer is where to send the person to pay it. */
  createCheckout(priceId: string, userId: string, addon?: string, buyer?: Buyer): Promise<string>;
  /** The provider's page where the customer changes the card, switches plan, cancels and reads invoices, opened where `action` says. A link is made at once and not kept: it carries a login that does not last. */
  manageUrl(customerId: string, subscriptionId: string | null, action: ManageAction): Promise<string>;
  /** What a payment was, read from the provider by the reference its event gave (`saleRef`): nothing of the buyer is kept here between the event and the invoice. */
  readSale(ref: string): Promise<Sale>;
  /** Keeps the billing details the account gave as the provider's customer (made, or changed if the account has one), and says its id: where the details are kept, never here. */
  saveBuyer(input: { userId: string; email: string; customerId: string | null; details: BillingDetails }): Promise<string>;
  /** The billing details held for a customer, to fill the form again; null where the provider holds none. */
  readBuyer(customerId: string): Promise<BillingDetails | null>;
  /** Ends a subscription at once and pays back its last payment, in full or the part named: a buyer's withdrawal, decided by the operator. Done once for a key; says what was paid back. */
  withdraw(input: { subscriptionId: string; amountMinor: number | null; key: string }): Promise<{ refundedMinor: number; currency: string }>;
  /** What the provider says about one price the operator named (`catalog.ts` keeps it for a while and checks the set). */
  readPrice(id: string): Promise<PriceReading>;
}

/** The active provider, from the settings. The one place that knows which adapters exist. */
export function billingProvider(config: Enabled): BillingProvider {
  switch (config.provider) {
    case 'paddle': return paddleProvider(config);
    case 'stripe': return stripeProvider(config);
  }
}
