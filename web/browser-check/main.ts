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
import { stampImages, readDigitalSigners } from '../src/core/native/signatures';
import heicUrl from '../../server/src/__tests__/fixtures/gradient.heic?url';
import signedRsaUrl from '../../server/src/__tests__/fixtures/signed-rsa.pdf?url';
import signedEcUrl from '../../server/src/__tests__/fixtures/signed-ec.pdf?url';

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
  // stamps: a letterhead on both pages must be left out, the wide picture on the last page kept, and what is kept is a PNG at most 1000 wide
  await step(out, 'stamps', async () => {
    const picture = async (w: number, h: number, shade: string) => { const cv = new OffscreenCanvas(w, h); const cx = cv.getContext('2d')!; cx.fillStyle = shade; cx.fillRect(0, 0, w, h); cx.fillStyle = '#000'; cx.fillText('Dr. Example Invented', 10, h / 2); return new Uint8Array(await (await cv.convertToBlob({ type: 'image/png' })).arrayBuffer()); };
    const doc = await PDFDocument.create();
    const letterhead = await doc.embedPng(await picture(400, 100, '#9cf'));
    const stamp = await doc.embedPng(await picture(1400, 700, '#fc9'));
    const first = doc.addPage([595, 842]); first.drawImage(letterhead, { x: 40, y: 760, width: 200, height: 50 });
    const last = doc.addPage([595, 842]); last.drawImage(letterhead, { x: 40, y: 760, width: 200, height: 50 }); last.drawImage(stamp, { x: 300, y: 100, width: 200, height: 100 });
    const crops = await stampImages(await doc.save(), [2]);
    const kept = crops.get(2) ?? [];
    const bitmap = kept[0] ? await createImageBitmap(new Blob([kept[0] as unknown as BlobPart])) : null;
    if (kept.length !== 1 || !bitmap || bitmap.width !== 1000 || bitmap.height !== 500) throw new Error(`expected one 1000x500 stamp, got ${kept.length} (${bitmap?.width}x${bitmap?.height})`);
    return { kept: kept.length, width: bitmap.width, height: bitmap.height };
  });
  // digital signatures: an invented RSA and an invented ECDSA signature are read with WebCrypto, and a changed byte voids one
  await step(out, 'signatures', async () => {
    const load = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer());
    const rsa = await load(signedRsaUrl), ec = await load(signedEcUrl);
    fs.writeFileSync('/data/originals/rsa.pdf', rsa); fs.writeFileSync('/data/originals/ec.pdf', ec);
    const changed = Uint8Array.from(rsa); const at = new TextDecoder('latin1').decode(changed).indexOf('/MediaBox') + 10; changed[at] += 1;
    fs.writeFileSync('/data/originals/changed.pdf', changed);
    const names = [...await readDigitalSigners('/data/originals/rsa.pdf'), ...await readDigitalSigners('/data/originals/ec.pdf')].map(s => s.name);
    const voided = await readDigitalSigners('/data/originals/changed.pdf');
    if (names.join() !== 'Ana Testescu,Dan Exemplu' || voided.length !== 0) throw new Error(`expected both signers and none once changed, got ${names.join()} / ${voided.length}`);
    return names;
  });
  await step(out, 'own-signed', async () => {
    const response = await fetch('/own-signed.pdf');
    if (!response.ok) return 'none given';
    fs.writeFileSync('/data/originals/own.pdf', new Uint8Array(await response.arrayBuffer()));
    return { signers: (await readDigitalSigners('/data/originals/own.pdf')).map(s => s.name.length > 0) };
  });
  // HEIC: its converter is loaded when a file needs it (a chunk of its own), so this is the proof that loading it on the device works.
  await step(out, 'heic', async () => {
    // A small file is inlined as a data address, which the page's policy does not let fetch read: decode it here.
    fs.writeFileSync('/data/originals/g.heic', Uint8Array.from(atob(heicUrl.split(',')[1]), c => c.charCodeAt(0)));
    const converted = await convertUpload('/data/originals/g.heic');
    const head = fs.readFileSync(converted!.path) as Buffer;
    if (converted?.from !== 'heic' || head[0] !== 0xff || head[1] !== 0xd8) throw new Error('expected a JPEG from the HEIC file');
    return head.length;
  });
  await step(out, 'core', async () => { const core = await startCore(); return (await core.inject({ method: 'GET', url: '/api/tags' })).statusCode; });
  (window as any).__result = out;
})();
