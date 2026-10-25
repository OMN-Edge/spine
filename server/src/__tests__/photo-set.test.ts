import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import sharp from 'sharp';
import { buildTestApp, loginSession } from './helpers/app.js';
import { getStore } from 'spine-core/store/index.js';
import { OWNER_ID } from './helpers/seed.js';
import { bundlePhotos, MAX_PHOTOS_IN_SET } from 'spine-core/ingestion/photo-set.js';
import { readsByModel } from 'spine-core/file-kind.js';

const mockStartJob = vi.hoisted(() => vi.fn());
const mockAllowed = vi.hoisted(() => vi.fn());
vi.mock('spine-core/ingestion/pipeline.js', () => ({ startIngestionJob: mockStartJob, getJobStatus: vi.fn().mockReturnValue(null) }));
vi.mock('spine-core/parser/index.js', async orig => ({ ...(await orig<typeof import('spine-core/parser/index.js')>()), aiReadingAllowed: mockAllowed }));

import { hasPoppler } from 'spine-core/testing/tools.js';

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
const dir = mkdtempSync(path.join(tmpdir(), 'spine-photoset-'));
beforeAll(async () => { process.env.DATA_DIR = dir; app = await buildTestApp(); cookie = await loginSession(app); });
afterAll(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { mockStartJob.mockReset(); mockAllowed.mockReturnValue(true); });

/** A real photo: bright on the left, dark on the right, `shade` apart so two photos are two different files. */
async function photo(name: string, opts: { width?: number; height?: number; shade?: number; orientation?: number } = {}): Promise<string> {
  const { width = 120, height = 80, shade = 0, orientation } = opts;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.fill(x < width / 2 ? 240 - shade : 20 + shade, (y * width + x) * 3, (y * width + x) * 3 + 3);
  let img = sharp(raw, { raw: { width, height, channels: 3 } });
  if (orientation) img = img.withMetadata({ orientation });
  const file = path.join(dir, name);
  await img.jpeg().toFile(file);
  return file;
}

