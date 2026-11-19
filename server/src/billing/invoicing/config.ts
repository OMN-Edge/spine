import { ConfigError } from 'spine-core/config.js';
import type { BillingConfig } from '../config.js';
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
  | { enabled: true; issuer: 'efactura'; vatPercent: number; efactura: true; mail: false; direct: EfacturaConfig }
  | {
      enabled: true;
      issuer: 'billyou';
      /** The VAT in what a buyer pays, in percent (0 where the operator does not charge it). */
      vatPercent: number;
      /** Whether each invoice is also sent to ANAF's e-Factura. */
      efactura: boolean;
      /** Whether the service mails each invoice to the buyer. */
      mail: boolean;
      billyou: { apiKey: string; seriesId: string; zeroVat: { taxCategory: 'O' | 'Z' | 'E' | 'AE'; vatExemptionCode?: string; note?: string } | null };
    };

export function readInvoicingConfig(env: NodeJS.ProcessEnv, billing: BillingConfig, problems: string[]): InvoicingConfig {
  const issuer = (env.SPINE_INVOICING ?? 'off').trim().toLowerCase();
  if (issuer === 'off' || issuer === '') return { enabled: false };
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

  const rawVat = need('SPINE_INVOICING_VAT_PERCENT');
  const vatPercent = Number(rawVat);
  if (rawVat && (!Number.isFinite(vatPercent) || vatPercent < 0 || vatPercent > 100)) problems.push(`SPINE_INVOICING_VAT_PERCENT is "${rawVat}"; expected a number from 0 to 100`);

  const zero = (env.SPINE_INVOICING_ZERO_VAT ?? '').trim().toUpperCase();
  if (vatPercent === 0 && !['O', 'Z', 'E', 'AE'].includes(zero)) problems.push('SPINE_INVOICING_VAT_PERCENT=0 needs SPINE_INVOICING_ZERO_VAT, the tax class of a line with no VAT: O (outside scope), Z (zero-rated), E (exempt) or AE (reverse charge)');
  const code = (env.SPINE_INVOICING_EXEMPTION_CODE ?? '').trim();
  if (zero === 'E' && !code) problems.push('SPINE_INVOICING_ZERO_VAT=E needs SPINE_INVOICING_EXEMPTION_CODE (the VATEX code of the exemption)');
  // The mention on an invoice with a line that has no VAT, the accountant's "scutit de tva" and the article of the regime for companies not registered for VAT (art. 310, 2026-11-19); `off` leaves it out.
  const rawNote = (env.SPINE_INVOICING_VAT_NOTE ?? '').trim();
  const note = vatPercent === 0 && rawNote.toLowerCase() !== 'off' ? (rawNote || 'Scutit de TVA conform art. 310 din Codul fiscal').slice(0, 200) : undefined;
  if (issuer === 'efactura') {
    const direct = readEfacturaConfig(env, vatPercent === 0 && ['O', 'Z', 'E', 'AE'].includes(zero) ? { category: zero as ZeroVat['category'], ...(code ? { exemptionCode: code } : {}), ...(note ? { note } : {}) } : { category: 'O' }, need, problems);
    return { enabled: true, issuer: 'efactura', vatPercent: Number.isFinite(vatPercent) ? vatPercent : 0, efactura: true, mail: false, direct };
  }
  const billyou = {
    apiKey: need('BILLYOU_API_KEY'), seriesId: need('BILLYOU_SERIES_ID'),
    zeroVat: vatPercent === 0 && ['O', 'Z', 'E', 'AE'].includes(zero) ? { taxCategory: zero as 'O' | 'Z' | 'E' | 'AE', ...(code ? { vatExemptionCode: code } : {}), ...(note ? { note } : {}) } : null,
  };
  return { enabled: true, issuer, vatPercent: Number.isFinite(vatPercent) ? vatPercent : 0, efactura: flag('SPINE_INVOICING_EFACTURA', false), mail: flag('SPINE_INVOICING_MAIL', true), billyou };
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
