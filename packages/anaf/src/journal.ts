import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';
import { totalsOf, type UblDocument, type UblSeller } from './ubl.js';
import type { DocumentBrand } from './document.js';

/**
 * The month's invoices and credit notes in one document, for the accountant: a centralizer in the sense of OMFP 2634/2015, annex 1, point 20 ("o înregistrare ... pe baza unui centralizator
 * în care sunt înscrise mai multe documente justificative al căror conținut se referă la operațiuni de aceeași natură și din aceeași perioadă"). It does not replace the invoices, which stay
 * the supporting documents; it lists them, with what point 10 asks of an accounting document that sums up others: the entity's name, the date it was drawn up, the kind, number and
 * date of each supporting document, the amounts, and the signature of the person who drew it up (a line for it). The accounts (conturile sintetice și analitice) are the accountant's to
 * add. Made from the same stored documents the XML and the PDF of each invoice are, so the three cannot disagree. It names nothing of Spine's (S15).
 */
export interface JournalRow {
  kind: 'invoice' | 'credit';
  /** As printed ("SPN-00012"). */
  number: string;
  /** The issue date, `YYYY-MM-DD`. */
  date: string;
  buyer: string;
  country: string;
  /** The buyer's tax id, or what stands for a person who gave none. */
  taxId: string;
  currency: string;
  /** Negative for a credit note. */
  netMinor: number;
  vatMinor: number;
  grossMinor: number;
  /** RON for one unit of the currency on the issue day; null for an invoice in RON (1) is left as 1, and for one whose rate could not be found. */
  rate: number | null;
  /** The total in bani, from the rate, a half rounded away from zero so a credit note is the exact negative of what the same amount would be; null where there is none. */
  ronMinor: number | null;
  /** For a credit note, the number of the invoice it reverses. */
  reverses: string | null;
  /** The payment's reference at the provider, where the document names it. */
  reference: string | null;
  /** What ANAF has said of the document where the issuer sends it (`ok`, `sent`, `nok`, `abroad`), else null. */
  anaf: string | null;
}

export interface Journal {
  /** `YYYY-MM`. */
  month: string;
  seller: Pick<UblSeller, 'name' | 'cif' | 'vatId' | 'registerNo' | 'street' | 'city' | 'postalCode'>;
  /** The day it was drawn up, `YYYY-MM-DD`. */
  preparedOn: string;
  rows: JournalRow[];
}

/** What a person who gave no tax number is written as: the thirteen zeros the invoice carries for a buyer in Romania; nothing abroad. */
const NO_ID = '0000000000000';

/** A row from a stored document: the amounts with the sign of its kind. `rate` is what the caller found for the document's day. */
export function journalRowOf(doc: UblDocument, extra: { rate: number | null; anaf?: string | null; reference?: string | null }): JournalRow {
  const t = totalsOf(doc);
  const sign = doc.kind === 'credit' ? -1 : 1;
  const gross = sign * t.grossMinor;
  const rate = doc.currency.toUpperCase() === 'RON' ? 1 : extra.rate;
  const taxId = doc.buyer.taxId ?? (doc.buyer.country.toUpperCase() === 'RO' ? (doc.buyer.personalId ?? NO_ID) : '');
  const reference = extra.reference ?? /^Payment (\S+)$/.exec(doc.note ?? '')?.[1] ?? null;
  return {
    kind: doc.kind === 'credit' ? 'credit' : 'invoice', number: doc.id, date: doc.issueDate, buyer: doc.buyer.name, country: doc.buyer.country.toUpperCase(), taxId,
    currency: doc.currency.toUpperCase(), netMinor: sign * t.netMinor, vatMinor: sign * t.vatMinor, grossMinor: gross,
    rate, ronMinor: rate === null ? null : Math.sign(gross) * Math.round(Math.abs(gross) * rate), reverses: doc.reverses ?? null, reference, anaf: extra.anaf ?? null,
  };
}

