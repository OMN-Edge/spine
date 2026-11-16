import type { IncomingHttpHeaders } from 'node:http';
import { paddleProvider } from './providers/paddle.js';
import { stripeProvider } from './providers/stripe.js';

export type ProviderId = 'paddle' | 'stripe';

/** What an adapter needs of the application's settings: which provider, its key and the secret its messages are signed with. The application reads them (this package reads no environment). */
export interface ProviderSettings {
  provider: ProviderId;
  environment: 'sandbox' | 'production';
  apiKey: string;
  webhookSecret: string;
  /** The address of the page that opens Paddle's checkout (an origin of its own); null for a provider whose checkout is its own page. */
  checkoutUrl: string | null;
}
export type Enabled = ProviderSettings;

/** What an invoice needs to know of a buyer: collected by the application before a purchase, kept at the provider and never here. The application's own record has at least these. */
export interface BillingDetails {
  name: string;
  country: string;
  county?: string | undefined;
  sector?: string | undefined;
  city: string;
  address: string;
  postalCode?: string | undefined;
  taxId?: string | undefined;
}

/** What the application says about how a checkout looks and where the buyer returns, since the words and the pages are its own. */
export interface Presentation {
  /** Where the provider sends the buyer back to, as an absolute address, asked at each checkout. */
  returnUrl(): string;
  /** The words the buyer ticks before paying and the language of the provider's page, for the buyer's language (a code the application uses); `locale` null leaves the provider's own choice. */
  checkoutWords(language: string | null | undefined): { consent: string; locale: string | null };
  /** What a customer record holds, as billing details: the application's own rules for when they are complete; null if they are not. */
  parseDetails(raw: Record<string, string | undefined>): BillingDetails | null;
}

/**
 * What a payment provider's message says, in this package's own words: the one thing the plan engine (`events.ts`) understands, whoever sent it. A provider's adapter
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
export interface PriceReading { amount: number; currency: string; interval: string | null; /** The provider's id of the product it belongs to, when it says. */ productId?: string | null }

/** What a price is, as the catalog sends it to a provider: the key it can be found again by, the product it belongs to, how often it repeats (`once` for a thing bought once) and its amount, tax included, in the minor unit. */
export interface ProviderPriceInput { key: string; productId: string; period: 'month' | 'year' | 'once'; currency: string; amountMinor: number }

/**
 * What a provider can be told about the catalog (`products.ts`): a product and a price are made once for a key, and asked again they are found, never made twice. A provider that is
 * the merchant of record (Paddle, here) has none: its prices are made in its own dashboard.
 */
export interface ProviderCatalog {
  /** The provider's id of the product for `key`: made if it is not there, and its name and description made the same if they differ. */
  ensureProduct(input: { key: string; name: string; description: string | null }): Promise<string>;
  /** The provider's id of the price for `key`: made if it is not there. A price found under the key with another amount or product is refused, never changed. */
  ensurePrice(input: ProviderPriceInput): Promise<string>;
  /** Takes a price off sale. The subscriptions that bought it go on with it. */
  archivePrice(providerPriceId: string): Promise<void>;
}

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
  /** What the subscription's last payment was, in the minor unit, to suggest what to pay back on a withdrawal; null where the provider cannot say (the operator pays back there from its dashboard). */
  lastPaid(subscriptionId: string): Promise<{ amountMinor: number; currency: string } | null>;
  /** What the provider says about one price the operator named (`catalog.ts` keeps it for a while and checks the set). */
  readPrice(id: string): Promise<PriceReading>;
  /** Where the catalog's products and prices are sent; absent where the provider is the merchant of record. */
  readonly catalog?: ProviderCatalog;
}

/** The active provider, from the settings. The one place that knows which adapters exist. */
export function billingProvider(config: ProviderSettings, presentation: Presentation): BillingProvider {
  switch (config.provider) {
    case 'paddle': return paddleProvider(config);
    case 'stripe': return stripeProvider(config, presentation);
  }
}
