import { describe, expect, it } from 'vitest';
import { billingDetailsSchema, BUCHAREST, COUNTRIES, RO_COUNTIES } from '../billing/billing-details.js';

/** The billing details an invoice needs: complete for Romania only with a county (and a sector in Bucharest), and nothing asked abroad that Romania asks. */
const person = { name: 'Ana Test', country: 'FR', city: 'Lyon', address: '1 Rue de Test' };
const ok = (d: object) => billingDetailsSchema.safeParse(d);
const messages = (d: object) => { const r = ok(d); return r.success ? [] : r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`); };

describe('the billing details', () => {
  it('are complete for a buyer abroad with a name, a country, a city and a street', () => {
    expect(ok(person).success).toBe(true);
    expect(ok({ ...person, postalCode: '69001', taxId: 'FR123456789' }).success).toBe(true);
  });

  it('need a county in Romania, one that exists, and a sector as well in Bucharest', () => {
    const ro = { ...person, country: 'RO', city: 'Cluj-Napoca' };
    expect(messages(ro)).toEqual(['county: a county is needed for an address in Romania']);
    expect(messages({ ...ro, county: 'Cluj' })).toEqual(['county: a county is needed for an address in Romania']);
    expect(ok({ ...ro, county: 'CJ' }).success).toBe(true);
    expect(messages({ ...ro, county: BUCHAREST })).toEqual(['sector: a sector from 1 to 6 is needed for an address in Bucharest']);
    expect(messages({ ...ro, county: BUCHAREST, sector: '7' })).toHaveLength(1);
    expect(ok({ ...ro, county: BUCHAREST, sector: '3' }).success).toBe(true);
  });

  it('take no county from a buyer abroad, so one is not sent where the form does not ask for it', () => {
    expect(messages({ ...person, county: 'CJ' })).toEqual(['county: a county is only asked for in Romania']);
  });

  it('refuse an empty name, city or street, a country that is not one, and a name too long', () => {
    for (const bad of [{ name: ' ' }, { city: '' }, { address: '' }, { country: 'XX' }, { name: 'x'.repeat(201) }]) expect(ok({ ...person, ...bad }).success, JSON.stringify(bad)).toBe(false);
  });

  it('list forty-one counties and Bucharest, each once, and every country the browser can name', () => {
    expect(RO_COUNTIES).toHaveLength(42);
    expect(new Set(RO_COUNTIES.map(c => c.code)).size).toBe(42);
    expect(RO_COUNTIES.some(c => c.code === 'B')).toBe(true);
    expect(new Set(COUNTRIES).size).toBe(COUNTRIES.length);
    expect(COUNTRIES.length).toBeGreaterThan(240);
    const names = new Intl.DisplayNames('en', { type: 'region' });
    for (const code of COUNTRIES) expect(names.of(code), code).not.toBe(code);
  });
});
