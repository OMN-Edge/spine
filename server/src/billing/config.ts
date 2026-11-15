import { ConfigError } from 'spine-core/config.js';

/**
 * Billing is off unless `SPINE_BILLING=on`, and a self-hosted or private instance leaves it off: nothing then limits an account but the
 * instance's own ceilings (`vaultLimits`, `sharedLimits`, the relay's daily calls). On, it needs the payment provider's settings, all of
 * them, or the process does not start (P3). The provider is Paddle, which is the merchant of record (it charges, issues invoices and
 * accounts for VAT); this server never sees a card (`docs/billing.md`).
 */
export type BillingConfig =
  | { enabled: false }
  | {
      enabled: true;
      /** Who takes the payments (`SPINE_BILLING_PROVIDER`, `provider.ts`): one at a time. */
      provider: 'paddle' | 'stripe';
      environment: 'sandbox' | 'production';
      apiKey: string;
      webhookSecret: string;
      /** Premium's two prices and the founding one: the ids of prices in Paddle, which alone says what they cost (`catalog.ts`). */
      prices: { year: string; month: string; founding: string };
      /** The Essential plan's two prices, when the operator sells it (both or neither). */
      essential: { year: string; month: string } | null;
      /** The family plan's two prices, when the operator sells it (both or neither). */
      family: { year: string; month: string } | null;
      /** The thing bought once, by its own price when the operator sells it (`billing/addons.ts`). */
      addons: { pageTopup: string | null };
      /** The address of the page that opens Paddle's checkout: an origin of its own, so the provider's script never runs where the vault is. Stripe's checkout is Stripe's own page: none. */
      checkoutUrl: string | null;
    };

type PriceKey = 'YEAR' | 'MONTH' | 'FOUNDING' | 'ESSENTIAL_YEAR' | 'ESSENTIAL_MONTH' | 'FAMILY_YEAR' | 'FAMILY_MONTH' | 'TOPUP_PAGES';
interface ProviderSettings { key: string; secret: string; price: Record<PriceKey, string> }

const PADDLE_SETTINGS: ProviderSettings = {
  key: 'PADDLE_API_KEY', secret: 'PADDLE_WEBHOOK_SECRET',
  price: {
    YEAR: 'SPINE_PADDLE_PRICE_YEAR', MONTH: 'SPINE_PADDLE_PRICE_MONTH', FOUNDING: 'SPINE_PADDLE_PRICE_FOUNDING',
    ESSENTIAL_YEAR: 'SPINE_PADDLE_PRICE_ESSENTIAL_YEAR', ESSENTIAL_MONTH: 'SPINE_PADDLE_PRICE_ESSENTIAL_MONTH',
    FAMILY_YEAR: 'SPINE_PADDLE_PRICE_FAMILY_YEAR', FAMILY_MONTH: 'SPINE_PADDLE_PRICE_FAMILY_MONTH', TOPUP_PAGES: 'SPINE_PADDLE_PRICE_TOPUP_PAGES',
  },
};

const STRIPE_SETTINGS: ProviderSettings = {
  key: 'STRIPE_SECRET_KEY', secret: 'STRIPE_WEBHOOK_SECRET',
  price: {
    YEAR: 'SPINE_STRIPE_PRICE_YEAR', MONTH: 'SPINE_STRIPE_PRICE_MONTH', FOUNDING: 'SPINE_STRIPE_PRICE_FOUNDING',
    ESSENTIAL_YEAR: 'SPINE_STRIPE_PRICE_ESSENTIAL_YEAR', ESSENTIAL_MONTH: 'SPINE_STRIPE_PRICE_ESSENTIAL_MONTH',
    FAMILY_YEAR: 'SPINE_STRIPE_PRICE_FAMILY_YEAR', FAMILY_MONTH: 'SPINE_STRIPE_PRICE_FAMILY_MONTH', TOPUP_PAGES: 'SPINE_STRIPE_PRICE_TOPUP_PAGES',
  },
};

