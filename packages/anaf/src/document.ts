import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';
import { noteOf, totalsOf, type UblDocument } from './ubl.js';

/**
 * The invoice as a person reads it: an A4 page made from the same stored document the XML is written from (`UblDocument`), so the two cannot disagree, and with no
 * service between it and the buyer (the Ministry's converter is Romanian only, and needs to be up). The labels are English with the buyer's language beneath, in one
 * language where the buyer's is English. The values are never translated. It names nothing of Spine's (S15): the brand's name, site and mark are given by the caller.
 * What it shows is what the law asks of an invoice (Codul fiscal art. 319 alin. (20)) as far as it applies to a sale like this one: the number in a series and the
 * date, the seller's name, address and tax id, the buyer's name and address (and tax id for a company), what was sold with the amount before VAT, the VAT rate and the
 * VAT, in lei too where the invoice is in another currency, and for a credit note the invoice it reverses.
 */
export type DocumentLanguage = 'en' | 'ro' | 'fr' | 'de';

export interface DocumentBrand {
  name: string;
  site?: string;
  /** The path data of a mark drawn in a 32 by 32 box. */
  mark?: string[];
  /** The mark's and the number's colour. */
  color?: string;
}

export interface DocumentOptions {
  /** The language beneath the English; English alone for "en". */
  language?: DocumentLanguage;
  brand?: DocumentBrand;
  /** ANAF's upload index, once it has the file. */
  efacturaIndex?: string | null;
}

/** The language of the buyer's country: Romanian, French or German where it is one of those countries', else English. */
export function languageOf(country: string): DocumentLanguage {
  const c = country.toUpperCase();
  if (c === 'RO' || c === 'MD') return 'ro';
  if (c === 'FR' || c === 'BE' || c === 'LU') return 'fr';
  if (c === 'DE' || c === 'AT' || c === 'CH' || c === 'LI') return 'de';
  return 'en';
}

