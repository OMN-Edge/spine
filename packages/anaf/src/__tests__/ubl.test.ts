import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUbl, digitsOf, money, routeOf, totalsOf, UblError, type UblDocument } from '../ubl.js';
import { netLines } from '../issuer.js';

/** The e-Factura XML (`ubl.ts`): what ANAF's rules ask of it, and that the files are valid UBL against the OASIS schemas the repository keeps. */
const SELLER = { name: 'Omni Edge SRL', tradeName: 'Spine', cif: '12345678', registerNo: 'J40/1234/2020', street: 'Str. Exemplului 1', city: 'Sector 1', county: 'B', sector: '1', postalCode: '010101', email: 'billing@spine.test' };
const ROMANIAN: UblDocument['buyer'] = { name: 'Ion Popescu', country: 'RO', street: 'Str. Mare 5', city: 'Cluj-Napoca', county: 'CJ', email: 'ion@spine.test' };
const draft = (over: Partial<UblDocument> = {}): UblDocument => ({
  kind: 'invoice', id: 'SPN-00001', issueDate: '2026-11-16', currency: 'RON', seller: SELLER, buyer: ROMANIAN,
  lines: [{ name: 'Spine Premium, lunar', quantity: 1, netMinor: 4900, vatPercent: 0 }], zeroVat: { category: 'O' }, paid: true, ...over,
});

