import { describe, it, expect } from 'vitest';
import PDFDocument from 'pdfkit';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { parseDocument } from '../ingestion/pdf-text.js';

/** An invented two-page file: a heading and a two-line paragraph, a table row far apart, then a blank page. */
async function makePdf(): Promise<string> {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks: Buffer[] = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise<void>(r => doc.on('end', () => r()));
  doc.fontSize(16).text('Example Laboratory Report', 50, 50);
  doc.fontSize(11).text('The sample was received on the first of March and', 50, 100);
  doc.text('processed the same day without delay.', 50, 114);
  doc.text('Glucose', 50, 300);
  doc.text('5.1 mmol/L', 350, 300);
  doc.addPage();
  doc.addPage();
  doc.text('Page three', 50, 50);
  doc.end();
  await done;
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'spine-pdf-')), 'a.pdf');
  writeFileSync(file, Buffer.concat(chunks));
  return file;
}

describe('the PDF text layer', () => {
  it('returns paragraphs with boxes in points, leaving a blank page out', async () => {
    const { pages } = await parseDocument(await makePdf());

    expect(pages.map(p => p.page_number)).toEqual([1, 3]);
    expect(pages[0].image_width).toBeCloseTo(595.28, 0);
    expect(pages[0].image_height).toBeCloseTo(841.89, 0);
    expect(pages[0].extraction_source).toBe('native_text');

    const texts = pages[0].elements.map(e => e.text);
    expect(texts).toContain('Example Laboratory Report');
    // Two lines close together are one paragraph; cells far apart are separate.
    expect(texts).toContain('The sample was received on the first of March and\nprocessed the same day without delay.');
    expect(texts).toContain('Glucose');
    expect(texts).toContain('5.1 mmol/L');

    const heading = pages[0].elements.find(e => e.text.startsWith('Example'))!;
    expect(heading.bbox!.y0).toBeGreaterThan(40);
    expect(heading.bbox!.y0).toBeLessThan(60);
    expect(heading.bbox!.y1).toBeGreaterThan(heading.bbox!.y0);
  });
});
