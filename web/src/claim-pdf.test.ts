import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { byDate, makeClaimPdf, type ClaimDocument } from './claim-pdf';

/** The file export for an insurer (T-25): the set's documents only, in date order, with a cover that lists every one. */
const font = readFileSync(createRequire(import.meta.url).resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf'));
async function original(label: string, pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 1; i <= pages; i++) doc.addPage([300, 400]).drawText(`${label} page ${i}`, { x: 20, y: 200, size: 14 });
  return doc.save();
}
const textOfPage = async (pdf: Uint8Array, n: number) => (await (await (await getDocument({ data: new Uint8Array(pdf) }).promise).getPage(n)).getTextContent()).items.map(i => ('str' in i ? i.str : '')).join(' ');
const info = async (pdf: Uint8Array) => { const d = await getDocument({ data: new Uint8Array(pdf) }).promise; const all: string[] = []; for (let i = 1; i <= d.numPages; i++) all.push(await textOfPage(pdf, i)); return { pages: d.numPages, all }; };

describe('the claim PDF', () => {
  const docs = async (): Promise<ClaimDocument[]> => [
    { title: 'Control visit', doc_date: '2026-06-20', provider: 'Clinica Exemplu', doc_type: 'consultation_note', pages: 2, pdf: await original('CONTROL', 2) },
    { title: 'Thyroid tests', doc_date: '2026-03-04', provider: 'Laborator Exemplu', doc_type: 'lab_result', pages: 1, pdf: await original('LAB', 1) },
    { title: 'Letter from abroad', doc_date: null, provider: null, doc_type: null, pages: 1, pdf: null },
  ];

  it('is a cover that lists every document, then exactly the pages of the documents that have an original, oldest first', async () => {
    const pdf = await makeClaimPdf({ name: 'Ana Exemplu', language: 'en', documents: await docs(), now: new Date('2026-11-18T10:00:00Z') }, { regular: font });
    const { pages, all } = await info(pdf);
    expect(pages).toBe(1 + 1 + 2);
    const cover = all[0]!;
    for (const shown of ['Medical documents of Ana Exemplu, 4 Mar 2026 – 20 Jun 2026', 'Made 18 Nov 2026', '3 documents, 4 pages', 'Thyroid tests', 'Control visit', 'Letter from abroad', 'original not included']) expect(cover).toContain(shown);
    expect(cover.indexOf('Thyroid tests')).toBeLessThan(cover.indexOf('Control visit'));
    expect(all.slice(1).join(' ')).toMatch(/LAB page 1.*CONTROL page 1.*CONTROL page 2/);
  });

  it('holds only the documents it is given, and an empty set is an empty cover, not a failure', async () => {
    const { pages, all } = await info(await makeClaimPdf({ language: 'en', documents: [] }, { regular: font }));
    expect(pages).toBe(1);
    expect(all[0]).toContain('No documents.');
  });

  it('puts a summary page before a document where it is asked for, marked as a machine translation, and none where it is not', async () => {
    const withSummary = await docs();
    withSummary[1]!.summary = 'Hormonanalyse: TSH erhöht.';
    const { pages, all } = await info(await makeClaimPdf({ language: 'de', documents: withSummary }, { regular: font }));
    expect(pages).toBe(1 + 1 + 1 + 2);
    expect(all[1]).toContain('Zusammenfassung');
    expect(all[1]).toContain('Hormonanalyse: TSH erhöht.');
    expect(all[1]).toContain('Maschinelle Übersetzung durch Spine');
    expect(all[1]).toContain('keine beglaubigte Übersetzung');
    expect(all.filter(p => p.includes('Maschinelle Übersetzung'))).toHaveLength(1);
  });

  it('is in the language asked for, with its accents', async () => {
    const { all } = await info(await makeClaimPdf({ name: 'Ștefan Țurcanu', language: 'ro', documents: await docs() }, { regular: font }));
    expect(all[0]).toContain('Documentele medicale ale lui Ștefan Țurcanu');
  });

  it('sorts by date with the undated last', () => {
    expect(byDate([{ doc_date: null }, { doc_date: '2026-05-01' }, { doc_date: '2025-01-01' }]).map(d => d.doc_date)).toEqual(['2025-01-01', '2026-05-01', null]);
  });
});
