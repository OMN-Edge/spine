import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { renderInvoicePdf, languageOf } from '../document.js';
import { buildUbl, totalsOf, type UblDocument } from '../ubl.js';
import { efacturaIssuer } from '../issuer.js';
import { AnafLink } from '../anaf.js';
import type { DocumentPatch, StoredDocument } from '../store.js';

/** The invoice as a person reads it (`document.ts`): made from the stored document, so it says what the XML says, in English and the buyer's language. */
const SELLER = { name: 'Exemplu Software SRL', cif: '12345678', vatId: 'RO12345678', registerNo: 'J40/1234/2020', street: 'Strada Exemplului 1', city: 'București', county: 'B', sector: '1', postalCode: '010101', email: 'facturi@example.com', bank: 'Banca Exemplu', iban: 'RO49 AAAA 1B31 0075 9384 0000' };
const doc = (over: Partial<UblDocument> = {}): UblDocument => ({
  kind: 'invoice', id: 'SPN-00042', issueDate: '2026-11-17', currency: 'EUR', rate: 4.975, seller: SELLER,
  buyer: { name: 'Jonas Beispiel', country: 'DE', street: 'Musterstraße 12', city: 'München', postalCode: '80331', email: 'jonas@example.com' },
  lines: [{ name: 'Spine Premium, jährlich', quantity: 1, netMinor: 4050, vatPercent: 21 }], zeroVat: { category: 'O' }, paid: true, ...over,
});

/** The text of every page, read with PDF.js as the app reads a PDF. */
async function textOf(pdf: Buffer): Promise<string> {
  const loaded = await getDocument({ data: new Uint8Array(pdf), useSystemFonts: false, isEvalSupported: false }).promise;
  let out = '';
  for (let i = 1; i <= loaded.numPages; i++) out += ` ${(await (await loaded.getPage(i)).getTextContent()).items.map(it => ('str' in it ? it.str : '')).join(' ')}`;
  return out.replace(/\s+/g, ' ');
};
const spaced = (n: string) => n.replace(/ /g, ' ');

