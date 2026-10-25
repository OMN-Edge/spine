import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';

process.env.SPINE_DB_PATH = ':memory:';
process.env.ANTHROPIC_API_KEY = 'test';

const mockRasterizePdf = vi.hoisted(() => vi.fn());
const mockGetPageImageDimensions = vi.hoisted(() => vi.fn());
const mockCheckContinuation = vi.hoisted(() => vi.fn());
const mockExtractFields = vi.hoisted(() => vi.fn());
const mockAllowed = vi.hoisted(() => vi.fn());
const sidecarParse = vi.hoisted(() => vi.fn());
const modelParse = vi.hoisted(() => vi.fn());

vi.mock('spine-core/ingestion/rasterize.js', () => ({ rasterizePdf: mockRasterizePdf }));
vi.mock('spine-core/ingestion/image-size.js', () => ({ getPageImageDimensions: mockGetPageImageDimensions }));
vi.mock('spine-core/ingestion/continuation.js', () => ({ checkContinuation: mockCheckContinuation }));
vi.mock('spine-core/ingestion/extraction.js', () => ({ extractFields: mockExtractFields }));
vi.mock('spine-core/parser/index.js', () => ({
  getParser: () => ({ parse: sidecarParse, imageEgress: false }),
  getModelParser: () => ({ parse: modelParse, imageEgress: true }),
  aiReadingAllowed: mockAllowed,
  resetParser: () => {},
}));

import { startIngestionJob, getJobStatus } from 'spine-core/ingestion/pipeline.js';
import { getStore } from 'spine-core/store/index.js';
import { normalisePhoto, MAX_PHOTO_SIDE } from 'spine-core/ingestion/photo.js';
import { detectFileKind, isImage } from 'spine-core/file-kind.js';
import { createTestUser, seedSourceFile, OWNER_ID } from './helpers/seed.js';

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spine-photos-'));
  process.env.DATA_DIR = dir;
  await createTestUser();
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

/** A real image file: a bright left half and a dark right half, so which way is up can be told. */
async function writeImage(name: string, opts: { width: number; height: number; format: 'jpeg' | 'png'; orientation?: number; alpha?: boolean }) {
  const { width, height, format, orientation, alpha } = opts;
  const half = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4; const bright = x < width / 2;
    half[i] = half[i + 1] = half[i + 2] = bright ? 240 : 20; half[i + 3] = alpha ? 0 : 255;
  }
  let img = sharp(half, { raw: { width, height, channels: 4 } });
  if (orientation) img = img.withMetadata({ orientation });
  const path = join(dir, name);
  await (format === 'jpeg' ? img.jpeg() : img.png()).toFile(path);
  return path;
}

describe('what kind of file it is', () => {
  const file = (name: string, bytes: Buffer) => { const p = join(dir, name); writeFileSync(p, bytes); return p; };
  it('reads it from the contents', async () => {
    expect(detectFileKind(file('a.bin', Buffer.from('%PDF-1.7 x')))).toBe('pdf');
    expect(detectFileKind(file('b.bin', Buffer.concat([Buffer.from('\r\n'), Buffer.from('%PDF-1.5')])))).toBe('pdf');
    expect(detectFileKind(await writeImage('c.dat', { width: 8, height: 8, format: 'jpeg' }))).toBe('jpeg');
    expect(detectFileKind(await writeImage('d.dat', { width: 8, height: 8, format: 'png' }))).toBe('png');
  });
  it('is not misled by a name, and says nothing for anything else', () => {
    expect(detectFileKind(file('e.jpg', Buffer.from('plain text')))).toBeNull();
    expect(detectFileKind(file('f.png', Buffer.from('%PDF-1.4 really a pdf')))).toBe('pdf');
    expect(detectFileKind(file('g.pdf', Buffer.alloc(0)))).toBeNull();
    expect(detectFileKind(file('h.pdf', Buffer.from([0xff, 0xd8])))).toBeNull(); // too short to be a JPEG
    expect(detectFileKind(file('i.gif', Buffer.from('GIF89a')))).toBeNull();
    expect(detectFileKind(file('k.bin', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x00])))).toBeNull(); // nearly a PNG signature
    expect(detectFileKind(file('l.bin', Buffer.from([0x89, 0x41, 0x42])))).toBeNull();
    expect(detectFileKind(file('j.bin', Buffer.concat([Buffer.alloc(2000, 0x20), Buffer.from('%PDF-')])))).toBeNull(); // signature past 1 KB
  });
  it('knows which are images', () => {
    expect([isImage('jpeg'), isImage('png'), isImage('pdf'), isImage(null)]).toEqual([true, true, false, false]);
  });
});

