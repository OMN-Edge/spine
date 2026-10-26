import fs from '../shims/fs';
import { PDFDocument, rgb, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

/**
 * Same contract as core/src/ingestion/text-pdf.ts: text on A4 pages in a font that has the accents of the languages Spine speaks, as
 * real text, so the PDF has the text layer the reader uses. DejaVu Sans is served from this origin.
 */
const MAX_TEXT_CHARS = 900_000;
const SIZE = 11, MARGIN = 56, LEADING = SIZE * 1.2 + 2;
const A4: [number, number] = [595.28, 841.89];
let font: Promise<ArrayBuffer> | null = null;
const fontBytes = () => (font ??= fetch(`${import.meta.env?.BASE_URL ?? '/'}fonts/DejaVuSans.ttf`).then(r => r.arrayBuffer()));

function wrap(line: string, face: PDFFont, width: number): string[] {
  const out: string[] = [];
  let current = '';
  for (const word of line.split(/(\s+)/)) {
    const next = current + word;
    if (current && face.widthOfTextAtSize(next.trimEnd(), SIZE) > width) { out.push(current.trimEnd()); current = word.trimStart(); } else current = next;
  }
  out.push(current.trimEnd());
  return out;
}

export async function textToPdf(text: string, outPath: string): Promise<void> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const face = await doc.embedFont(await fontBytes(), { subset: true });
  const width = A4[0] - 2 * MARGIN;
  let page = doc.addPage(A4);
  let y = A4[1] - MARGIN;
  for (const raw of (text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text).split('\n')) {
    for (const line of wrap(raw, face, width)) {
      if (y < MARGIN) { page = doc.addPage(A4); y = A4[1] - MARGIN; }
      if (line) page.drawText(line, { x: MARGIN, y: y - SIZE, size: SIZE, font: face, color: rgb(0, 0, 0) });
      y -= LEADING;
    }
  }
  fs.writeFileSync(outPath, await doc.save());
}