export function readBillingConfig(env: NodeJS.ProcessEnv, instance: 'public' | 'private', problems: string[]): BillingConfig {
  const raw = (env.SPINE_BILLING ?? 'off').toLowerCase();
  if (raw !== 'on' && raw !== 'off') problems.push(`SPINE_BILLING is "${raw}"; expected on or off`);
  if (raw !== 'on') return { enabled: false };

  // A private deployment is for the people its administrator lets in; nobody pays to be in it.
  if (instance === 'private') problems.push('SPINE_BILLING=on does not go with SPINE_INSTANCE=private: a private deployment has no plans to buy');

  const provider = (env.SPINE_BILLING_PROVIDER ?? 'paddle').trim().toLowerCase();
  if (provider !== 'paddle' && provider !== 'stripe') problems.push(`SPINE_BILLING_PROVIDER is "${provider}"; expected paddle or stripe`);
  const stripe = provider === 'stripe';
  // Each provider's settings have their own names, written out so a name in the documents can be found in the code.
  const names = stripe ? STRIPE_SETTINGS : PADDLE_SETTINGS;

  const need = (name: string): string => {
    const value = (env[name] ?? '').trim();
    if (!value) problems.push(`SPINE_BILLING=on needs ${name}`);
    return value;
  };
  const apiKey = need(names.key);
  // Paddle's mode is said, never assumed (one value charges real money). Stripe's key says its own: `sk_test_`/`rk_test_` is the sandbox, `sk_live_`/`rk_live_` charges.
  let environment: string;
  if (stripe) {
    environment = /^(sk|rk)_test_/.test(apiKey) ? 'sandbox' : /^(sk|rk)_live_/.test(apiKey) ? 'production' : '';
    if (apiKey && !environment) problems.push('STRIPE_SECRET_KEY must be a Stripe secret or restricted key (sk_test_, rk_test_, sk_live_ or rk_live_)');
  } else {
    environment = (env.PADDLE_ENVIRONMENT ?? '').trim();
    if (environment !== 'sandbox' && environment !== 'production') problems.push('SPINE_BILLING=on needs PADDLE_ENVIRONMENT, sandbox or production (said, never assumed: one charges real money)');
  }
  let checkoutUrl: string | null = null;
  if (!stripe) {
    checkoutUrl = need('SPINE_CHECKOUT_URL');
    if (checkoutUrl && !/^https:\/\/[^/\s]+(\/\S*)?$/.test(checkoutUrl) && !/^http:\/\/localhost(:\d+)?(\/\S*)?$/.test(checkoutUrl)) problems.push('SPINE_CHECKOUT_URL must be an https address');
  }

  // Essential and the family plan are sold only when both their prices are named; one alone is a mistake worth stopping for.
  const price = (p: PriceKey): string => (env[names.price[p]] ?? '').trim();
  const essentialYear = price('ESSENTIAL_YEAR');
  const essentialMonth = price('ESSENTIAL_MONTH');
  if (!!essentialYear !== !!essentialMonth) problems.push(`the Essential plan needs both ${names.price.ESSENTIAL_YEAR} and ${names.price.ESSENTIAL_MONTH}, or neither`);
  const familyYear = price('FAMILY_YEAR');
  const familyMonth = price('FAMILY_MONTH');
  if (!!familyYear !== !!familyMonth) problems.push(`the family plan needs both ${names.price.FAMILY_YEAR} and ${names.price.FAMILY_MONTH}, or neither`);
  const needPrice = (p: PriceKey): string => need(names.price[p]);

  return {
    enabled: true,
    provider: stripe ? 'stripe' : 'paddle',
    environment: environment === 'production' ? 'production' : 'sandbox',
    apiKey,
    webhookSecret: need(names.secret),
    prices: { year: needPrice('YEAR'), month: needPrice('MONTH'), founding: needPrice('FOUNDING') },
    essential: essentialYear && essentialMonth ? { year: essentialYear, month: essentialMonth } : null,
    family: familyYear && familyMonth ? { year: familyYear, month: familyMonth } : null,
    addons: { pageTopup: price('TOPUP_PAGES') || null },
    checkoutUrl,
  };
}

/** Whether plans are on, and nothing else: for a process (the relay) that applies them but does not talk to the payment provider. */
export const billingOn = (env: NodeJS.ProcessEnv = process.env): boolean => (env.SPINE_BILLING ?? 'off').toLowerCase() === 'on';

/** The billing settings on their own, for the routes and the relay (read each time: they are cheap, and a test changes the environment). */
export function loadBillingConfig(env: NodeJS.ProcessEnv = process.env): BillingConfig {
  const problems: string[] = [];
  const config = readBillingConfig(env, (env.SPINE_INSTANCE ?? 'public') === 'private' ? 'private' : 'public', problems);
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
