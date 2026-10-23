import '../src/core/shims/globals';
import fs from 'fs';
import { startCore } from '../src/core/boot';
import { rasterizePdf } from '../src/core/native/rasterize';
import { ocrPage } from '../src/core/native/ocr';
import { extractPdfPages } from '../src/core/native/pdf-pages';
import { parseDocument } from '../../server/src/ingestion/pdf-text';
import { normalisePhoto } from '../../server/src/ingestion/photo';
import { bundlePhotos } from '../../server/src/ingestion/photo-set';
import { convertUpload } from '../../server/src/ingestion/convert';
import { rotateImage } from '../src/core/native/image-ops';
import { newZip } from '../src/core/native/zip-write';
import { ZipReader } from '../src/core/native/zip-read';

import { PDFDocument, StandardFonts } from 'pdf-lib';
/** An invented two-page PDF with a text layer, made here so the check needs no file. */
async function samplePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of [['Example Clinic - Consultation', 'Patient: Jane Example (invented). Date: 12.03.2026.', 'Blood pressure 128/82 mmHg, pulse 72 per minute.'], ['Laboratory report', 'Hemoglobin 13.5 g/dL, glucose 5.1 mmol/L.']]) {
    const page = doc.addPage([595.28, 841.89]);
    lines.forEach((t, i) => page.drawText(t, { x: 60, y: 760 - i * 28, size: i ? 14 : 20, font }));
  }
  return doc.save();
}

const step = async (out: Record<string, unknown>, name: string, fn: () => Promise<unknown>) => {
  const t = performance.now();
  try { out[name] = { ok: await fn(), ms: Math.round(performance.now() - t) }; } catch (e) { out[name] = { error: String((e as Error).stack || e).slice(0, 400) }; }
};
(async () => {
  const out: Record<string, unknown> = {};
  fs.mkdirSync('/data/originals', { recursive: true });
  const bytes = await samplePdf();
  fs.writeFileSync('/data/originals/a.pdf', bytes);
  await step(out, 'text', async () => (await parseDocument('/data/originals/a.pdf')).pages.map(p => p.elements.length));
  let pages: Array<{ image_path: string }> = [];
  await step(out, 'raster', async () => { pages = await rasterizePdf('a', '/data/originals/a.pdf'); return pages.map(p => fs.statSync(p.image_path).size); });
  await step(out, 'ocr', async () => { const o = await ocrPage(pages[0].image_path, 1, 'ron+eng'); return { words: o.words, mean: Math.round(o.meanConfidence), first: o.elements[0]?.text }; });
  await step(out, 'trim', async () => { fs.writeFileSync('/data/t.pdf', await extractPdfPages('/data/originals/a.pdf', [1])); return fs.statSync('/data/t.pdf').size; });
  // a photo: draw something, save as JPEG, make it a page, bundle two into a PDF, rotate
  const c = new OffscreenCanvas(3000, 2000); const g = c.getContext('2d')!; g.fillStyle = '#eee'; g.fillRect(0, 0, 3000, 2000); g.fillStyle = '#000'; g.font = '120px sans-serif'; g.fillText('Hemoglobin 13.5 g/dL', 200, 600);
  fs.writeFileSync('/data/originals/photo.jpg', new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg' })).arrayBuffer()));
  await step(out, 'photo', async () => { const p = await normalisePhoto('ph', '/data/originals/photo.jpg'); return fs.statSync(p[0].image_path).size; });
  await step(out, 'bundle', async () => { await bundlePhotos(['/data/originals/photo.jpg', '/data/originals/photo.jpg'], '/data/set.pdf'); const t = await parseDocument('/data/set.pdf'); const r = await rasterizePdf('set', '/data/set.pdf'); return { bytes: fs.statSync('/data/set.pdf').size, pagesRead: r.length }; });
  await step(out, 'rotate', async () => rotateImage('/data/pages/ph/page-1.png', '/data/rot.png', 90));
  await step(out, 'txt', async () => { fs.writeFileSync('/data/originals/n.txt', 'Epicriză\nPacient: Ionescu Maria, ă ș ț î â.\n'); const r = await convertUpload('/data/originals/n.txt'); const t = await parseDocument(r!.path); return { from: r!.from, text: t.pages[0]?.elements.map(e => e.text) }; });
  await step(out, 'zip', async () => { const z = newZip(); z.addBuffer(Buffer.from('hello'), 'a.txt'); z.addFile('/data/originals/a.pdf', 'dir/a.pdf'); const chunks: Buffer[] = []; for await (const ch of z.finish() as AsyncIterable<Buffer>) chunks.push(ch); fs.writeFileSync('/data/x.zip', Buffer.concat(chunks)); const r = await ZipReader.open('/data/x.zip'); const t = (await r.readBuffer('a.txt', 100)).toString(); const e = await r.extractTo('dir/a.pdf', '/data/b.pdf', 1e7); return { names: r.entries.map(x => x.name), t, same: e.bytes === bytes.length }; });
  await step(out, 'core', async () => { const core = await startCore(); return (await core.inject({ method: 'GET', url: '/api/tags' })).statusCode; });
  (window as any).__result = out;
})();
