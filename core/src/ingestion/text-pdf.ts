import { createWriteStream } from 'fs';
import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';

const FONT = createRequire(import.meta.url).resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
/** What goes onto pages: about 300 of them. The rest of a longer text is left off rather than stopping the upload. */
const MAX_TEXT_CHARS = 900_000;

/**
 * Text on A4 pages in a font that has the accents of the languages Spine speaks (the standard PDF fonts have no ă, ș or ț),
 * as real text, so the PDF has the text layer the reader uses.
 */
export function textToPdf(text: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56, compress: true, info: { Producer: 'Spine', Creator: 'Spine' } });
    const out = createWriteStream(outPath);
    out.on('finish', resolve);
    out.on('error', reject);
    doc.on('error', reject);
    doc.pipe(out);
    doc.font(FONT).fontSize(11);
    doc.text(text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text, { lineGap: 2 });
    doc.end();
  });
}