const SCHEMAS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../../docs/reference/efactura/ubl-2.1/maindoc');
let hasXmllint = true;
try { execFileSync('xmllint', ['--version'], { stdio: 'ignore' }); } catch { hasXmllint = false; }
/** Validates against the OASIS UBL 2.1 schema for the document's root, with the system's xmllint: the element order and the types, which no rule of the Schematron repeats. */
function validate(xml: string, root: 'Invoice' | 'CreditNote'): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'spine-ubl-'));
  try {
    const file = path.join(dir, 'doc.xml');
    writeFileSync(file, xml);
    try { execFileSync('xmllint', ['--noout', '--schema', path.join(SCHEMAS, `UBL-${root}-2.1.xsd`), file], { stdio: 'pipe' }); return ''; } catch (err) { return String((err as { stderr?: Buffer }).stderr ?? err); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('the invoice as e-Factura takes it', () => {
  it('writes a seller that is not a VAT payer by its registration number alone, in the class "not subject to VAT" (BR-O-02, BR-CO-26)', () => {
    const xml = buildUbl(draft());
    expect(xml).toContain('<cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:efactura.mfinante.ro:CIUS-RO:1.0.1</cbc:CustomizationID>');
    expect(xml).toContain('<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>');
    expect(xml).toContain('<cbc:RegistrationName>Omni Edge SRL</cbc:RegistrationName><cbc:CompanyID>12345678</cbc:CompanyID>');
    // No VAT identifier anywhere: neither the seller's nor the buyer's.
    expect(xml).not.toContain('PartyTaxScheme');
    expect(xml).toContain('<cbc:ID>O</cbc:ID>');
    expect(xml).not.toContain('<cbc:Percent>');
    expect(xml).toContain('<cbc:TaxExemptionReason>');
    // A seller that is a VAT payer names its VAT id and a taxed line has a percent.
    const taxed = buildUbl(draft({ seller: { ...SELLER, vatId: 'RO12345678' }, lines: [{ name: 'Plan', quantity: 1, netMinor: 10000, vatPercent: 21 }] }));
    expect(taxed).toContain('<cbc:CompanyID>RO12345678</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID>');
    expect(taxed).toContain('<cbc:Percent>21</cbc:Percent>');
    expect(taxed).toContain('<cbc:TaxAmount currencyID="RON">21.00</cbc:TaxAmount>');
    expect(taxed).toContain('<cbc:TaxInclusiveAmount currencyID="RON">121.00</cbc:TaxInclusiveAmount>');
  });

  it('writes Bucharest as its sector with the county RO-B, and every other county as RO- and its code (BR-RO-100, BR-RO-110)', () => {
    expect(buildUbl(draft())).toContain('<cbc:CityName>SECTOR1</cbc:CityName>');
    expect(buildUbl(draft())).toContain('<cbc:CountrySubentity>RO-B</cbc:CountrySubentity>');
    const bucharest = buildUbl(draft({ buyer: { ...ROMANIAN, county: 'B', sector: '3', city: 'Bucuresti' } }));
    expect(bucharest).toMatch(/<cbc:CityName>SECTOR3<\/cbc:CityName><cbc:CountrySubentity>RO-B<\/cbc:CountrySubentity>/);
    expect(buildUbl(draft())).toMatch(/<cbc:CityName>Cluj-Napoca<\/cbc:CityName><cbc:CountrySubentity>RO-CJ<\/cbc:CountrySubentity>/);
    expect(() => buildUbl(draft({ buyer: { ...ROMANIAN, county: undefined } }))).toThrow(/county is missing/);
    expect(() => buildUbl(draft({ buyer: { ...ROMANIAN, county: 'B', sector: undefined } }))).toThrow(/sector/);
    expect(() => buildUbl(draft({ buyer: { ...ROMANIAN, county: 'Cluj' } }))).toThrow(UblError);
  });

  it('identifies a company by its tax number as the registration identifier, and a person by the thirteen zeros ANAF takes', () => {
    const company = buildUbl(draft({ buyer: { ...ROMANIAN, name: 'Client SRL', taxId: 'RO 98765432' } }));
    expect(company).toContain('<cbc:RegistrationName>Client SRL</cbc:RegistrationName><cbc:CompanyID>98765432</cbc:CompanyID>');
    expect(company).not.toContain('PartyIdentification');
    const person = buildUbl(draft());
    expect(person).toContain('<cac:PartyIdentification><cbc:ID>0000000000000</cbc:ID></cac:PartyIdentification>');
    expect(buildUbl(draft({ buyer: { ...ROMANIAN, personalId: '1234567890123' } }))).toContain('<cbc:ID>1234567890123</cbc:ID></cac:PartyIdentification>');
    expect(digitsOf('RO 12-345')).toBe('12345');
  });

  it('says which way a buyer is sent: a company, a person, or not at all when abroad', () => {
    expect(routeOf({ country: 'RO', taxId: 'RO1' })).toBe('b2b');
    expect(routeOf({ country: 'RO' })).toBe('b2c');
    expect(routeOf({ country: 'FR' })).toBe('abroad');
  });

  it('states an invoice in another currency with RON as the VAT currency, the VAT in RON from the rate (BR-RO-030, BT-111)', () => {
    const eur = buildUbl(draft({ currency: 'EUR', seller: { ...SELLER, vatId: 'RO12345678' }, rate: 4.9772, lines: [{ name: 'Plan', quantity: 1, netMinor: 10000, vatPercent: 21 }] }));
    expect(eur).toContain('<cbc:TaxCurrencyCode>RON</cbc:TaxCurrencyCode>');
    expect(eur).toContain('<cbc:TaxAmount currencyID="RON">104.52</cbc:TaxAmount>');
    // With no VAT to state the second total is nil and no rate is needed.
    const none = buildUbl(draft({ currency: 'EUR' }));
    expect(none).toContain('<cbc:TaxCurrencyCode>RON</cbc:TaxCurrencyCode>');
    expect(none).toContain('<cbc:TaxAmount currencyID="RON">0.00</cbc:TaxAmount>');
    expect(() => buildUbl(draft({ currency: 'EUR', lines: [{ name: 'Plan', quantity: 1, netMinor: 10000, vatPercent: 21 }] }))).toThrow(/rate/);
  });

  it('makes a credit note of 381 that names the invoice it reverses, in the credit note’s own elements', () => {
    const xml = buildUbl(draft({ kind: 'credit', id: 'SPN-00002', reverses: 'SPN-00001', note: 'Rambursare' }));
    expect(xml).toContain('<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"');
    expect(xml).toContain('<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>');
    expect(xml).toContain('<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>SPN-00001</cbc:ID>');
    expect(xml).toContain('<cac:CreditNoteLine>');
    expect(xml).toContain('<cbc:CreditedQuantity unitCode="C62">1</cbc:CreditedQuantity>');
    expect(xml).not.toContain('DueDate');
    expect(() => buildUbl(draft({ kind: 'credit', id: 'SPN-00002' }))).toThrow(/names the invoice/);
  });

  it('refuses what ANAF would: a number with no digit, a bad date, no line, a mixed class', () => {
    expect(() => buildUbl(draft({ id: 'SPN' }))).toThrow(/digit/);
    expect(() => buildUbl(draft({ issueDate: '16.11.2026' }))).toThrow(/YYYY-MM-DD/);
    expect(() => buildUbl(draft({ lines: [] }))).toThrow(/line/);
    expect(() => buildUbl(draft({ lines: [{ name: 'a', quantity: 1, netMinor: 100, vatPercent: 0 }, { name: 'b', quantity: 1, netMinor: 100, vatPercent: 21 }] }))).toThrow(/outside the scope/);
  });

  it('escapes what a buyer typed, and cuts what the rules limit', () => {
    const xml = buildUbl(draft({ buyer: { ...ROMANIAN, name: 'A & B <SRL> "x"' } }));
    expect(xml).toContain('A &amp; B &lt;SRL&gt; &quot;x&quot;');
    expect(xml).not.toContain('<SRL>');
    expect(buildUbl(draft({ lines: [{ name: 'x'.repeat(300), quantity: 1, netMinor: 100, vatPercent: 0 }] }))).toMatch(/<cbc:Name>x{99}…<\/cbc:Name>/);
  });

  it('does its sums in whole cents so that every total agrees (BR-CO-10 to BR-CO-16)', () => {
    expect(money(5)).toBe('0.05');
    expect(money(123456)).toBe('1234.56');
    const lines = netLines([{ name: 'a', amountMinor: 1000, quantity: 1, vatPercent: 21 }, { name: 'b', amountMinor: 1001, quantity: 2, vatPercent: 21 }]);
    // The whole's net is rounded once, and the lines add up to it exactly.
    expect(lines.reduce((s, l) => s + l.netMinor, 0)).toBe(Math.round((2001 * 100) / 121));
    const t = totalsOf({ lines, zeroVat: { category: 'O' } });
    expect(t.netMinor + t.vatMinor).toBe(t.grossMinor);
    expect(t.groups).toHaveLength(1);
  });

  it.runIf(hasXmllint)('is valid UBL 2.1 for an invoice, a credit note, a taxed invoice in euro and a company, by the OASIS schemas', () => {
    const cases: Array<[UblDocument, 'Invoice' | 'CreditNote']> = [
      [draft(), 'Invoice'],
      [draft({ buyer: { ...ROMANIAN, name: 'Client SRL', taxId: 'RO98765432' } }), 'Invoice'],
      [draft({ currency: 'EUR', seller: { ...SELLER, vatId: 'RO12345678' }, rate: 4.9772, lines: [{ name: 'Plan', quantity: 2, netMinor: 10001, vatPercent: 21 }, { name: 'Top-up', quantity: 1, netMinor: 2500, vatPercent: 21 }] }), 'Invoice'],
      [draft({ kind: 'credit', id: 'SPN-00002', reverses: 'SPN-00001', note: 'Rambursare' }), 'CreditNote'],
    ];
    for (const [doc, root] of cases) expect(validate(buildUbl(doc), root), `${doc.kind} ${doc.id}`).toBe('');
  });
});
