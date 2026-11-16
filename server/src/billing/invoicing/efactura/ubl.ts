/**
 * The invoice as ANAF's e-Factura takes it: UBL 2.1 in the Romanian profile CIUS-RO 1.0.1 (an Invoice, or a CreditNote for a storno). Written against the
 * Ministry of Finance's own artefacts, which are in `docs/reference/efactura/`: the Schematron 1.0.9 (`RO16931-rules.sch` and the EN 16931 model), its two
 * examples, and the notes on what changed in CIUS-RO. What those rules ask of the seller this operator is, and the choices that follow, are marked below.
 *
 * Amounts are whole minor units (cents) until they are written, so nothing here is a floating-point sum. Pure: no clock, no network, no store.
 */
export const CUSTOMIZATION_ID = 'urn:cen.eu:en16931:2017#compliant#urn:efactura.mfinante.ro:CIUS-RO:1.0.1';

/** The classes of "no VAT" an invoice can carry (EN 16931): outside scope, zero-rated, exempt (with a reason code), reverse charge. */
export type ZeroVat = { category: 'O' | 'Z' | 'E' | 'AE'; exemptionCode?: string };

export interface UblSeller {
  name: string;
  /** What the customer knows the business as, if it differs (BT-28). */
  tradeName?: string;
  /** The tax registration number without the RO prefix, digits only (the CIF). */
  cif: string;
  /** The VAT id with its prefix ("RO12345678") where the seller is a VAT payer; absent for one that is not, and then the CIF alone identifies it. */
  vatId?: string;
  /** The trade register number ("J40/123/2020"), if the invoice shows it. */
  registerNo?: string;
  street: string;
  city: string;
  /** The county as the two-letter code ("B", "CJ"); Bucharest's city is then written as its sector. */
  county: string;
  /** Bucharest's sector, 1 to 6, for an address there. */
  sector?: string;
  postalCode: string;
  email?: string;
}

export interface UblBuyer {
  name: string;
  /** Two-letter country. */
  country: string;
  street?: string;
  city?: string;
  /** The county code for an address in Romania; "B" for Bucharest. */
  county?: string;
  sector?: string;
  postalCode?: string;
  /** The tax id of a company (digits, with or without "RO"); absent for a person. */
  taxId?: string;
  /** What identifies a person who gave no CNP: ANAF's testing platform accepts thirteen zeros for it (the Ministry's technical page, B2C). */
  personalId?: string;
  email?: string;
}

export interface UblLine {
  name: string;
  quantity: number;
  /** The net amount of the whole line, in minor units. */
  netMinor: number;
  vatPercent: number;
}

export interface UblDocument {
  kind: 'invoice' | 'credit';
  /** The invoice number as printed ("SPN-00001"): it must hold a digit (BR-RO-010). */
  id: string;
  /** YYYY-MM-DD. */
  issueDate: string;
  currency: string;
  /** RON per unit of the invoice's currency, needed only where there is VAT to state in RON (BT-111). */
  rate?: number;
  seller: UblSeller;
  buyer: UblBuyer;
  lines: UblLine[];
  zeroVat: ZeroVat;
  /** For a credit note: the number of the invoice it reverses (BT-25). */
  reverses?: string;
  /** A line of text on the document (BT-22). */
  note?: string;
  /** Whether the buyer has paid already (the card was charged), so nothing is due. */
  paid: boolean;
}

export class UblError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UblError';
  }
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Minor units as the decimal ANAF counts (two places at most: BR-DEC-RO). */
export const money = (minor: number): string => `${minor < 0 ? '-' : ''}${Math.floor(Math.abs(minor) / 100)}.${String(Math.abs(minor) % 100).padStart(2, '0')}`;
/** A price or a quantity with up to six places and no trailing zeros ("12.5", "3"). */
const plain = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(6).replace(/0+$/, '').replace(/\.$/, ''));
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** The ISO 3166-2:RO subdivision code of a county ("CJ" gives "RO-CJ"; Bucharest is "RO-B"), as BR-RO-110 and BR-RO-111 list them. */
const COUNTY = /^[A-Z]{1,2}$/;
const subdivision = (county: string): string => {
  const code = county.trim().toUpperCase().replace(/^RO-/, '');
  if (!COUNTY.test(code)) throw new UblError(`"${county}" is not a county code`);
  return `RO-${code}`;
};