describe('the invoice document', () => {
  it('holds every amount the XML holds, since both are made from the same stored document', async () => {
    const d = doc();
    const t = totalsOf(d);
    const xml = buildUbl(d);
    const text = spaced(await textOf(await renderInvoicePdf(d)));
    for (const minor of [t.netMinor, t.vatMinor, t.grossMinor]) {
      const plain = `${Math.floor(minor / 100)},${String(minor % 100).padStart(2, '0')}`;
      expect(text).toContain(plain);
      expect(xml).toContain(`${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`);
    }
  });

  it('shows the seller\'s county, phone and every account with its bank and BIC, and that it is valid without a stamp', async () => {
    const seller = { ...SELLER, county: 'CJ', city: 'Cluj-Napoca', phone: '+40 700 000 000', accounts: [{ iban: 'RO49AAAA1B31007593840000', bank: 'Banca Exemplu', bic: 'EXMPRO22', currency: 'RON' }, { iban: 'RO12BBBB1B31007593840001', bank: 'Banca Exemplu', bic: 'EXMPRO22', currency: 'EUR' }] };
    const text = spaced(await textOf(await renderInvoicePdf(doc({ seller }))));
    for (const shown of ['RO-CJ', '+40 700 000 000', 'RO49AAAA1B31007593840000 (RON)', 'RO12BBBB1B31007593840001 (EUR)', 'BIC EXMPRO22', 'Valid without stamp or signature', 'Gültig ohne Stempel und Unterschrift']) expect(text).toContain(shown);
  });

  it('stands a single bank and IBAN as the one account where there is no list of them', async () => {
    const text = spaced(await textOf(await renderInvoicePdf(doc({ seller: { ...SELLER, bank: 'Banca Exemplu', iban: 'RO49AAAA1B31007593840000' } }))));
    expect(text).toContain('RO49AAAA1B31007593840000');
    expect(text).toContain('Banca Exemplu');
  });

  it('is English first and the buyer’s language beneath: German for a buyer in Germany, Romanian for one in Romania, and English alone for any other country', async () => {
    const german = await textOf(await renderInvoicePdf(doc()));
    expect(german).toContain('Invoice');
    expect(german).toContain('Rechnung');
    expect(german).toContain('Mit Karte bezahlt am');
    const romanian = await textOf(await renderInvoicePdf(doc({ buyer: { name: 'Maria Ionescu', country: 'RO', city: 'Cluj-Napoca', county: 'CJ', street: 'Strada Florilor 7' } })));
    expect(romanian).toContain('Invoice');
    expect(romanian).toContain('Factură');
    const spanish = await textOf(await renderInvoicePdf(doc({ buyer: { name: 'Ana Ejemplo', country: 'ES' } })));
    expect(spanish).toContain('Invoice');
    expect(spanish).not.toMatch(/Rechnung|Factură|Facture/);
    expect(languageOf('de')).toBe('de');
    expect(languageOf('AT')).toBe('de');
    expect(languageOf('FR')).toBe('fr');
    expect(languageOf('RO')).toBe('ro');
    expect(languageOf('ES')).toBe('en');
  });

  it('shows what the law asks of an invoice that applies to this sale (Codul fiscal art. 319 alin. 20)', async () => {
    const text = spaced(await textOf(await renderInvoicePdf(doc())));
    // a) the number in a series, b) the date, d) the seller's name, address and tax id, f) the buyer's name and address, h) what was sold, i) the amount before VAT, j) the rate and the VAT.
    for (const shown of ['SPN-00042', '17.11.2026', 'Exemplu Software SRL', 'RO12345678', 'Strada Exemplului 1', 'București', 'Jonas Beispiel', 'Musterstraße 12', 'München', 'Spine Premium, jährlich', 'VAT 21%', '40,50']) expect(text).toContain(shown);
    // A company buyer's tax id is on it, and a private person is said to be one.
    expect(text).toContain('Private person');
    const company = spaced(await textOf(await renderInvoicePdf(doc({ buyer: { name: 'Muster GmbH', country: 'DE', taxId: 'DE123456789' } }))));
    expect(company).toContain('DE123456789');
    expect(company).not.toContain('Private person');
  });

  it('prints the seller’s bank and the diacritics of Romanian names', async () => {
    const text = spaced(await textOf(await renderInvoicePdf(doc({ buyer: { name: 'Ștefan Țurcanu', country: 'RO', city: 'Iași', street: 'Str. Ștefan cel Mare 3', county: 'IS' } }))));
    for (const shown of ['Banca Exemplu', 'RO49 AAAA 1B31 0075 9384 0000', 'Ștefan Țurcanu', 'Iași', 'București']) expect(text).toContain(shown);
  });

  it('states the rate and the VAT in lei where the invoice is in another currency, and not where it is in lei', async () => {
    const d = doc();
    const lei = Math.round(totalsOf(d).vatMinor * 4.975);
    const text = spaced(await textOf(await renderInvoicePdf(d)));
    expect(text).toContain('4,9750');
    expect(text).toContain(`${Math.floor(lei / 100)},${String(lei % 100).padStart(2, '0')} lei`);
    const ron = spaced(await textOf(await renderInvoicePdf(doc({ currency: 'RON', rate: undefined }))));
    expect(ron).not.toContain('National Bank of Romania rate');
  });

  it('says VAT is not charged where the seller does not charge it, instead of a rate of nought', async () => {
    const text = await textOf(await renderInvoicePdf(doc({ currency: 'RON', rate: undefined, lines: [{ name: 'Spine Premium', quantity: 1, netMinor: 4900, vatPercent: 0 }] })));
    expect(text).toContain('No VAT charged');
    expect(text).not.toContain('VAT 0%');
  });

  it('makes a credit note that names the invoice it reverses and says it was refunded, not paid', async () => {
    const text = await textOf(await renderInvoicePdf(doc({ kind: 'credit', id: 'SPN-00043', reverses: 'SPN-00042', note: 'Rambursare' })));
    expect(text).toContain('Credit note');
    expect(text).toContain('Gutschrift');
    expect(text).toContain('Reverses invoice / Storniert Rechnung SPN-00042');
    expect(text).toContain('Refunded to the payment method');
    expect(text).not.toContain('Paid by card on');
  });

  it('puts the e-Factura index in the footer once ANAF has the file, and the brand with whose trade name it is', async () => {
    const text = await textOf(await renderInvoicePdf(doc(), { efacturaIndex: '5012345678', brand: { name: 'Spine', site: 'spine.example' } }));
    expect(text).toContain('5012345678');
    expect(text).toContain('Spine is a trade name of Exemplu Software SRL');
    expect(await textOf(await renderInvoicePdf(doc()))).not.toContain('index');
  });

  it('goes on to a second page, with the head again, where the lines do not fit', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `Spine, line ${i + 1}`, quantity: 1, netMinor: 100, vatPercent: 21 }));
    const pdf = await renderInvoicePdf(doc({ lines: many }));
    const loaded = await getDocument({ data: new Uint8Array(pdf), isEvalSupported: false }).promise;
    expect(loaded.numPages).toBeGreaterThan(1);
    const text = await textOf(pdf);
    expect(text).toContain('Spine, line 40');
    expect(text.match(/Description/g)!.length).toBe(loaded.numPages);
  });
});

