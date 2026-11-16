/**
 * What this package asks of the store, written here and not taken from the application's: the subscription row of an account, the queue of invoices, the product catalog, and the few
 * counters and settings it keeps. The application's store has these methods with these shapes (the wiring in the application is checked by the compiler where it hands the store
 * over), and nothing of the application's is imported. Methods are written as methods, so an application whose records are narrower (a plan that is one of its own names) fits.
 */
/** What an account pays for. One row per account; none means it has never subscribed. */
export interface SubscriptionRecord {
  user_id: string;
  /** Who bills it: a provider's id, or `operator` for an account the operator granted. */
  provider: string;
  customer_id: string | null;
  subscription_id: string | null;
  interval: 'month' | 'year' | null;
  /** What it is a subscription to: the application's own name for it. */
  plan: string;
  /** The provider's word: active, trialing, past_due, paused, canceled. */
  status: string;
  /** Pays the capped price, locked for as long as the subscription runs. */
  founding: boolean;
  /** The end of what is paid for. */
  current_period_end: string | null;
  /** The subscription will end at `current_period_end` rather than renew. */
  cancel_scheduled: boolean;
  updated_at: string;
}

export type InvoiceState = 'pending' | 'issued' | 'done' | 'failed' | 'check';

export interface QueuedInvoice {
  /** The provider's reference for the payment: one invoice for each. */
  ref: string;
  user_id: string | null;
  state: InvoiceState;
  attempts: number;
  /** Not before this (ISO). */
  next_attempt_at: string;
  /** What went wrong the last time, in the issuer's words (never what was sent), cut short. */
  last_error: string | null;
  /** The issuing service's own id, series and number of the invoice, once it is made. */
  issuer_ref: string | null;
  series: string | null;
  number: string | null;
  /** Where an invoice that stopped had got to (`pending` or `issued`), for the operator's retry. */
  resume: 'pending' | 'issued' | null;
  /** What the invoice counts for in the EU consumer threshold, in minor units of EUR (negative for a storno); null where it counts for nothing. */
  eu_minor: number | null;
  created_at: string;
  updated_at: string;
}

export type InvoicePatch = Partial<Pick<QueuedInvoice, 'state' | 'attempts' | 'next_attempt_at' | 'last_error' | 'issuer_ref' | 'series' | 'number' | 'resume' | 'eu_minor'>>;

/** A thing the operator sells, as the application declared it (its `id`) and the operator named it. */
export interface CatalogProduct { id: string; name: string; description: string | null; on_sale: number; updated_at: string }
/** One price of a product: an amount in minor units for a billing period (`once` for a thing bought once) in a currency, as a numbered version. A version is never changed. */
export interface CatalogPrice { id: string; product_id: string; period: 'month' | 'year' | 'once'; currency: string; amount_minor: number; version: number; created_at: string }
/** Where a version is at a provider, and when it was taken off sale there (`archived_at`; the provider keeps it for the subscribers who bought it). */
export interface CatalogLink { price_id: string; provider: string; provider_product_id: string; provider_price_id: string; synced_at: string; archived_at: string | null }

export interface BillingStore {
  billing: {
    get(userId: string): Promise<SubscriptionRecord | null>;
    findBySubscription(subscriptionId: string): Promise<SubscriptionRecord | null>;
    findByCustomer(customerId: string): Promise<SubscriptionRecord | null>;
    /** Writes the account's row, replacing any. */
    put(record: SubscriptionRecord): Promise<void>;
    /** Puts a payment on the queue of invoices by the provider's reference for it; false if it was there already. */
    queueInvoice(ref: string, userId: string | null, at: string): Promise<boolean>;
    /** The invoices that are waiting and whose time has come, oldest first. */
    invoicesDue(now: string, limit: number): Promise<QueuedInvoice[]>;
    invoice(ref: string): Promise<QueuedInvoice | null>;
    updateInvoice(ref: string, patch: InvoicePatch, at: string): Promise<void>;
    /** What the invoices made in a calendar year count for in the EU consumer threshold (minor units of EUR). */
    euSalesMinor(year: number): Promise<number>;
  };
  users: { findById(id: string): Promise<{ id: string } | null> };
  usage: { aiAdd(userId: string, key: string, amount: number): Promise<number> };
  metrics: { bump(name: string, day: string): Promise<void> };
  settings: { all(): Promise<Array<{ key: string }>>; set(key: string, value: string, at: string): Promise<void> };
  catalog: {
    products(): Promise<CatalogProduct[]>;
    saveProduct(product: Omit<CatalogProduct, 'updated_at'>, at: string): Promise<void>;
    prices(): Promise<CatalogPrice[]>;
    addPrice(price: Pick<CatalogPrice, 'product_id' | 'period' | 'currency' | 'amount_minor'>, at: string): Promise<CatalogPrice>;
    links(provider: string): Promise<CatalogLink[]>;
    saveLink(link: Omit<CatalogLink, 'archived_at'>): Promise<void>;
    archiveLink(priceId: string, provider: string, at: string): Promise<void>;
  };
}