const LABELS = {
  en: { noVat: 'No VAT charged', unsigned: 'Valid without stamp or signature (Fiscal Code art. 319 para. (29))', invoice: 'Invoice', credit: 'Credit note', issued: 'Issue date', currency: 'Currency', payment: 'Payment', card: 'Card', seller: 'Seller', buyer: 'Buyer', cif: 'Tax ID', reg: 'Trade reg. no.', bank: 'Bank', iban: 'IBAN', person: 'Private person', item: 'Description', qty: 'Qty', unit: 'Unit price excl. VAT', net: 'Amount excl. VAT', vat: 'VAT', subtotal: 'Total excl. VAT', total: 'Total', paid: 'Paid by card on', refunded: 'Refunded to the payment method', due: 'Amount due', rate: 'National Bank of Romania rate', vatLei: 'VAT in lei', reverses: 'Reverses invoice', efactura: 'Sent to the RO e-Factura system, index', tradeName: 'is a trade name of' },
  ro: { noVat: 'Fără TVA', unsigned: 'Factură valabilă fără ștampilă și semnătură (Codul fiscal art. 319 alin. (29))', invoice: 'Factură', credit: 'Factură storno', issued: 'Data emiterii', currency: 'Moneda', payment: 'Plata', card: 'Card', seller: 'Furnizor', buyer: 'Cumpărător', cif: 'CIF', reg: 'Nr. Reg. Com.', bank: 'Banca', iban: 'IBAN', person: 'Persoană fizică', item: 'Denumire', qty: 'Cant.', unit: 'Preț unitar fără TVA', net: 'Valoare fără TVA', vat: 'TVA', subtotal: 'Total fără TVA', total: 'Total', paid: 'Achitată cu cardul la', refunded: 'Rambursat pe metoda de plată', due: 'Rest de plată', rate: 'Cursul BNR', vatLei: 'TVA în lei', reverses: 'Stornează factura', efactura: 'Transmisă în sistemul RO e-Factura, index', tradeName: 'este o denumire comercială a' },
  fr: { noVat: 'Sans TVA', unsigned: 'Valable sans cachet ni signature (Code fiscal art. 319 al. (29))', invoice: 'Facture', credit: 'Avoir', issued: 'Date d’émission', currency: 'Devise', payment: 'Paiement', card: 'Carte', seller: 'Vendeur', buyer: 'Acheteur', cif: 'N° fiscal', reg: 'N° registre du commerce', bank: 'Banque', iban: 'IBAN', person: 'Particulier', item: 'Désignation', qty: 'Qté', unit: 'Prix unitaire HT', net: 'Montant HT', vat: 'TVA', subtotal: 'Total HT', total: 'Total', paid: 'Payée par carte le', refunded: 'Remboursé sur le moyen de paiement', due: 'Reste à payer', rate: 'Cours de la Banque nationale de Roumanie', vatLei: 'TVA en lei', reverses: 'Annule la facture', efactura: 'Transmise au système RO e-Factura, index', tradeName: 'est un nom commercial de' },
  de: { noVat: 'Ohne MwSt.', unsigned: 'Gültig ohne Stempel und Unterschrift (Steuergesetzbuch Art. 319 Abs. (29))', invoice: 'Rechnung', credit: 'Gutschrift', issued: 'Rechnungsdatum', currency: 'Währung', payment: 'Zahlung', card: 'Karte', seller: 'Verkäufer', buyer: 'Käufer', cif: 'Steuer-Nr.', reg: 'Handelsreg.-Nr.', bank: 'Bank', iban: 'IBAN', person: 'Privatperson', item: 'Bezeichnung', qty: 'Menge', unit: 'Einzelpreis netto', net: 'Betrag netto', vat: 'MwSt.', subtotal: 'Summe netto', total: 'Gesamt', paid: 'Mit Karte bezahlt am', refunded: 'Auf die Zahlungsart erstattet', due: 'Offener Betrag', rate: 'Kurs der Rumänischen Nationalbank', vatLei: 'MwSt. in Lei', reverses: 'Storniert Rechnung', efactura: 'An das System RO e-Factura übermittelt, Index', tradeName: 'ist ein Handelsname von' },
} as const;
type Labels = (typeof LABELS)['en'];

const INK = '#1c1917';
const MUTED = '#78716c';
const RULE = '#e7e5e4';
const TINT = '#f0fdfa';
const PAGE = { w: 595.28, h: 841.89, margin: 48 };

const FONT = createRequire(import.meta.url).resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
const BOLD = createRequire(import.meta.url).resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf');

/** An amount as the buyer's page writes it: thousands apart by a space, two decimals after a comma. */
const amount = (minor: number): string => {
  const abs = Math.abs(minor);
  return `${minor < 0 ? '-' : ''}${String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${String(abs % 100).padStart(2, '0')}`;
};
const day = (iso: string): string => iso.split('-').reverse().join('.');