function multipartOf(files: Array<{ name: string; data: Buffer; field?: string }>) {
  const boundary = 'PhotoSetBoundary42';
  const parts = files.flatMap(f => [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field ?? 'files'}"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), f.data, Buffer.from('\r\n')]);
  return { boundary, payload: Buffer.concat([...parts, Buffer.from(`--${boundary}--`)]) };
}
const send = async (files: Array<{ name: string; data: Buffer; field?: string }>) => {
  const { boundary, payload } = multipartOf(files);
  return app.inject({ method: 'POST', url: '/api/source-files/upload-photos', headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
};
const bytesOf = (p: string) => readFileSync(p);

describe.skipIf(!hasPoppler)('photos bundled into one PDF', () => {
  it('has a page for each photo, in order, upright, at the photo\'s own size', async () => {
    const wide = await photo('wide.jpg', { width: 200, height: 100 });
    const sideways = await photo('sideways.jpg', { width: 200, height: 100, orientation: 6 }); // a phone turned: shown 100 wide and 200 tall
    const out = path.join(dir, 'set.pdf');
    await bundlePhotos([wide, sideways], out);
    const info = execFileSync('pdfinfo', ['-f', '1', '-l', '2', out]).toString();
    expect(info).toMatch(/Pages:\s+2/);
    const sizes = [...info.matchAll(/Page\s+\d size:\s+([\d.]+) x ([\d.]+) pts/g)].map(m => [Math.round(+m[1] * 200 / 72), Math.round(+m[2] * 200 / 72)]);
    expect(sizes).toEqual([[200, 100], [100, 200]]);
    // The same photos in the same order are the same bytes, so a second try is recognised.
    const again = path.join(dir, 'set2.pdf');
    await bundlePhotos([wide, sideways], again);
    expect(bytesOf(again).equals(bytesOf(out))).toBe(true);
    const other = path.join(dir, 'set3.pdf');
    await bundlePhotos([sideways, wide], other);
    expect(bytesOf(other).equals(bytesOf(out))).toBe(false);
  });
});

describe.skipIf(!hasPoppler)('the upload of several photos', () => {
  it('is one upload whose pages the photos are, read by a model, in the order sent', async () => {
    const a = await photo('a.jpg', { shade: 0 }); const b = await photo('b.jpg', { shade: 10 }); const c = await photo('c.jpg', { shade: 20 });
    const res = await send([{ name: 'IMG_1.jpg', data: bytesOf(a) }, { name: 'IMG_2.jpg', data: bytesOf(b) }, { name: 'IMG_3.jpg', data: bytesOf(c) }]);
    expect(res.statusCode).toBe(200);
    const [result] = res.json() as Array<{ id: string; status: string }>;
    expect(result).toMatchObject({ status: 'processing' });
    expect(mockStartJob).toHaveBeenCalledTimes(1); // one job for the set, not three

    const upload = (await getStore().sourceFiles.findFor(OWNER_ID, result.id))!;
    expect(upload).toMatchObject({ mime_type: 'application/pdf', photo_set: true, original_filename: 'IMG_1 (3 photos).pdf' });
    expect(readsByModel(upload)).toBe(true);
    expect(execFileSync('pdfinfo', [upload.file_path]).toString()).toMatch(/Pages:\s+3/);

    // The same photos again are a duplicate of it, not a second upload.
    const again = (await send([{ name: 'IMG_1.jpg', data: bytesOf(a) }, { name: 'IMG_2.jpg', data: bytesOf(b) }, { name: 'IMG_3.jpg', data: bytesOf(c) }])).json() as Array<Record<string, unknown>>;
    expect(again[0]).toMatchObject({ skipped: true, reason: 'duplicate', existing_id: result.id });
    expect(mockStartJob).toHaveBeenCalledTimes(1);
  });

  it('keeps nothing when the model may not read images, when a file is not a photo, or when there are too many', async () => {
    const a = bytesOf(await photo('x.jpg', { shade: 30 })); const b = bytesOf(await photo('y.jpg', { shade: 40 }));
    const before = (await getStore().sourceFiles.listFor(OWNER_ID)).length;

    mockAllowed.mockReturnValue(false);
    expect(((await send([{ name: 'x.jpg', data: a }, { name: 'y.jpg', data: b }])).json() as Array<Record<string, unknown>>)[0]).toMatchObject({ skipped: true, reason: 'photo_needs_ai' });

    mockAllowed.mockReturnValue(true);
    expect(((await send([{ name: 'x.jpg', data: a }, { name: 'notes.jpg', data: Buffer.from('not a picture') }])).json() as Array<Record<string, unknown>>)[0]).toMatchObject({ skipped: true, reason: 'not_pdf', filename: 'notes.jpg' });
    expect(((await send([{ name: 'doc.pdf', data: Buffer.from('%PDF-1.4 a pdf') }, { name: 'y.jpg', data: b }])).json() as Array<Record<string, unknown>>)[0]).toMatchObject({ skipped: true, reason: 'not_pdf', filename: 'doc.pdf' });

    const many = Array.from({ length: MAX_PHOTOS_IN_SET + 1 }, (_, i) => ({ name: `p${i}.jpg`, data: a }));
    expect(((await send(many)).json() as Array<Record<string, unknown>>)[0]).toMatchObject({ skipped: true, reason: 'too_many' });

    expect((await getStore().sourceFiles.listFor(OWNER_ID)).length).toBe(before);
    expect(mockStartJob).not.toHaveBeenCalled();
  });

  it('needs a session', async () => {
    const { boundary, payload } = multipartOf([{ name: 'a.jpg', data: Buffer.from('x') }]);
    const res = await app.inject({ method: 'POST', url: '/api/source-files/upload-photos', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    expect(res.statusCode).toBe(401);
  });
});

describe.skipIf(!hasPoppler)('a scan session keeps the photos as they were taken', () => {
  it('stores them beside the PDF, serves them to the owner only, and removes them with the upload', async () => {
    const processedA = await photo('pa.jpg', { shade: 31 }); const processedB = await photo('pb.jpg', { shade: 33 });
    const rawA = await photo('ra.jpg', { shade: 5, width: 300, height: 200 }); const rawB = await photo('rb.jpg', { shade: 6, width: 300, height: 200 });
    const res = await send([
      { name: 'page-1.jpg', data: bytesOf(processedA) }, { name: 'page-2.jpg', data: bytesOf(processedB) },
      { name: 'raw-1.jpg', data: bytesOf(rawA), field: 'originals' }, { name: 'raw-2.jpg', data: bytesOf(rawB), field: 'originals' },
      { name: 'notes.txt', data: Buffer.from('not a photo'), field: 'originals' },
    ]);
    const [result] = res.json() as Array<{ id: string; status: string }>;
    expect(result.status).toBe('processing');

    const upload = (await getStore().sourceFiles.findFor(OWNER_ID, result.id))!;
    expect(upload.raw_count).toBe(2); // the text file was not kept
    const get = (n: number, c = cookie) => app.inject({ method: 'GET', url: `/api/source-files/${result.id}/originals/${n}`, headers: c ? { cookie: c } : {} });
    const first = await get(1);
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toContain('image/jpeg');
    expect((await sharp(first.rawPayload).metadata()).width).toBe(300); // as taken, not as processed
    expect((await get(2)).statusCode).toBe(200);
    for (const n of [0, 3, -1]) expect((await get(n)).statusCode).toBe(404);
    expect((await get(1, '')).statusCode).toBe(401);

    const { createTestUser } = await import('./helpers/seed.js');
    const { loginAs } = await import('./helpers/app.js');
    const other = await createTestUser('photographer@spine.test');
    expect((await get(1, await loginAs(app, other.email, other.password))).statusCode).toBe(404);

    // They go with the upload.
    const rawDir = upload.file_path.replace(/\.pdf$/, '.raw');
    const { existsSync } = await import('fs');
    expect(existsSync(rawDir)).toBe(true);
    await getStore().sourceFiles.setStatus(OWNER_ID, result.id, 'done');
    expect((await app.inject({ method: 'DELETE', url: `/api/source-files/${result.id}`, headers: { cookie } })).statusCode).toBe(200);
    expect(existsSync(rawDir)).toBe(false);
  });
});

describe('a scan session when only local OCR can read it', () => {
  it('is read by local OCR when the parser is ocr, or hybrid with Tesseract on, and otherwise by a model', async () => {
    const { localOcrReadsPhotoSets, readsByModel } = await import('spine-core/file-kind.js');
    const keys = ['SPINE_PARSER', 'SPINE_OCR', 'SPINE_MULTIMODAL_ENABLED'] as const;
    const was = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    try {
      // hybrid is a parser that can send images, which is a second switch of its own.
      process.env.SPINE_MULTIMODAL_ENABLED = 'true';
      for (const [mode, ocr, expected] of [['text', undefined, false], ['ocr', undefined, true], ['hybrid', undefined, true], ['hybrid', 'off', false]] as const) {
        process.env.SPINE_PARSER = mode;
        if (ocr) process.env.SPINE_OCR = ocr; else delete process.env.SPINE_OCR;
        expect(localOcrReadsPhotoSets(), `${mode} ${ocr ?? ''}`).toBe(expected);
        expect(readsByModel({ mime_type: 'application/pdf', photo_set: true })).toBe(!expected);
      }
      // A single photo is still the model's: there is no PDF for the text layer or OCR route to start from.
      process.env.SPINE_PARSER = 'ocr'; delete process.env.SPINE_OCR;
      expect(readsByModel({ mime_type: 'image/jpeg' })).toBe(true);
    } finally {
      for (const k of keys) { if (was[k] === undefined) delete process.env[k]; else process.env[k] = was[k]; }
    }
  });
});
