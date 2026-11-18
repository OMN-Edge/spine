import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { wrap, type SheetLanguage } from './share-sheet';

/**
 * The documents of a chosen set as one PDF, for an insurer's claim portal or a doctor who wants files and not a link: a cover page that lists every document (date, provider, type, pages),
 * then each document's own pages in date order (the pages the owner set aside are not in it), and, where the owner asked, a summary page before a document in the reader's language, marked as
 * a machine translation. It is made on the device from the originals; nothing is sent anywhere, and no model is asked here (a summary is translated by the same route as on the page, only if asked).
 */
export interface ClaimDocument {
  title: string | null;
  doc_date: string | null;
  provider: string | null;
  doc_type: string | null;
  /** How many pages it has in the file (the visible ones). */
  pages: number;
  /** Its own pages as a PDF, or null where the original is not a PDF and cannot be included. */
  pdf: Uint8Array | null;
  /** A summary in the reader's language, to put before the document; null for none. */
  summary?: string | null;
}

interface Words { title: string; titleOf: string; made: string; none: string; count: string; page: string; pages: string; summary: string; machine: string; untitled: string; skipped: string }

const WORDS: Record<SheetLanguage, Words> = {
  en: { title: 'Medical documents', titleOf: 'Medical documents of {name}, {from} – {to}', made: 'Made {date} with Spine. The documents that follow are the originals.', none: 'No documents.', count: '{n} documents, {pages} pages', page: 'page', pages: 'pages', summary: 'Summary', machine: 'Machine translation by Spine. The original document is authoritative; this is not a certified translation.', untitled: 'Untitled document', skipped: 'original not included' },
  ro: { title: 'Documente medicale', titleOf: 'Documentele medicale ale lui {name}, {from} – {to}', made: 'Făcut la {date} cu Spine. Documentele care urmează sunt originalele.', none: 'Niciun document.', count: '{n} documente, {pages} pagini', page: 'pagină', pages: 'pagini', summary: 'Rezumat', machine: 'Traducere automată de Spine. Documentul original este cel care contează; aceasta nu este o traducere autorizată.', untitled: 'Document fără titlu', skipped: 'originalul nu este inclus' },
  fr: { title: 'Documents médicaux', titleOf: 'Documents médicaux de {name}, {from} – {to}', made: 'Établi le {date} avec Spine. Les documents qui suivent sont les originaux.', none: 'Aucun document.', count: '{n} documents, {pages} pages', page: 'page', pages: 'pages', summary: 'Résumé', machine: 'Traduction automatique par Spine. Le document original fait foi ; ce n’est pas une traduction certifiée.', untitled: 'Document sans titre', skipped: 'original non inclus' },
  de: { title: 'Medizinische Unterlagen', titleOf: 'Medizinische Unterlagen von {name}, {from} – {to}', made: 'Erstellt am {date} mit Spine. Die folgenden Dokumente sind die Originale.', none: 'Keine Dokumente.', count: '{n} Dokumente, {pages} Seiten', page: 'Seite', pages: 'Seiten', summary: 'Zusammenfassung', machine: 'Maschinelle Übersetzung durch Spine. Maßgeblich ist das Originaldokument; dies ist keine beglaubigte Übersetzung.', untitled: 'Dokument ohne Titel', skipped: 'Original nicht enthalten' },
};

const A4: [number, number] = [595.28, 841.89];
const M = 56;
const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ''));
const LOCALE: Record<SheetLanguage, string> = { en: 'en-GB', ro: 'ro-RO', fr: 'fr-FR', de: 'de-DE' };
const day = (iso: string, language: SheetLanguage) => new Intl.DateTimeFormat(LOCALE[language], language === 'en' ? { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' } : { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));

/** The documents in date order, the oldest first as a file is read; those with no date last. */
export const byDate = <T extends { doc_date: string | null }>(docs: T[]): T[] => [...docs].sort((a, b) => (a.doc_date ?? '9999').localeCompare(b.doc_date ?? '9999'));

export async function makeClaimPdf(input: { name?: string | null; language: SheetLanguage; documents: ClaimDocument[]; now?: Date }, fonts: { regular: ArrayBuffer | Uint8Array }): Promise<Uint8Array> {
  const w = WORDS[input.language];
  const docs = byDate(input.documents);
  const out = await PDFDocument.create();
  out.registerFontkit(fontkit);
  const face = await out.embedFont(fonts.regular, { subset: true });
  const ink = rgb(0.11, 0.1, 0.09), muted = rgb(0.47, 0.44, 0.42);
  const width = A4[0] - 2 * M;

  // The cover: the title, how many documents and pages, and one line for each document.
  let page: PDFPage = out.addPage(A4);
  let y = A4[1] - M;
  const write = (text: string, size: number, color = ink, gap = 4, indent = 0) => {
    for (const line of wrap(text, face, size, width - indent)) {
      if (y < M + 30) { page = out.addPage(A4); y = A4[1] - M; }
      y -= size * 1.3;
      if (line) page.drawText(line, { x: M + indent, y, size, font: face, color });
    }
    y -= gap;
  };
  const dates = docs.map(d => d.doc_date).filter((d): d is string => !!d);
  const from = dates[0], to = dates.at(-1);
  const heading = input.name && from && to ? fill(w.titleOf, { name: input.name, from: day(from, input.language), to: day(to, input.language) }) : input.name ? `${w.title}: ${input.name}` : w.title;
  write(heading, 20, ink, 8);
  write(fill(w.made, { date: day((input.now ?? new Date()).toISOString(), input.language) }), 10, muted, 4);
  write(docs.length === 0 ? w.none : fill(w.count, { n: docs.length, pages: docs.reduce((n, d) => n + d.pages, 0) }), 11, muted, 14);
  docs.forEach((d, i) => {
    const pagesText = `${d.pages} ${d.pages === 1 ? w.page : w.pages}`;
    const line = [`${i + 1}.`, d.doc_date ? day(d.doc_date, input.language) : '—', d.title?.trim() || w.untitled, d.provider, d.doc_type?.replace(/_/g, ' '), pagesText, d.pdf ? null : `(${w.skipped})`].filter(Boolean).join(' · ');
    write(line, 10.5, ink, 3);
  });

  // Each document: its summary page if there is one, then its own pages.
  const summaryPage = (d: ClaimDocument) => {
    page = out.addPage(A4);
    y = A4[1] - M;
    write(w.summary, 9, muted, 2);
    write(d.title?.trim() || w.untitled, 16, ink, 2);
    write([d.doc_date ? day(d.doc_date, input.language) : null, d.provider].filter(Boolean).join(' · '), 10.5, muted, 12);
    write(d.summary ?? '', 12, ink, 12);
    page.drawText(w.machine, { x: M, y: M - 8, size: 9, font: face as PDFFont, color: muted });
  };
  for (const d of docs) {
    if (d.summary) summaryPage(d);
    if (!d.pdf) continue;
    const source = await PDFDocument.load(d.pdf, { ignoreEncryption: true });
    for (const copied of await out.copyPages(source, source.getPageIndices())) out.addPage(copied);
  }
  return out.save();
}
