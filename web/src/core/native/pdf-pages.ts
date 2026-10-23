import fs from 'fs';
import { Buffer } from 'buffer';
import { PDFDocument } from 'pdf-lib';

/** Same contract as server/src/archive/pdf-pages.ts: a new PDF with only these pages of a file (their numbers in it), in the order given. */
export async function extractPdfPages(source: string, sourcePages: number[]): Promise<Buffer> {
  const from = await PDFDocument.load(fs.readFileSync(source) as Buffer, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  for (const page of await out.copyPages(from, sourcePages.map(n => n - 1))) out.addPage(page);
  return Buffer.from(await out.save());
}
