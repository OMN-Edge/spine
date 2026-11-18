import { ConfigError } from 'spine-core/config.js';
import type { BillingConfig } from '../config.js';
import type { UblSeller, ZeroVat } from 'spine-anaf/index.js';

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
  seller: UblSeller;
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
      billyou: { apiKey: string; seriesId: string; zeroVat: { taxCategory: 'O' | 'Z' | 'E' | 'AE'; vatExemptionCode?: string } | null };
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
  if (issuer === 'efactura') {
    const direct = readEfacturaConfig(env, vatPercent === 0 && ['O', 'Z', 'E', 'AE'].includes(zero) ? { category: zero as ZeroVat['category'], ...(code ? { exemptionCode: code } : {}) } : { category: 'O' }, need, problems);
    return { enabled: true, issuer: 'efactura', vatPercent: Number.isFinite(vatPercent) ? vatPercent : 0, efactura: true, mail: false, direct };
  }
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

/** The settings of Spine's own link to ANAF: the application registered there, the key that seals its tokens, and who the seller is on the invoice (every field of an address the e-Factura rules ask for). */
function readEfacturaConfig(env: NodeJS.ProcessEnv, zeroVat: ZeroVat, need: (name: string) => string, problems: string[]): EfacturaConfig {
  const mode = (env.SPINE_EFACTURA_MODE ?? 'test').trim().toLowerCase();
  if (mode !== 'test' && mode !== 'prod') problems.push(`SPINE_EFACTURA_MODE is "${mode}"; expected test or prod`);
  const rawKey = need('SPINE_EFACTURA_KEY');
  const key = Buffer.from(rawKey, 'base64');
  if (rawKey && key.length !== 32) problems.push('SPINE_EFACTURA_KEY must be 32 random bytes in base64 (openssl rand -base64 32)');
  const redirectUri = need('SPINE_EFACTURA_REDIRECT_URI');
  if (redirectUri && !redirectUri.startsWith('https://')) problems.push('SPINE_EFACTURA_REDIRECT_URI must be an https address: ANAF refuses any other');
  const cif = need('SPINE_SELLER_CIF').toUpperCase().replace(/^RO/, '').replace(/\s/g, '');
  if (cif && !/^\d{2,10}$/.test(cif)) problems.push('SPINE_SELLER_CIF is the company\'s tax number, digits only (2 to 10)');
  const county = need('SPINE_SELLER_COUNTY').toUpperCase().replace(/^RO-/, '');
  if (county && !/^[A-Z]{1,2}$/.test(county)) problems.push('SPINE_SELLER_COUNTY is the county\'s code ("B", "CJ", "IS")');
  const sector = (env.SPINE_SELLER_SECTOR ?? '').trim();
  if (county === 'B' && !/^[1-6]$/.test(sector)) problems.push('SPINE_SELLER_COUNTY=B (Bucharest) needs SPINE_SELLER_SECTOR, 1 to 6');
  const vatId = (env.SPINE_SELLER_VAT_ID ?? '').trim();
  const registerNo = (env.SPINE_SELLER_REGISTER_NO ?? '').trim();
  const tradeName = (env.SPINE_SELLER_TRADE_NAME ?? '').trim();
  const email = (env.SPINE_SELLER_EMAIL ?? '').trim();
  const bank = (env.SPINE_SELLER_BANK ?? '').trim();
  const iban = (env.SPINE_SELLER_IBAN ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
  if (iban && !/^[A-Z]{2}\d{2}[A-Z0-9 ]{8,30}$/.test(iban)) problems.push('SPINE_SELLER_IBAN is an IBAN (RO49 AAAA 1B31 0075 9384 0000)');
  const domain = need('SPINE_DOMAIN');
  return {
    mode: mode === 'prod' ? 'prod' : 'test', clientId: need('ANAF_CLIENT_ID'), clientSecret: need('ANAF_CLIENT_SECRET'), redirectUri, key,
    seller: {
      name: need('SPINE_SELLER_NAME'), cif, street: need('SPINE_SELLER_STREET'), city: need('SPINE_SELLER_CITY'), county, postalCode: need('SPINE_SELLER_POSTAL_CODE'),
      ...(sector ? { sector } : {}), ...(vatId ? { vatId } : {}), ...(registerNo ? { registerNo } : {}), ...(tradeName ? { tradeName } : {}), ...(email ? { email } : {}), ...(bank ? { bank } : {}), ...(iban ? { iban } : {}),
    },
    series: (env.SPINE_EFACTURA_SERIES ?? 'SPN').trim().toUpperCase(), zeroVat, publicUrl: `https://${domain}`,
  };
}

/**
 * One company, two settings: the footer and the terms name `SPINE_OPERATOR_NAME`, an invoice names `SPINE_SELLER_NAME`. Where Spine issues the invoices itself and the two differ (or the
 * operator's is not set), a buyer reads one company on the page and another on the invoice; this says so at start-up. A warning, not a refusal: a seller may trade under a group's name.
 */
export function sellerNameWarning(config: InvoicingConfig, operator: string | null | undefined): string | null {
  if (!config.enabled || config.issuer !== 'efactura') return null;
  const seller = config.direct.seller.name;
  const fold = (name: string) => name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\./g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  if (!operator?.trim()) return `invoices are made out by "${seller}" (SPINE_SELLER_NAME) but SPINE_OPERATOR_NAME is not set, so the pages say nothing of who sells: set it to the same company`;
  return fold(operator) === fold(seller) ? null : `the pages say "${operator.trim()}" (SPINE_OPERATOR_NAME) sells, and the invoices are made out by "${seller}" (SPINE_SELLER_NAME): a buyer reads two companies. Make them the same, or confirm that they are meant to differ`;
}
