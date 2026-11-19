import { describe, expect, it } from 'vitest';
import { EU_VAT_RATES, EXEMPT_NOTE, NOT_REGISTERED, NOT_TAXABLE_NOTE, isEuCountry, vatTreatment, type VatSettings } from '../vat.js';

/** The VAT an invoice to a person carries (`vat.ts`): from where the buyer is, and what the seller is. */
const REGISTERED: VatSettings = { registered: true, from: '2026-12-01', oss: false };
const OSS: VatSettings = { ...REGISTERED, oss: true };

describe('the rates', () => {
  it('are one for each of the 27 member states, Greece under GR, and Romania\u2019s is 21', () => {
    expect(Object.keys(EU_VAT_RATES)).toHaveLength(27);
    expect(EU_VAT_RATES.RO).toBe(21);
    expect(isEuCountry('gr')).toBe(true);
    expect(isEuCountry('EL')).toBe(false);
    expect(isEuCountry('GB')).toBe(false);
    for (const rate of Object.values(EU_VAT_RATES)) expect(rate).toBeGreaterThanOrEqual(15);
  });
});

describe('a company not registered for VAT', () => {
  it('charges none to a person in Romania or in another EU country, and the invoice says it is exempt under art. 310', () => {
    for (const country of ['RO', 'DE', 'fr']) expect(vatTreatment(country, '2026-11-05', NOT_REGISTERED)).toEqual({ percent: 0, zeroVat: { category: 'O', note: EXEMPT_NOTE } });
  });

  it('charges none to a person outside the EU, and the invoice says the service is not taxable in Romania', () => {
    for (const country of ['US', 'GB', 'CH']) expect(vatTreatment(country, '2026-11-05', NOT_REGISTERED)).toEqual({ percent: 0, zeroVat: { category: 'O', note: NOT_TAXABLE_NOTE } });
  });

  it('words the art. 310 mention as the operator set it, or leaves it out', () => {
    expect(vatTreatment('RO', '2026-11-05', NOT_REGISTERED, { exemptNote: 'Scutit de TVA' }).zeroVat.note).toBe('Scutit de TVA');
    expect(vatTreatment('RO', '2026-11-05', NOT_REGISTERED, { exemptNote: '' }).zeroVat.note).toBeUndefined();
    // Not for a person outside the EU, whose mention is the law's own.
    expect(vatTreatment('US', '2026-11-05', NOT_REGISTERED, { exemptNote: '' }).zeroVat.note).toBe(NOT_TAXABLE_NOTE);
  });
});

describe('a company registered for VAT', () => {
  it('charges Romania\u2019s rate to a person in Romania, and to one in another EU country until it has joined the One Stop Shop', () => {
    expect(vatTreatment('RO', '2026-12-01', REGISTERED).percent).toBe(21);
    expect(vatTreatment('DE', '2026-12-01', REGISTERED).percent).toBe(21);
  });

  it('charges the rate of the buyer\u2019s country to a person in another EU country once it has, and Romania\u2019s to one in Romania', () => {
    expect(vatTreatment('DE', '2026-12-01', OSS).percent).toBe(19);
    expect(vatTreatment('FR', '2026-12-01', OSS).percent).toBe(20);
    expect(vatTreatment('FI', '2026-12-01', OSS).percent).toBe(25.5);
    expect(vatTreatment('RO', '2026-12-01', OSS).percent).toBe(21);
  });

  it('charges none to a person outside the EU', () => {
    expect(vatTreatment('US', '2026-12-01', OSS)).toEqual({ percent: 0, zeroVat: { category: 'O', note: NOT_TAXABLE_NOTE } });
  });

  it('applies from the day it is registered: an invoice dated before is the exempt kind', () => {
    expect(vatTreatment('RO', '2026-11-30', REGISTERED)).toEqual({ percent: 0, zeroVat: { category: 'O', note: EXEMPT_NOTE } });
    expect(vatTreatment('DE', '2026-11-30', OSS).percent).toBe(0);
    expect(vatTreatment('RO', '2026-12-01', REGISTERED).percent).toBe(21);
  });
});
