import { ConfigError } from 'spine-core/config.js';
import type { BillingConfig } from '../config.js';
import { EXEMPT_NOTE } from 'spine-anaf/index.js';
import type { ZeroVat } from 'spine-anaf/index.js';

/**
 * Whether the operator issues an invoice for each payment, and through which: **off unless `SPINE_INVOICING` names one** (`billyou`, a service, or `efactura`, Spine's own link to ANAF), and only with billing on (Stripe takes the payment and the operator is the seller). On, every setting of the service and the VAT the operator charges is given, or the
 * process does not start (P3): the VAT is the accountant's word and is never assumed (`docs/billing.md`, "Invoices").
 */
export interface EfacturaConfig {
  /** ANAF's test platform or the real one: a test run needs the same sign-in and certificate. */
  mode: 'test' | 'prod';
  clientId: string;
  clientSecret: string;
  /** The address ANAF sends the browser back to once the operator has signed in with the certificate (registered with the application at ANAF). */
  redirectUri: string;
  /** The 32 bytes that seal ANAF's tokens in the store. */
  key: Buffer;
  series: string;
  zeroVat: ZeroVat;
  /** The address the server is served from, for the links to an invoice's PDF. */
  publicUrl: string;
}

export type InvoicingConfig =
  | { enabled: false }
  | { enabled: true; issuer: 'efactura'; vatPercent: number; efactura: true; mail: false; direct: EfacturaConfig; /** The wording of the art. 310 mention where it is not the law's own: set, `''` for none; unset, the law's. */ exemptNote?: string }
  | {
      enabled: true;
      issuer: 'billyou';
      /** The VAT in what a buyer pays, in percent (0 where the operator does not charge it). */
      vatPercent: number;
      /** Whether each invoice is also sent to ANAF's e-Factura. */
      efactura: boolean;
      /** Whether the service mails each invoice to the buyer. */
      mail: boolean;
      billyou: { apiKey: string; seriesId: string; zeroVat: { taxCategory: 'O' | 'Z' | 'E' | 'AE' } | null };
      exemptNote?: string;
    };

export function readInvoicingConfig(env: NodeJS.ProcessEnv, billing: BillingConfig, problems: string[]): InvoicingConfig {
  const issuer = (env.SPINE_INVOICING ?? 'off').trim().toLowerCase();
  if (issuer === 'off' || issuer === '') {
    // Live payments without an invoice for each are not a state to run in: the operator is the seller. A test key may go without, to try the plans before the invoicing is set up.
    if (billing.enabled && billing.environment === 'production') problems.push('SPINE_BILLING with a live Stripe key needs SPINE_INVOICING=billyou or efactura: the operator issues an invoice for each payment');
    return { enabled: false };
  }
  if (issuer !== 'billyou' && issuer !== 'efactura') {
    problems.push(`SPINE_INVOICING is "${issuer}"; expected off, billyou or efactura`);
    return { enabled: false };
  }
  if (!billing.enabled) problems.push('SPINE_INVOICING needs SPINE_BILLING=on: the operator issues an invoice for each payment');

  const need = (name: string): string => {
    const value = (env[name] ?? '').trim();
    if (!value) problems.push(`SPINE_INVOICING=${issuer} needs ${name}`);
    return value;
  };
  const flag = (name: string, fallback: boolean): boolean => {
    const raw = (env[name] ?? '').trim().toLowerCase();
    if (raw === '') return fallback;
    if (raw !== 'on' && raw !== 'off') problems.push(`${name} is "${raw}"; expected on or off`);
    return raw === 'on';
  };

  // The VAT of an invoice is the buyer's own: where the buyer is and whether the company is registered for VAT (the settings on the invoices page, `vat.ts`), for a service as for Spine's own link. Only the wording
  // of the art. 310 mention can be set here: unset, the law's own; `off`, none.
  const rawNote = (env.SPINE_INVOICING_VAT_NOTE ?? '').trim();
  const exemptNote = rawNote.toLowerCase() === 'off' ? '' : rawNote ? rawNote.slice(0, 200) : undefined;
  const wording = exemptNote === undefined ? {} : { exemptNote };
  if (issuer === 'efactura') {
    const direct = readEfacturaConfig(env, { category: 'O', ...(exemptNote === undefined ? { note: EXEMPT_NOTE } : exemptNote ? { note: exemptNote } : {}) }, need, problems);
    return { enabled: true, issuer: 'efactura', vatPercent: 0, efactura: true, mail: false, direct, ...wording };
  }
  const billyou = { apiKey: need('BILLYOU_API_KEY'), seriesId: need('BILLYOU_SERIES_ID'), zeroVat: { taxCategory: 'O' as const } };
  return { enabled: true, issuer, vatPercent: 0, efactura: flag('SPINE_INVOICING_EFACTURA', false), mail: flag('SPINE_INVOICING_MAIL', true), billyou, ...wording };
}

/** The settings on their own, for the webhook and the hourly job (read each time: cheap, and a test changes the environment). */
export function loadInvoicingConfig(billing: BillingConfig, env: NodeJS.ProcessEnv = process.env): InvoicingConfig {
  const problems: string[] = [];
  const config = readInvoicingConfig(env, billing, problems);
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/** The settings of Spine's own link to ANAF: the application registered there, the key that seals its tokens and the series. Not who the seller is: that is saved on the admin page (`seller.ts`), for both ways of invoicing. */
function readEfacturaConfig(env: NodeJS.ProcessEnv, zeroVat: ZeroVat, need: (name: string) => string, problems: string[]): EfacturaConfig {
  const mode = (env.SPINE_EFACTURA_MODE ?? 'test').trim().toLowerCase();
  if (mode !== 'test' && mode !== 'prod') problems.push(`SPINE_EFACTURA_MODE is "${mode}"; expected test or prod`);
  const rawKey = need('SPINE_EFACTURA_KEY');
  const key = Buffer.from(rawKey, 'base64');
  if (rawKey && key.length !== 32) problems.push('SPINE_EFACTURA_KEY must be 32 random bytes in base64 (openssl rand -base64 32)');
  const redirectUri = need('SPINE_EFACTURA_REDIRECT_URI');
  if (redirectUri && !redirectUri.startsWith('https://')) problems.push('SPINE_EFACTURA_REDIRECT_URI must be an https address: ANAF refuses any other');
  const domain = need('SPINE_DOMAIN');
  return {
    mode: mode === 'prod' ? 'prod' : 'test', clientId: need('ANAF_CLIENT_ID'), clientSecret: need('ANAF_CLIENT_SECRET'), redirectUri, key,
    series: (env.SPINE_EFACTURA_SERIES ?? 'SPN').trim().toUpperCase(), zeroVat, publicUrl: `https://${domain}`,
  };
}
