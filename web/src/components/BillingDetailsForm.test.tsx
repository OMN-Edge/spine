import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import BillingDetailsForm from './BillingDetailsForm';
import type { BillingDetails } from 'spine-core/billing/billing-details';

/** The billing details form: Romania asks for a county, Bucharest for a sector, and nowhere else is either asked. */
const base: BillingDetails = { name: 'Ana Test', country: 'FR', city: 'Lyon', address: '1 Rue de Test' };
const draw = (initial: BillingDetails | null) => renderToStaticMarkup(<BillingDetailsForm initial={initial} onSaved={() => undefined} onCancel={() => undefined} />);

describe('the billing details form', () => {
  it('asks a buyer abroad for a name, a country, a city and a street, and no county', () => {
    const html = draw(base);
    for (const id of ['bd-name', 'bd-country', 'bd-city', 'bd-address', 'bd-postal', 'bd-tax']) expect(html, id).toContain(`id="${id}"`);
    expect(html).not.toContain('id="bd-county"');
    expect(html).not.toContain('id="bd-sector"');
  });

  it('asks a buyer in Romania for a county, listing the counties and Bucharest, and the one chosen is selected', () => {
    const html = draw({ ...base, country: 'RO', county: 'CJ', city: 'Cluj-Napoca' });
    expect(html).toContain('id="bd-county"');
    for (const county of ['Alba', 'Cluj', 'Iași', 'București', 'Vrancea']) expect(html, county).toContain(`>${county}</option>`);
    expect(html).toMatch(/<option value="CJ" selected="">Cluj<\/option>/);
    expect(html).not.toContain('id="bd-sector"');
  });

  it('asks for a sector as well for an address in Bucharest', () => {
    const html = draw({ ...base, country: 'RO', county: 'B', sector: '3', city: 'București' });
    expect(html).toContain('id="bd-sector"');
    expect(html).toMatch(/<option value="3" selected="">3<\/option>/);
  });

  it('offers every country, by name, and keeps the account’s own details to fill in again', () => {
    const html = draw({ ...base, taxId: 'FR123456789', postalCode: '69001' });
    expect(html).toContain('>France</option>');
    expect(html).toContain('>Romania</option>');
    expect(html).toContain('value="Ana Test"');
    expect(html).toContain('value="FR123456789"');
  });
});
