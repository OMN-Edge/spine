import { ConfigError } from 'spine-core/config.js';
import type { BillingConfig } from '../config.js';

/**
 * Whether the operator issues an invoice for each payment, and through which service: **off unless `SPINE_INVOICING` names one** (Billyou is the only one), and only with a payment provider
 * that is not the seller of record (Stripe; Paddle sends its own invoices). On, every setting of the service and the VAT the operator charges is given, or the
 * process does not start (P3): the VAT is the accountant's word and is never assumed (`docs/billing.md`, "Invoices").
 */
export type InvoicingConfig =
  | { enabled: false }
  | {
      enabled: true;
      issuer: 'billyou';
      /** The VAT in what a buyer pays, in percent (0 where the operator does not charge it). */
      vatPercent: number;
      /** Whether each invoice is also sent to ANAF's e-Factura. */
      efactura: boolean;
      /** Whether the service mails each invoice to the buyer. */
      mail: boolean;
      billyou: { apiKey: string; seriesId: string; zeroVat: { taxCategory: 'O' | 'Z' | 'E' | 'AE'; vatExemptionCode?: string } | null };
    };

export function readInvoicingConfig(env: NodeJS.ProcessEnv, billing: BillingConfig, problems: string[]): InvoicingConfig {
  const issuer = (env.SPINE_INVOICING ?? 'off').trim().toLowerCase();
  if (issuer === 'off' || issuer === '') return { enabled: false };
  if (issuer !== 'billyou') {
    problems.push(`SPINE_INVOICING is "${issuer}"; expected off or billyou`);
    return { enabled: false };
  }
  if (!billing.enabled || billing.provider !== 'stripe') problems.push('SPINE_INVOICING needs SPINE_BILLING=on with SPINE_BILLING_PROVIDER=stripe: Paddle is the seller and sends its own invoices');

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
  const billyou = {
    apiKey: need('BILLYOU_API_KEY'), seriesId: need('BILLYOU_SERIES_ID'),
    zeroVat: vatPercent === 0 && ['O', 'Z', 'E', 'AE'].includes(zero) ? { taxCategory: zero as 'O' | 'Z' | 'E' | 'AE', ...(code ? { vatExemptionCode: code } : {}) } : null,
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
