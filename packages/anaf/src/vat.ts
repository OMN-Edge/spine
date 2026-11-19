import type { ZeroVat } from './ubl.js';

/**
 * The VAT an invoice to a person carries, from where the buyer is and what the seller is (the owner's word of 2026-11-19: only people buy, and the company becomes a VAT payer). It names nothing of Spine's (S15).
 * - A seller **not registered for VAT** (art. 310 of the Fiscal Code) charges none: for a person in Romania or in another EU country (below the 10,000 EUR a year of art. 278^1, where the place of supply
 *   stays Romania) the invoice says it is exempt under art. 310; for a person outside the EU the service is supplied where the buyer is (art. 278 alin. (5) lit. h), and the invoice says it is not taxable in Romania.
 * - A seller **registered for VAT** charges Romania's rate to a person in Romania; to a person in another EU country the rate of that country where the company has joined the One Stop Shop (`oss`), else Romania's
 *   (below the 10,000 EUR, the place is still Romania); to a person outside the EU none, with the same mention of a service not taxable in Romania.
 * Docs: `docs/efactura.md`, "What an invoice says for each buyer".
 */
export interface VatSettings {
  /** Whether the seller is registered for VAT, from the day `from` (an invoice dated before it is the exempt kind). */
  registered: boolean;
  from: string | null;
  /** Whether the company has joined the One Stop Shop: a person in another EU country is then charged that country's rate. */
  oss: boolean;
}

export const NOT_REGISTERED: VatSettings = { registered: false, from: null, oss: false };

export const EXEMPT_NOTE = 'Scutit de TVA conform art. 310 din Codul fiscal';
export const NOT_TAXABLE_NOTE = 'Neimpozabil în România conform art. 278 alin. (5) lit. h) din Codul fiscal';

/**
 * The standard rate of each EU country on a service (a subscription to software has no reduced rate), by ISO country code (Greece is GR, not its VAT prefix EL). Read on 2026-11-19 from the Your Europe table as a
 * 2026 summary repeats it (vatupdate.com); rates change, so this is the one place to mend when one does, and an invoice keeps the rate it was made with. Checked by a test for its size and for Romania.
 */
export const EU_VAT_RATES: Readonly<Record<string, number>> = {
  AT: 20, BE: 21, BG: 20, HR: 25, CY: 19, CZ: 21, DK: 25, EE: 24, FI: 25.5, FR: 20, DE: 19, GR: 24, HU: 27, IE: 23, IT: 22, LV: 21, LT: 21, LU: 17, MT: 18, NL: 21, PL: 23, PT: 23, RO: 21, SK: 23, SI: 22, ES: 21, SE: 25,
};

export const isEuCountry = (country: string): boolean => Object.hasOwn(EU_VAT_RATES, country.toUpperCase());

export interface VatTreatment {
  /** 0 where there is no VAT. */
  percent: number;
  /** What the lines with no VAT are: their class and the mention. Present whatever the percent, for the builder; unused where every line is taxed. */
  zeroVat: ZeroVat;
}

/** What an invoice dated `onDate` to a person in `country` carries. `exemptNote` words the art. 310 mention otherwise than the law's own, where the accountant asks for it. */
export function vatTreatment(country: string, onDate: string, settings: VatSettings, options: { exemptNote?: string | undefined } = {}): VatTreatment {
  const c = country.toUpperCase();
  const registered = settings.registered && (!settings.from || onDate >= settings.from);
  const exempt: ZeroVat = { category: 'O', ...(options.exemptNote === undefined ? { note: EXEMPT_NOTE } : options.exemptNote ? { note: options.exemptNote } : {}) };
  const notTaxable: ZeroVat = { category: 'O', note: NOT_TAXABLE_NOTE };
  if (!isEuCountry(c)) return { percent: 0, zeroVat: notTaxable };
  if (!registered) return { percent: 0, zeroVat: exempt };
  const home = EU_VAT_RATES.RO!;
  return { percent: c === 'RO' || !settings.oss ? home : EU_VAT_RATES[c]!, zeroVat: { category: 'O' } };
}