/** In Romania Bucharest's "city" is its sector, "SECTOR1" to "SECTOR6" (BR-RO-100); everywhere else the city as given. */
function address(a: { street?: string; city?: string; county?: string; sector?: string; postalCode?: string; country: string }, who: string): string {
  const inRo = a.country.toUpperCase() === 'RO';
  let city = (a.city ?? '').trim();
  let sub = '';
  if (inRo) {
    if (!a.county) throw new UblError(`${who}'s county is missing (a Romanian address needs one)`);
    sub = subdivision(a.county);
    if (sub === 'RO-B') {
      if (!/^[1-6]$/.test(a.sector ?? '')) throw new UblError(`${who}'s sector is missing (an address in Bucharest needs sector 1 to 6)`);
      city = `SECTOR${a.sector}`;
    }
  }
  // BR-RO-082 and BR-RO-092: the street and the city must hold something. A buyer's checkout may not have asked for a street; the county or the country stands in rather than a refusal.
  const street = (a.street ?? '').trim() || city || a.country.toUpperCase();
  if (!city) city = a.county ? sub.replace('RO-', '') : a.country.toUpperCase();
  return [
    '<cac:PostalAddress>',
    `<cbc:StreetName>${esc(clip(street, 150))}</cbc:StreetName>`,
    `<cbc:CityName>${esc(clip(city, 50))}</cbc:CityName>`,
    ...(a.postalCode ? [`<cbc:PostalZone>${esc(clip(a.postalCode, 20))}</cbc:PostalZone>`] : []),
    ...(sub ? [`<cbc:CountrySubentity>${sub}</cbc:CountrySubentity>`] : []),
    `<cac:Country><cbc:IdentificationCode>${esc(a.country.toUpperCase())}</cbc:IdentificationCode></cac:Country>`,
    '</cac:PostalAddress>',
  ].join('');
}

/** A tax id as digits with the country prefix removed ("RO 123" gives "123"). */
export const digitsOf = (taxId: string): string => taxId.toUpperCase().replace(/^RO/, '').replace(/[^0-9]/g, '');

interface Group { category: string; percent: number | null; reason: boolean; netMinor: number; vatMinor: number }

/** The totals: the VAT breakdown by class and rate, and the sums, so that every rule of arithmetic in EN 16931 (BR-CO-10 to BR-CO-16) holds by construction. */
export function totalsOf(doc: Pick<UblDocument, 'lines' | 'zeroVat'>): { groups: Group[]; netMinor: number; vatMinor: number; grossMinor: number } {
  const byKey = new Map<string, Group>();
  for (const line of doc.lines) {
    const taxed = line.vatPercent > 0;
    const key = taxed ? `S:${line.vatPercent}` : doc.zeroVat.category;
    const group = byKey.get(key) ?? { category: taxed ? 'S' : doc.zeroVat.category, percent: taxed ? line.vatPercent : null, reason: !taxed, netMinor: 0, vatMinor: 0 };
    group.netMinor += line.netMinor;
    byKey.set(key, group);
  }
  let vat = 0;
  for (const group of byKey.values()) {
    group.vatMinor = group.percent === null ? 0 : Math.round((group.netMinor * group.percent) / 100);
    vat += group.vatMinor;
  }
  const net = [...byKey.values()].reduce((sum, g) => sum + g.netMinor, 0);
  const groups = [...byKey.values()];
  // BR-O-11: a class "not subject to VAT" stands alone; mixing it with another class is a refusal here and not at ANAF.
  if (groups.some(g => g.category === 'O') && groups.length > 1) throw new UblError('an invoice with a line outside the scope of VAT cannot also have taxed lines');
  return { groups, netMinor: net, vatMinor: vat, grossMinor: net + vat };
}

const EXEMPTION_TEXT: Record<string, string> = {
  O: 'Operatiune in afara sferei TVA: vanzator neplatitor de TVA',
  Z: 'Cota zero',
  E: 'Operatiune scutita de TVA',
  AE: 'Taxare inversa',
};