describe('preparing a photo as a page', () => {
  const dims = async (path: string) => { const m = await sharp(path).metadata(); return { w: m.width, h: m.height, format: m.format, orientation: m.orientation }; };
  const leftIsBright = async (path: string) => {
    const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => data[(y * info.width + x) * info.channels];
    return at(2, 2) > at(info.width - 3, 2);
  };

  it('writes one upright PNG page and leaves the original alone', async () => {
    const original = await writeImage('plain.jpg', { width: 400, height: 300, format: 'jpeg' });
    const id = uuidv4();
    const pages = await normalisePhoto(id, original);
    expect(pages).toEqual([{ page_number: 1, image_path: join(dir, 'pages', id, 'page-1.png') }]);
    expect(await dims(pages[0].image_path)).toMatchObject({ w: 400, h: 300, format: 'png' });
    expect(existsSync(original)).toBe(true);
    expect((await dims(original)).format).toBe('jpeg');
  });

  it('turns a sideways phone photo upright by its EXIF flag', async () => {
    // Stored 600 wide by 300 high with "rotate 90° to view" (6): upright it is 300 wide by 600 high.
    const original = await writeImage('sideways.jpg', { width: 600, height: 300, format: 'jpeg', orientation: 6 });
    expect((await dims(original)).orientation).toBe(6);
    const [page] = await normalisePhoto(uuidv4(), original);
    expect(await dims(page.image_path)).toMatchObject({ w: 300, h: 600 });
    expect((await dims(page.image_path)).orientation).toBeUndefined(); // applied, not left to be applied twice
  });

  it('actually rotates the pixels, not only the size', async () => {
    const flat = await writeImage('flat.jpg', { width: 600, height: 300, format: 'jpeg' });
    const turned = await writeImage('turned.jpg', { width: 600, height: 300, format: 'jpeg', orientation: 6 });
    expect(await leftIsBright((await normalisePhoto(uuidv4(), flat))[0].image_path)).toBe(true);
    expect(await leftIsBright((await normalisePhoto(uuidv4(), turned))[0].image_path)).toBe(false); // the bright half is now on top
  });

  it('shrinks a large photo to the limit, keeping its proportions, and never enlarges a small one', async () => {
    const big = await writeImage('big.png', { width: 5200, height: 3900, format: 'png' });
    const [page] = await normalisePhoto(uuidv4(), big);
    expect(await dims(page.image_path)).toMatchObject({ w: MAX_PHOTO_SIDE, h: MAX_PHOTO_SIDE * 3 / 4 });
    const small = await writeImage('small.png', { width: 100, height: 50, format: 'png' });
    expect(await dims((await normalisePhoto(uuidv4(), small))[0].image_path)).toMatchObject({ w: 100, h: 50 });
  });

  it('puts a transparent image on white, not black', async () => {
    const original = await writeImage('clear.png', { width: 40, height: 40, format: 'png', alpha: true });
    const [page] = await normalisePhoto(uuidv4(), original);
    const { data, info } = await sharp(page.image_path).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(3);
    expect(data[0]).toBe(255);
  });
});