export function renderInvoicePdf(doc: UblDocument, options: DocumentOptions = {}): Promise<Buffer> {
  const language = options.language ?? languageOf(doc.buyer.country);
  const one = LABELS.en;
  const two = language === 'en' ? null : LABELS[language];
  const color = options.brand?.color ?? '#0f766e';
  const credit = doc.kind === 'credit';
  const t = totalsOf(doc);
  const s = doc.seller;
  const b = doc.buyer;

  const pdf = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: { Title: `${credit ? one.credit : one.invoice} ${doc.id}`, Author: s.name } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on('data', (c: Buffer) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
  });
  pdf.registerFont('r', FONT);
  pdf.registerFont('b', BOLD);

  const X = PAGE.margin;
  const W = PAGE.w - 2 * PAGE.margin;
  /** A label in English, the buyer's language beneath it in the muted colour (nothing beneath where it is English). */
  const label = (key: keyof Labels, x: number, y: number, width: number, opts: { size?: number; align?: 'left' | 'right' } = {}): void => {
    const size = opts.size ?? 7;
    pdf.font('b').fontSize(size).fillColor(INK).text(one[key], x, y, { width, align: opts.align, lineBreak: false });
    if (two) pdf.font('r').fontSize(size - 0.5).fillColor(MUTED).text(two[key], x, y + size + 2, { width, align: opts.align, lineBreak: false });
  };
  const both = (key: keyof Labels): string => (two ? `${one[key]} / ${two[key]}` : one[key]);

  // The header: the brand on the left, the kind of document and its number on the right.
  const brand = options.brand;
  if (brand?.mark) {
    pdf.save().translate(X, 44).scale(1.15);
    for (const d of brand.mark) pdf.path(d).fill(color);
    pdf.restore();
  }
  const bx = brand?.mark ? X + 44 : X;
  if (brand) {
    pdf.font('b').fontSize(20).fillColor(INK).text(brand.name, bx, 50, { lineBreak: false });
    if (brand.site) pdf.font('r').fontSize(7.5).fillColor(MUTED).text(brand.site, bx, 74, { lineBreak: false });
  }
  const kind = credit ? 'credit' : 'invoice';
  pdf.font('b').fontSize(22).fillColor(INK).text(one[kind], X, 44, { width: W, align: 'right', lineBreak: false });
  let numberY = 72;
  if (two) {
    pdf.font('r').fontSize(11).fillColor(MUTED).text(two[kind], X, 70, { width: W, align: 'right', lineBreak: false });
    numberY = 88;
  }
  pdf.font('b').fontSize(11).fillColor(color).text(doc.id, X, numberY, { width: W, align: 'right', lineBreak: false });

  // The facts strip.
  let y = 124;
  pdf.rect(X, y, W, 44).fill(TINT);
  const facts: Array<[string, string, number]> = [
    [both('issued'), day(doc.issueDate), 0.3],
    [both('currency'), doc.currency, 0.2],
    [both('payment'), two ? `${one.card} / ${two.card}` : one.card, 0.5],
  ];
  let fx = X + 12;
  for (const [k, v, share] of facts) {
    const fw = W * share - 12;
    pdf.font('r').fontSize(6.5).fillColor(MUTED).text(k, fx, y + 9, { width: fw, lineBreak: false });
    pdf.font('b').fontSize(9).fillColor(INK).text(v, fx, y + 24, { width: fw, lineBreak: false });
    fx += W * share;
  }

  // The seller and the buyer.
  y = 190;
  const party = (x: number, heading: string, lines: string[]): number => {
    pdf.font('b').fontSize(7).fillColor(color).text(heading.toUpperCase(), x, y, { characterSpacing: 0.6, lineBreak: false });
    pdf.font('b').fontSize(10).fillColor(INK).text(lines[0]!, x, y + 14, { width: W / 2 - 20 });
    pdf.font('r').fontSize(8).fillColor(INK);
    let ly = y + 30;
    for (const l of lines.slice(1)) {
      pdf.text(l, x, ly, { width: W / 2 - 20 });
      ly += pdf.heightOfString(l, { width: W / 2 - 20 }) + 3;
    }
    return ly;
  };
  // Every account the company banks with; the single bank and IBAN of an older settings stand as the one.
  const accounts = s.accounts ?? (s.iban ? [{ iban: s.iban, ...(s.bank ? { bank: s.bank } : {}) }] : []);
  const sellerLines = [
    s.name,
    `${both('cif')}: ${s.vatId ?? s.cif}`,
    ...(s.registerNo ? [`${both('reg')}: ${s.registerNo}`] : []),
    s.street,
    `${[s.city, s.postalCode, s.county ? `RO-${s.county}` : '', 'România'].filter(Boolean).join(', ')}`,
    ...accounts.flatMap(a => [`${one.iban}: ${a.iban}${a.currency ? ` (${a.currency})` : ''}`, ...(a.bank || a.bic ? [[a.bank, a.bic ? `BIC ${a.bic}` : ''].filter(Boolean).join(' · ')] : [])]),
    ...(s.email ? [s.email] : []),
    ...(s.phone ? [s.phone] : []),
  ];
  const place = [b.city, b.country.toUpperCase() === 'RO' && b.county ? `RO-${b.county}` : '', b.postalCode].filter(Boolean).join(', ');
  const buyerLines = [
    b.name,
    ...(b.taxId ? [`${both('cif')}: ${b.taxId}`] : [two ? `${one.person} / ${two.person}` : one.person]),
    ...(b.street ? [b.street] : []),
    ...(place || b.country ? [[place, b.country.toUpperCase()].filter(Boolean).join(', ')] : []),
    ...(b.email ? [b.email] : []),
  ];
  const endSeller = party(X, both('seller'), sellerLines);
  const endBuyer = party(X + W / 2 + 10, both('buyer'), buyerLines);
  y = Math.max(endSeller, endBuyer) + 22;

  // The lines, on as many pages as they need, the head repeated.
  const cols = [
    { key: 'item' as const, x: X, w: 200, align: 'left' as const },
    { key: 'qty' as const, x: X + 205, w: 40, align: 'right' as const },
    { key: 'unit' as const, x: X + 250, w: 80, align: 'right' as const },
    { key: 'net' as const, x: X + 335, w: 70, align: 'right' as const },
    { key: 'vat' as const, x: X + 410, w: W - 410, align: 'right' as const },
  ];
  const head = (): void => {
    for (const c of cols) label(c.key, c.x, y, c.w, { align: c.align });
    pdf.moveTo(X, y + 26).lineTo(X + W, y + 26).lineWidth(0.8).strokeColor(INK).stroke();
    y += 36;
  };
  head();
  const bottom = PAGE.h - 150;
  for (const line of doc.lines) {
    if (y > bottom) { pdf.addPage(); y = 60; head(); }
    const vat = Math.round((line.netMinor * line.vatPercent) / 100);
    pdf.font('b').fontSize(9).fillColor(INK).text(line.name, cols[0]!.x, y, { width: cols[0]!.w });
    pdf.font('r').fontSize(9).fillColor(INK);
    pdf.text(String(line.quantity), cols[1]!.x, y, { width: cols[1]!.w, align: 'right', lineBreak: false });
    pdf.text(amount(Math.round(line.netMinor / line.quantity)), cols[2]!.x, y, { width: cols[2]!.w, align: 'right', lineBreak: false });
    pdf.text(amount(line.netMinor), cols[3]!.x, y, { width: cols[3]!.w, align: 'right', lineBreak: false });
    pdf.text(amount(vat), cols[4]!.x, y, { width: cols[4]!.w, align: 'right', lineBreak: false });
    y += Math.max(pdf.heightOfString(line.name, { width: cols[0]!.w }), 12) + 12;
    pdf.moveTo(X, y - 6).lineTo(X + W, y - 6).lineWidth(0.4).strokeColor(RULE).stroke();
  }

  // The totals: by rate, then the whole, then what became of the payment.
  if (y > bottom - 120) { pdf.addPage(); y = 60; }
  y += 8;
  const tx = X + W - 230;
  const row = (key: keyof Labels, text: string, value: string, strong = false): void => {
    pdf.font(strong ? 'b' : 'r').fontSize(strong ? 10 : 8.5).fillColor(INK).text(text, tx, y, { width: 130, lineBreak: false });
    if (two) pdf.font('r').fontSize(7).fillColor(MUTED).text(two[key], tx, y + (strong ? 12 : 10.5), { width: 130, lineBreak: false });
    pdf.font(strong ? 'b' : 'r').fontSize(strong ? 11 : 9).fillColor(INK).text(`${value} ${doc.currency}`, tx + 100, y, { width: 130, align: 'right', lineBreak: false });
    y += (two ? 26 : 16) + (strong ? 4 : 0);
  };
  row('subtotal', one.subtotal, amount(t.netMinor));
  for (const g of t.groups) row(g.percent === null ? 'noVat' : 'vat', g.percent === null ? one.noVat : `${one.vat} ${g.percent}%`, amount(g.vatMinor));
  pdf.moveTo(tx, y - 4).lineTo(X + W, y - 4).lineWidth(0.8).strokeColor(INK).stroke();
  y += 4;
  row('total', one.total, amount(t.grossMinor), true);
  if (doc.paid) {
    pdf.roundedRect(tx, y - 2, 230, two ? 46 : 32, 4).fill(TINT);
    const key = credit ? 'refunded' : 'paid';
    const when = credit ? '' : ` ${day(doc.issueDate)}`;
    pdf.font('b').fontSize(8.5).fillColor(color).text(`${one[key]}${when}`, tx + 10, y + 5, { width: 210, lineBreak: false });
    if (two) pdf.font('r').fontSize(7.5).fillColor(color).text(`${two[key]}${when}`, tx + 10, y + 18, { width: 210, lineBreak: false });
    pdf.font('r').fontSize(7.5).fillColor(color).text(`${both('due')}: ${amount(0)} ${doc.currency}`, tx + 10, y + (two ? 29 : 18), { width: 210, lineBreak: false });
    y += two ? 58 : 44;
  }
  // BR-RO-030: where the invoice is in another currency, the VAT is also stated in lei, at the National Bank's rate of the day.
  if (doc.currency.toUpperCase() !== 'RON' && doc.rate && t.vatMinor > 0) {
    const rate = doc.rate.toFixed(4).replace('.', ',');
    pdf.font('r').fontSize(7.5).fillColor(MUTED);
    pdf.text(`${both('rate')} ${day(doc.issueDate)}: 1 ${doc.currency} = ${rate} lei`, X, y, { width: W, align: 'right', lineBreak: false });
    pdf.text(`${both('vatLei')}: ${amount(Math.round(t.vatMinor * doc.rate))} lei`, X, y + 11, { width: W, align: 'right', lineBreak: false });
    y += 28;
  }
  if (credit && doc.reverses) {
    pdf.font('b').fontSize(8.5).fillColor(INK).text(`${both('reverses')} ${doc.reverses}`, X, y, { width: W, lineBreak: false });
    y += 14;
  }
  if (noteOf(doc)) pdf.font('r').fontSize(8).fillColor(MUTED).text(noteOf(doc)!, X, y, { width: W });

  // The footer on every page: whose trade name it is, ANAF's index, the company line.
  const pages = pdf.bufferedPageRange();
  for (let i = pages.start; i < pages.start + pages.count; i++) {
    pdf.switchToPage(i);
    const fy = PAGE.h - 70;
    pdf.moveTo(X, fy).lineTo(X + W, fy).lineWidth(0.4).strokeColor(RULE).stroke();
    const foot: string[] = [];
    foot.push(one.unsigned);
    if (two) foot.push(two.unsigned);
    if (brand && brand.name !== s.name) foot.push(`${brand.name} ${one.tradeName} ${s.name}${two ? ` · ${two.tradeName} ${s.name}` : ''}`);
    if (options.efacturaIndex) foot.push(`${both('efactura')} ${options.efacturaIndex}`);
    foot.push([s.name, `${one.cif} ${s.vatId ?? s.cif}`, s.registerNo, `${s.street}, ${s.city}`, s.email].filter(Boolean).join(' · '));
    pdf.font('r').fontSize(7).fillColor(MUTED);
    foot.forEach((l, n) => pdf.text(l, X, fy + 10 + n * 11, { width: W, align: 'center', lineBreak: false }));
    if (pages.count > 1) pdf.text(`${i + 1} / ${pages.count}`, X, PAGE.h - 24, { width: W, align: 'right', lineBreak: false });
  }
  pdf.end();
  return done;
}