describe('the issuer’s PDF', () => {
  const stored = (input: UblDocument, over: Partial<StoredDocument> = {}): StoredDocument => ({
    draft_id: 'pay_1', kind: input.kind, series: 'SPN', number: 42, issue_date: input.issueDate, reverses: null, xml: buildUbl(input), input: JSON.stringify(input),
    anaf_index: null, anaf_state: null, anaf_message: null, signed: null, created_at: '2026-11-17T10:00:00Z', updated_at: '2026-11-17T10:00:00Z', ...over,
  });
  const issuerWith = (row: StoredDocument, fetcher: typeof fetch) => {
    const store = {
      efacturaReserve: async () => row, efacturaDocument: async () => row, efacturaUpdateDocument: async (_: string, __: DocumentPatch) => undefined, efacturaDocuments: async () => [row],
      efacturaTokens: async () => null, efacturaSaveTokens: async () => undefined, efacturaBeginAuthorisation: async () => undefined, efacturaFinishAuthorisation: async () => false,
    };
    const link = new AnafLink({ mode: 'test', clientId: 'id', clientSecret: 'secret', redirectUri: 'https://spine.example/cb', key: Buffer.alloc(32, 1), fetcher }, store);
    return efacturaIssuer({ seller: async () => SELLER, series: 'SPN', zeroVat: { category: 'O' }, pdfLink: id => `https://spine.example/pdf/${id}`, fetcher }, store, link);
  };

  it('is made with no request to ANAF, so a download does not depend on the Ministry’s service', async () => {
    const calls: string[] = [];
    const fetcher = (async (url: string) => { calls.push(String(url)); throw new Error('no network'); }) as unknown as typeof fetch;
    const pdf = await issuerWith(stored(doc()), fetcher).pdf('pay_1');
    expect(pdf.subarray(0, 4).toString('latin1')).toBe('%PDF');
    expect(calls).toEqual([]);
  });

  it('keeps the Ministry’s converter for the operator to compare, which does ask ANAF', async () => {
    const calls: string[] = [];
    const fetcher = (async (url: string) => { calls.push(String(url)); return new Response(Buffer.from('%PDF-1.4 anaf'), { status: 200 }); }) as unknown as typeof fetch;
    await issuerWith(stored(doc()), fetcher).pdfByAnaf('pay_1');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('webservicesp.anaf.ro');
  });
});