describe('the pipeline for a photo', () => {
  const photoPath = () => join(dir, 'pipeline-photo.jpg');
  const reading = {
    pages: [{ page_number: 1, elements: [{ type: 'NarrativeText', text: 'Buletin de analize', page_number: 1, bbox: { x0: 0, y0: 0, x1: 100, y1: 20 }, source: 'multimodal' }], extraction_source: 'multimodal', image_width: 300, image_height: 600 }],
  };
  const extraction = { title: 'Buletin', doc_date: '2026-05-12', provider: null, doc_type: 'lab_result', ai_summary: 's', suggested_tags: [], doctors: [], measurements: [], fields: [] };

  async function wait(id: string) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const job = getJobStatus(id);
      if (job?.status === 'done' || job?.status === 'error') return job;
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error('timed out');
  }

  beforeEach(async () => {
    for (const m of [mockRasterizePdf, mockCheckContinuation, mockExtractFields, mockAllowed, sidecarParse, modelParse]) m.mockReset();
    mockExtractFields.mockResolvedValue(extraction);
    modelParse.mockResolvedValue(reading);
    sidecarParse.mockResolvedValue(reading);
    mockAllowed.mockReturnValue(true);
    mockGetPageImageDimensions.mockReturnValue({ width: 300, height: 600 });
    await writeImage('pipeline-photo.jpg', { width: 600, height: 300, format: 'jpeg', orientation: 6 });
  });

  it('goes straight to the model as one upright page, without rendering a PDF or trying local reading', async () => {
    const id = uuidv4();
    await seedSourceFile({ id, mimeType: 'image/jpeg', filePath: photoPath() });
    startIngestionJob(id, OWNER_ID);
    expect((await wait(id)).status).toBe('done');

    expect(mockRasterizePdf).not.toHaveBeenCalled();
    expect(sidecarParse).not.toHaveBeenCalled();
    expect(modelParse).toHaveBeenCalledTimes(1);
    const input = modelParse.mock.calls[0][0] as { pages: Array<{ page_number: number; image_path: string }> };
    expect(input.pages).toHaveLength(1);
    expect(input.pages[0].image_path).toBe(join(dir, 'pages', id, 'page-1.png'));
    expect(existsSync(input.pages[0].image_path)).toBe(true);

    const pages = await getStore().pages.listForSourceFile(OWNER_ID, id);
    expect(pages).toHaveLength(1);
    const docs = (await getStore().documents.listFor(OWNER_ID, { limit: 100, offset: 0, includeUnconfirmed: true })).filter(d => d.source_file_id === id);
    expect(docs).toHaveLength(1);
    expect(mockCheckContinuation).not.toHaveBeenCalled(); // one page: no boundary to judge
  });

  it('fails clearly, reading nothing, if image reading is off', async () => {
    mockAllowed.mockReturnValue(false);
    const id = uuidv4();
    await seedSourceFile({ id, mimeType: 'image/png', filePath: photoPath() });
    startIngestionJob(id, OWNER_ID);
    const job = await wait(id);
    expect(job.status).toBe('error');
    expect(job.error).toMatch(/image reading is switched off/);
    expect(modelParse).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'pages', id))).toBe(false); // nothing prepared, nothing sent
  });

  it('still reads a PDF the usual way', async () => {
    mockRasterizePdf.mockResolvedValue([{ page_number: 1, image_path: '/tmp/page-1.png' }]);
    const id = uuidv4();
    await seedSourceFile({ id });
    startIngestionJob(id, OWNER_ID);
    expect((await wait(id)).status).toBe('done');
    expect(mockRasterizePdf).toHaveBeenCalled();
    expect(sidecarParse).toHaveBeenCalledTimes(1);
    expect(modelParse).not.toHaveBeenCalled();
  });

  it('sends photos bundled into a PDF to the model, one entry per page, and fails if image reading is off', async () => {
    mockRasterizePdf.mockResolvedValue([{ page_number: 1, image_path: '/tmp/set-1.png' }, { page_number: 2, image_path: '/tmp/set-2.png' }]);
    modelParse.mockResolvedValue({ pages: [1, 2].map(n => ({ ...reading.pages[0], page_number: n, elements: [{ ...reading.pages[0].elements[0], page_number: n }] })) });
    const id = uuidv4();
    await seedSourceFile({ id, photoSet: true });
    startIngestionJob(id, OWNER_ID);
    expect((await wait(id)).status).toBe('done');
    expect(mockRasterizePdf).toHaveBeenCalled();
    expect(sidecarParse).not.toHaveBeenCalled();
    expect((modelParse.mock.calls[0][0] as { pages: unknown[] }).pages).toHaveLength(2);

    mockAllowed.mockReturnValue(false);
    modelParse.mockClear();
    const off = uuidv4();
    await seedSourceFile({ id: off, photoSet: true });
    startIngestionJob(off, OWNER_ID);
    expect((await wait(off)).status).toBe('error');
    expect(modelParse).not.toHaveBeenCalled();
  });

  it('never sends a PDF to the model just because image reading is on', async () => {
    mockRasterizePdf.mockResolvedValue([{ page_number: 1, image_path: '/tmp/page-1.png' }]);
    const id = uuidv4();
    await seedSourceFile({ id });
    mockAllowed.mockReturnValue(true);
    startIngestionJob(id, OWNER_ID);
    await wait(id);
    expect(modelParse).not.toHaveBeenCalled();
  });
});
