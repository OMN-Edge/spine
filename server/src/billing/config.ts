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
      environment: 'sandbox' | 'production';
      apiKey: string;
      webhookSecret: string;
      prices: { year: string; month: string; founding: string };
      /** The family plan's two prices, when the operator sells it (both or neither). */
      family: { year: string; month: string } | null;
      /** The address of the page that opens Paddle's checkout: an origin of its own, so the provider's script never runs where the vault is. */
      checkoutUrl: string;
    };

export function readBillingConfig(env: NodeJS.ProcessEnv, instance: 'public' | 'private', problems: string[]): BillingConfig {
  const raw = (env.SPINE_BILLING ?? 'off').toLowerCase();
  if (raw !== 'on' && raw !== 'off') problems.push(`SPINE_BILLING is "${raw}"; expected on or off`);
  if (raw !== 'on') return { enabled: false };

  // A private deployment is for the people its administrator lets in; nobody pays to be in it.
  if (instance === 'private') problems.push('SPINE_BILLING=on does not go with SPINE_INSTANCE=private: a private deployment has no plans to buy');

  const need = (name: string): string => {
    const value = (env[name] ?? '').trim();
    if (!value) problems.push(`SPINE_BILLING=on needs ${name}`);
    return value;
  };
  const environment = (env.PADDLE_ENVIRONMENT ?? '').trim();
  if (environment !== 'sandbox' && environment !== 'production') problems.push('SPINE_BILLING=on needs PADDLE_ENVIRONMENT, sandbox or production (said, never assumed: one charges real money)');
  const checkoutUrl = need('SPINE_CHECKOUT_URL');
  if (checkoutUrl && !/^https:\/\/[^/\s]+(\/\S*)?$/.test(checkoutUrl) && !/^http:\/\/localhost(:\d+)?(\/\S*)?$/.test(checkoutUrl)) problems.push('SPINE_CHECKOUT_URL must be an https address');

  // The family plan is sold only when both its prices are named; one alone is a mistake worth stopping for.
  const familyYear = (env.SPINE_PADDLE_PRICE_FAMILY_YEAR ?? '').trim();
  const familyMonth = (env.SPINE_PADDLE_PRICE_FAMILY_MONTH ?? '').trim();
  if (!!familyYear !== !!familyMonth) problems.push('the family plan needs both SPINE_PADDLE_PRICE_FAMILY_YEAR and SPINE_PADDLE_PRICE_FAMILY_MONTH, or neither');

  return {
    enabled: true,
    environment: environment === 'production' ? 'production' : 'sandbox',
    apiKey: need('PADDLE_API_KEY'),
    webhookSecret: need('PADDLE_WEBHOOK_SECRET'),
    prices: { year: need('SPINE_PADDLE_PRICE_YEAR'), month: need('SPINE_PADDLE_PRICE_MONTH'), founding: need('SPINE_PADDLE_PRICE_FOUNDING') },
    family: familyYear && familyMonth ? { year: familyYear, month: familyMonth } : null,
    checkoutUrl,
  };
}

/** The billing settings on their own, for the routes and the relay (read each time: they are cheap, and a test changes the environment). */
export function loadBillingConfig(env: NodeJS.ProcessEnv = process.env): BillingConfig {
  const problems: string[] = [];
  const config = readBillingConfig(env, (env.SPINE_INSTANCE ?? 'public') === 'private' ? 'private' : 'public', problems);
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