export function buildUbl(doc: UblDocument): string {
  if (!/[0-9]/.test(doc.id)) throw new UblError('the invoice number must hold a digit (BR-RO-010)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(doc.issueDate)) throw new UblError('the date must be YYYY-MM-DD (BR-RO-DT001)');
  if (doc.lines.length === 0) throw new UblError('an invoice needs a line');
  if (doc.kind === 'credit' && !doc.reverses) throw new UblError('a credit note names the invoice it reverses');
  const cur = doc.currency.toUpperCase();
  const t = totalsOf(doc);
  const inRon = cur === 'RON';
  if (!inRon && t.vatMinor > 0 && !(doc.rate && doc.rate > 0)) throw new UblError('an invoice with VAT in a currency other than RON needs the rate of the day (BT-111)');
  const ron = (minor: number) => Math.round(minor * (doc.rate ?? 1));
  const amount = (minor: number, c = cur) => `<cbc:__ currencyID="${c}">${money(minor)}</cbc:__>`;
  const el = (name: string, minor: number, c = cur) => amount(minor, c).replace(/__/g, name);

  const credit = doc.kind === 'credit';
  const root = credit ? 'CreditNote' : 'Invoice';
  const ns = `urn:oasis:names:specification:ubl:schema:xsd:${root}-2`;
  const s = doc.seller;
  const b = doc.buyer;
  const buyerInRo = b.country.toUpperCase() === 'RO';

  const sellerVat = s.vatId ? `<cac:PartyTaxScheme><cbc:CompanyID>${esc(s.vatId)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>` : '';
  const seller = [
    '<cac:AccountingSupplierParty><cac:Party>',
    ...(s.tradeName ? [`<cac:PartyName><cbc:Name>${esc(clip(s.tradeName, 200))}</cbc:Name></cac:PartyName>`] : []),
    address({ street: s.street, city: s.city, county: s.county, sector: s.sector, postalCode: s.postalCode, country: 'RO' }, 'the seller'),
    // A seller that is not a VAT payer has no VAT identifier, and an invoice of the class "not subject to VAT" may not carry one (BR-O-02): its CIF is the legal registration identifier (BT-30, BR-CO-26).
    sellerVat,
    `<cac:PartyLegalEntity><cbc:RegistrationName>${esc(clip(s.name, 200))}</cbc:RegistrationName><cbc:CompanyID>${esc(s.cif)}</cbc:CompanyID>${s.registerNo ? `<cbc:CompanyLegalForm>${esc(s.registerNo)}</cbc:CompanyLegalForm>` : ''}</cac:PartyLegalEntity>`,
    ...(s.email ? [`<cac:Contact><cbc:ElectronicMail>${esc(s.email)}</cbc:ElectronicMail></cac:Contact>`] : []),
    '</cac:Party></cac:AccountingSupplierParty>',
  ].join('');

  // A company is identified by its tax id as the legal registration identifier (BT-47: the VAT class of an invoice forbids BT-48); a person by the thirteen zeros ANAF takes for one who gave no CNP (BT-46).
  const buyerId = b.taxId
    ? `<cac:PartyLegalEntity><cbc:RegistrationName>${esc(clip(b.name, 200))}</cbc:RegistrationName><cbc:CompanyID>${esc(buyerInRo ? digitsOf(b.taxId) : b.taxId)}</cbc:CompanyID></cac:PartyLegalEntity>`
    : `<cac:PartyLegalEntity><cbc:RegistrationName>${esc(clip(b.name, 200))}</cbc:RegistrationName></cac:PartyLegalEntity>`;
  const buyer = [
    '<cac:AccountingCustomerParty><cac:Party>',
    ...(!b.taxId ? [`<cac:PartyIdentification><cbc:ID>${esc(b.personalId ?? (buyerInRo ? '0000000000000' : '-'))}</cbc:ID></cac:PartyIdentification>`] : []),
    `<cac:PartyName><cbc:Name>${esc(clip(b.name, 200))}</cbc:Name></cac:PartyName>`,
    address(b, 'the buyer'),
    buyerId,
    ...(b.email ? [`<cac:Contact><cbc:ElectronicMail>${esc(b.email)}</cbc:ElectronicMail></cac:Contact>`] : []),
    '</cac:Party></cac:AccountingCustomerParty>',
  ].join('');

  const breakdown = t.groups.map(g => [
    '<cac:TaxSubtotal>',
    el('TaxableAmount', g.netMinor), el('TaxAmount', g.vatMinor),
    `<cac:TaxCategory><cbc:ID>${g.category}</cbc:ID>${g.percent === null ? '' : `<cbc:Percent>${plain(g.percent)}</cbc:Percent>`}`,
    ...(g.reason ? [...(doc.zeroVat.exemptionCode ? [`<cbc:TaxExemptionReasonCode>${esc(doc.zeroVat.exemptionCode)}</cbc:TaxExemptionReasonCode>`] : []), `<cbc:TaxExemptionReason>${EXEMPTION_TEXT[g.category]}</cbc:TaxExemptionReason>`] : []),
    '<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory>',
    '</cac:TaxSubtotal>',
  ].join('')).join('');

  const lines = doc.lines.map((line, i) => {
    const g = t.groups.find(x => (line.vatPercent > 0 ? x.category === 'S' && x.percent === line.vatPercent : x.percent === null))!;
    const unit = line.netMinor / 100 / line.quantity;
    return [
      credit ? '<cac:CreditNoteLine>' : '<cac:InvoiceLine>',
      `<cbc:ID>${i + 1}</cbc:ID>`,
      `<cbc:${credit ? 'CreditedQuantity' : 'InvoicedQuantity'} unitCode="C62">${plain(line.quantity)}</cbc:${credit ? 'CreditedQuantity' : 'InvoicedQuantity'}>`,
      el('LineExtensionAmount', line.netMinor),
      `<cac:Item><cbc:Name>${esc(clip(line.name, 100))}</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>${g.category}</cbc:ID>${g.percent === null ? '' : `<cbc:Percent>${plain(g.percent)}</cbc:Percent>`}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item>`,
      `<cac:Price><cbc:PriceAmount currencyID="${cur}">${plain(Math.round(unit * 1e6) / 1e6)}</cbc:PriceAmount></cac:Price>`,
      credit ? '</cac:CreditNoteLine>' : '</cac:InvoiceLine>',
    ].join('');
  }).join('');

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<${root} xmlns="${ns}" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">`,
    `<cbc:CustomizationID>${CUSTOMIZATION_ID}</cbc:CustomizationID>`,
    `<cbc:ID>${esc(doc.id)}</cbc:ID>`,
    `<cbc:IssueDate>${doc.issueDate}</cbc:IssueDate>`,
    ...(credit ? [] : [`<cbc:DueDate>${doc.issueDate}</cbc:DueDate>`]),
    credit ? '<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>' : '<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>',
    ...(doc.note ? [`<cbc:Note>${esc(clip(doc.note, 300))}</cbc:Note>`] : []),
    `<cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>`,
    // BR-RO-030: an invoice in another currency states its VAT in RON as well.
    ...(inRon ? [] : ['<cbc:TaxCurrencyCode>RON</cbc:TaxCurrencyCode>']),
    ...(credit ? [`<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${esc(doc.reverses!)}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>`] : []),
    seller,
    buyer,
    // The card was charged: code 48 is payment by bank card.
    '<cac:PaymentMeans><cbc:PaymentMeansCode>48</cbc:PaymentMeansCode></cac:PaymentMeans>',
    `<cac:TaxTotal>${el('TaxAmount', t.vatMinor)}${breakdown}</cac:TaxTotal>`,
    ...(inRon ? [] : [`<cac:TaxTotal>${el('TaxAmount', ron(t.vatMinor), 'RON')}</cac:TaxTotal>`]),
    '<cac:LegalMonetaryTotal>',
    el('LineExtensionAmount', t.netMinor), el('TaxExclusiveAmount', t.netMinor), el('TaxInclusiveAmount', t.grossMinor),
    ...(doc.paid ? [el('PrepaidAmount', t.grossMinor)] : []),
    el('PayableAmount', doc.paid ? 0 : t.grossMinor),
    '</cac:LegalMonetaryTotal>',
    lines,
    `</${root}>`,
  ].join('');
  return xml;
}

/** What a buyer is for the upload: a company or a person in Romania (B2B or B2C), or someone abroad, which e-Factura does not take (it is for a Romanian buyer). */
export function routeOf(buyer: Pick<UblBuyer, 'country' | 'taxId'>): 'b2b' | 'b2c' | 'abroad' {
  if (buyer.country.toUpperCase() !== 'RO') return 'abroad';
  return buyer.taxId ? 'b2b' : 'b2c';
}