/** The sums of a journal for each currency, and in lei where every row has its rate. */
export function journalTotals(rows: JournalRow[]): { currency: string; invoices: number; credits: number; netMinor: number; vatMinor: number; grossMinor: number; ronMinor: number | null }[] {
  const by = new Map<string, { currency: string; invoices: number; credits: number; netMinor: number; vatMinor: number; grossMinor: number; ronMinor: number | null }>();
  for (const r of rows) {
    const t = by.get(r.currency) ?? { currency: r.currency, invoices: 0, credits: 0, netMinor: 0, vatMinor: 0, grossMinor: 0, ronMinor: 0 };
    if (r.kind === 'credit') t.credits++; else t.invoices++;
    t.netMinor += r.netMinor; t.vatMinor += r.vatMinor; t.grossMinor += r.grossMinor;
    t.ronMinor = t.ronMinor === null || r.ronMinor === null ? null : t.ronMinor + r.ronMinor;
    by.set(r.currency, t);
  }
  return [...by.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

/** An amount in a spreadsheet's Romanian way: a comma before two decimals and no grouping, so it is read as a number. */
const plain = (minor: number): string => `${minor < 0 ? '-' : ''}${Math.floor(Math.abs(minor) / 100)},${String(Math.abs(minor) % 100).padStart(2, '0')}`;
/** An amount to read: thousands apart by a space. */
const spaced = (minor: number): string => plain(minor).replace(/\B(?=(\d{3})+(?!\d),)/g, ' ');
const dotted = (iso: string): string => iso.split('-').reverse().join('.');

/**
 * A text cell that a spreadsheet will not run: a name that begins with `=`, `+`, `-`, `@`, a tab or a return is read as a formula by Excel and Calc, and a buyer writes their own
 * name, so a single quote is put before it; a field with the separator, a quote or a line break is quoted.
 */
export function csvText(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[;"\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

const HEADER = ['Tip', 'Număr', 'Data', 'Client', 'Țară', 'CUI/CNP', 'Valută', 'Valoare fără TVA', 'TVA', 'Total', 'Curs BNR', 'Total în lei', 'Anulează factura', 'Referință plată', 'Stare ANAF'];
const KIND = { invoice: 'Factură', credit: 'Notă de credit' } as const;
const STATE: Record<string, string> = { ok: 'acceptată', sent: 'trimisă', nok: 'refuzată', abroad: 'cumpărător în afara României' };

/**
 * The journal as a file a spreadsheet opens: separated by `;` and with a comma for decimals (how Excel in Romanian reads it), UTF-8 with a mark so the diacritics survive, one line
 * for each invoice or credit note in date order, the amounts of a credit note negative, no total lines (they are in the PDF, and a total line would be read as a document on import).
 */
export function journalCsv(journal: Journal): string {
  const lines = [HEADER.join(';')];
  for (const r of journal.rows) {
    lines.push([
      KIND[r.kind], r.number, dotted(r.date), csvText(r.buyer), r.country, csvText(r.taxId), r.currency, plain(r.netMinor), plain(r.vatMinor), plain(r.grossMinor),
      r.rate === null ? '' : r.rate.toFixed(4).replace('.', ','), r.ronMinor === null ? '' : plain(r.ronMinor), csvText(r.reverses ?? ''), csvText(r.reference ?? ''), r.anaf ? (STATE[r.anaf] ?? r.anaf) : '',
    ].join(';'));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

const FONT = createRequire(import.meta.url).resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
const BOLD = createRequire(import.meta.url).resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf');
const INK = '#1c1917';
const MUTED = '#78716c';
const RULE = '#e7e5e4';
const TINT = '#f0fdfa';
const PAGE = { w: 841.89, h: 595.28, margin: 36 };

/** The month's name in Romanian ("noiembrie 2026"). */
export const monthName = (month: string): string => new Intl.DateTimeFormat('ro-RO', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`));

/** The journal as an A4 page in landscape, in Romanian (the accountant's language and the law's): the entity, the month, one line for each document, the totals and a line to sign. */
export function renderJournalPdf(journal: Journal, options: { brand?: DocumentBrand } = {}): Promise<Buffer> {
  const color = options.brand?.color ?? '#0f766e';
  const s = journal.seller;
  const pdf = new PDFDocument({ size: [PAGE.w, PAGE.h], margin: 0, bufferPages: true, info: { Title: `Centralizator facturi emise ${journal.month}`, Author: s.name } });
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
  // Columns: the shares of the width, left or right aligned.
  const cols: Array<{ title: string; share: number; right?: boolean }> = [
    { title: 'Nr.', share: 0.04 }, { title: 'Data', share: 0.08 }, { title: 'Document', share: 0.15 }, { title: 'Client', share: 0.27 }, { title: 'Valută', share: 0.06 },
    { title: 'Fără TVA', share: 0.1, right: true }, { title: 'TVA', share: 0.08, right: true }, { title: 'Total', share: 0.1, right: true }, { title: 'Total în lei', share: 0.12, right: true },
  ];
  const widths = cols.map(c => c.share * W);
  /** A cell cut short, with an ellipsis, so that it stays on its line (the buyer's name is long, and a line that wraps would run into the next). */
  const fit = (text: string, width: number): string => {
    pdf.font('r').fontSize(7.5);
    if (pdf.widthOfString(text) <= width) return text;
    let cut = text;
    while (cut.length > 1 && pdf.widthOfString(`${cut}…`) > width) cut = cut.slice(0, -1);
    return `${cut}…`;
  };
  const header = (y: number): number => {
    pdf.rect(X, y, W, 18).fill(TINT);
    let x = X;
    cols.forEach((c, i) => { pdf.font('b').fontSize(7.5).fillColor(INK).text(c.title, x + 4, y + 5, { width: widths[i]! - 8, align: c.right ? 'right' : 'left', lineBreak: false }); x += widths[i]!; });
    return y + 22;
  };

  pdf.font('b').fontSize(16).fillColor(INK).text('Centralizator facturi emise', X, 34, { lineBreak: false });
  pdf.font('r').fontSize(10).fillColor(MUTED).text(`Luna ${monthName(journal.month)}`, X, 56, { lineBreak: false });
  pdf.font('b').fontSize(10).fillColor(color).text(s.name, X, 34, { width: W, align: 'right', lineBreak: false });
  pdf.font('r').fontSize(8).fillColor(MUTED).text([s.vatId ?? `CIF ${s.cif}`, s.registerNo, `${s.street}, ${s.postalCode} ${s.city}`].filter(Boolean).join(' · '), X, 50, { width: W, align: 'right', lineBreak: false });
  pdf.font('r').fontSize(7.5).fillColor(MUTED).text('Întocmit potrivit OMFP 2634/2015, anexa 1, pct. 10 și 20: listează documentele justificative (facturi și note de credit) ale lunii; nu le înlocuiește.', X, 74, { width: W, lineBreak: false });

  let y = header(94);
  const rowsLimit = PAGE.h - 60;
  journal.rows.forEach((r, n) => {
    if (y > rowsLimit) { pdf.addPage({ size: [PAGE.w, PAGE.h], margin: 0 }); y = header(36); }
    const cells = [
      String(n + 1), dotted(r.date), `${KIND[r.kind]} ${r.number}${r.reverses ? ` (storno ${r.reverses})` : ''}`, `${r.buyer} · ${r.country}${r.taxId ? ` · ${r.taxId}` : ''}`, r.currency,
      spaced(r.netMinor), spaced(r.vatMinor), spaced(r.grossMinor), r.ronMinor === null ? '—' : spaced(r.ronMinor),
    ];
    let x = X;
    cells.forEach((cell, i) => { pdf.font('r').fontSize(7.5).fillColor(INK).text(fit(cell, widths[i]! - 8), x + 4, y, { width: widths[i]! - 8, align: cols[i]!.right ? 'right' : 'left', lineBreak: false }); x += widths[i]!; });
    pdf.moveTo(X, y + 13).lineTo(X + W, y + 13).lineWidth(0.4).strokeColor(RULE).stroke();
    y += 16;
  });
  if (journal.rows.length === 0) { pdf.font('r').fontSize(9).fillColor(MUTED).text('Nicio factură sau notă de credit în această lună.', X + 4, y, { lineBreak: false }); y += 20; }

  // The totals, for each currency, and the place to sign.
  if (y > PAGE.h - 130) { pdf.addPage({ size: [PAGE.w, PAGE.h], margin: 0 }); y = 36; }
  y += 8;
  pdf.font('b').fontSize(8.5).fillColor(INK).text('Totaluri', X, y, { lineBreak: false });
  y += 16;
  for (const t of journalTotals(journal.rows)) {
    pdf.font('r').fontSize(8).fillColor(INK).text(`${t.currency}: ${t.invoices} facturi, ${t.credits} note de credit · fără TVA ${spaced(t.netMinor)} · TVA ${spaced(t.vatMinor)} · total ${spaced(t.grossMinor)}${t.ronMinor === null ? '' : ` · în lei ${spaced(t.ronMinor)}`}`, X, y, { lineBreak: false });
    y += 13;
  }
  y += 14;
  pdf.font('r').fontSize(8).fillColor(MUTED).text(`Întocmit la ${dotted(journal.preparedOn)}`, X, y, { lineBreak: false });
  pdf.moveTo(X + 300, y + 10).lineTo(X + 520, y + 10).lineWidth(0.5).strokeColor(MUTED).stroke();
  pdf.font('r').fontSize(7).fillColor(MUTED).text('Numele și semnătura persoanei responsabile cu întocmirea', X + 300, y + 14, { lineBreak: false });
  pdf.end();
  return done;
}
