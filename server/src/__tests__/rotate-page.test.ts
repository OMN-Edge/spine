import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, statSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { buildTestApp, loginAs, loginSession } from './helpers/app.js';
import { createTestUser, seedDocument, seedSourceFile } from './helpers/seed.js';
import { getStore } from '../store/index.js';
import { rotateBox } from '../geometry.js';

const OWNER = 'user-owner';
let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
let tmp: string;

beforeAll(async () => {
  app = await buildTestApp();
  cookie = await loginSession(app);
  tmp = mkdtempSync(path.join(tmpdir(), 'spine-rotate-'));
});
afterAll(async () => { await app.close(); rmSync(tmp, { recursive: true, force: true }); });

/** A page 40 wide and 20 tall, a dark block in its left half, so which way it faces can be read from the pixels. */
async function pageWithReading() {
  const imagePath = path.join(tmp, `${uuidv4()}.png`);
  const raw = Buffer.alloc(40 * 20 * 3, 255);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) raw.fill(0, (y * 40 + x) * 3, (y * 40 + x) * 3 + 3);
  await sharp(raw, { raw: { width: 40, height: 20, channels: 3 } }).png().toFile(imagePath);

  const store = getStore();
  const sourceFileId = await seedSourceFile({ status: 'done' });
  const pageId = uuidv4();
  const box = { x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.4 };
  await store.pages.create(OWNER, {
    id: pageId, sourceFileId, pageNumber: 1, imagePath, imageWidth: 40, imageHeight: 20, rawText: 'Hemoglobina 13,5',
    elements: [{ type: 'NarrativeText', text: 'Hemoglobina 13,5', page_number: 1, bbox: box, source: 'native_text' }],
    extractionSource: 'native_text', isContinuation: null, continuationConfidence: null, continuationReasoning: null,
  });
  const { id: documentId } = await seedDocument({ sourceFileId, withPage: false });
  const fieldId = uuidv4();
  await store.fields.create(OWNER, { id: fieldId, documentId, pageId, label: 'diagnosis', value: 'x', sourceSnippet: null, bbox: box, confidence: 0.9 });
  return { pageId, imagePath, documentId, fieldId, box };
}

const rotate = (pageId: string, degrees: unknown, headers: Record<string, string> = { cookie }) =>
  app.inject({ method: 'POST', url: `/api/pages/${pageId}/rotate`, headers, payload: { degrees } as object });

describe('turning a box with its page', () => {
  it('moves a corner as the image moves, and four quarter turns come back', () => {
    const b = { x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.4 };
    expect(rotateBox(b, 90)).toEqual({ x0: 0.6, y0: 0.1, x1: 0.8, y1: 0.3 });
    const r180 = rotateBox(b, 180);
    expect(r180.x0).toBeCloseTo(0.7); expect(r180.y0).toBeCloseTo(0.6); expect(r180.x1).toBeCloseTo(0.9); expect(r180.y1).toBeCloseTo(0.8);
    const back = rotateBox(rotateBox(rotateBox(rotateBox(b, 90), 90), 90), 90);
    for (const k of ['x0', 'y0', 'x1', 'y1'] as const) expect(back[k]).toBeCloseTo(b[k]);
    expect(rotateBox(rotateBox(b, 90), 270)).toMatchObject({ x0: expect.closeTo(0.1), y1: expect.closeTo(0.4) });
  });
});

describe('POST /api/pages/:id/rotate', () => {
  it('turns the image, swaps its size, and moves the boxes of its text and fields', async () => {
    const { pageId, imagePath, documentId, box } = await pageWithReading();
    const res = await rotate(pageId, 90);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rotation: 90, image_width: 20, image_height: 40 });

    const meta = await sharp(imagePath).metadata();
    expect([meta.width, meta.height]).toEqual([20, 40]);
    // The dark block was in the left half; a clockwise quarter turn puts the left side on top.
    const { data } = await sharp(imagePath).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => data[(y * 20 + x) * meta.channels!];
    expect([px(10, 5), px(10, 35)]).toEqual([0, 255]);

    const store = getStore();
    const sourceFileId = (await store.documents.findFor(OWNER, documentId))!.source_file_id;
    const page = (await store.pages.listForSourceFile(OWNER, sourceFileId)).find(p => p.id === pageId);
    expect(page).toMatchObject({ rotation: 90, image_width: 20, image_height: 40 });
    const grounding = await store.pages.findGroundingContext(OWNER, pageId);
    const want = rotateBox(box, 90);
    expect(grounding!.elements[0].bbox).toEqual(want);
    const [field] = await store.fields.listForDocument(OWNER, documentId);
    expect([field.bbox_x0, field.bbox_y0, field.bbox_x1, field.bbox_y1]).toEqual([want.x0, want.y0, want.x1, want.y1]);

    // A second turn adds up.
    expect((await rotate(pageId, 270)).json()).toEqual({ rotation: 0, image_width: 40, image_height: 20 });
  });

  it('refuses a turn that is not 90, 180 or 270, and a page that is not the owner’s', async () => {
    const { pageId } = await pageWithReading();
    for (const bad of [0, 45, 360, '90', null]) expect((await rotate(pageId, bad)).statusCode).toBe(400);
    expect((await rotate(uuidv4(), 90)).statusCode).toBe(404);
    expect((await rotate(pageId, 90, {})).statusCode).toBe(401);

    await createTestUser('other@spine.test');
    const other = await loginAs(app, 'other@spine.test');
    expect((await rotate(pageId, 90, { cookie: other })).statusCode).toBe(404);
  });

  it('is told by the image’s date whether the browser’s copy is the turned one', async () => {
    const { pageId, imagePath } = await pageWithReading();
    const first = await app.inject({ method: 'GET', url: `/api/pages/${pageId}/image`, headers: { cookie } });
    expect(first.headers['cache-control']).toContain('no-cache');
    const stamp = first.headers['last-modified'] as string;
    expect((await app.inject({ method: 'GET', url: `/api/pages/${pageId}/image`, headers: { cookie, 'if-modified-since': stamp } })).statusCode).toBe(304);

    const later = new Date(statSync(imagePath).mtime.getTime() + 5000);
    utimesSync(imagePath, later, later);
    expect((await app.inject({ method: 'GET', url: `/api/pages/${pageId}/image`, headers: { cookie, 'if-modified-since': stamp } })).statusCode).toBe(200);
  });
});

describe('reading a page again after it was turned', () => {
  it('puts the PDF text layer’s boxes where the turned image has them, and leaves OCR’s alone', async () => {
    const { pageId } = await pageWithReading();
    await rotate(pageId, 90);
    const box = { x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.4 };
    await getStore().pages.updateReading(OWNER, pageId, {
      rawText: 'a b', extractionSource: 'mixed',
      elements: [
        { type: 'Text', text: 'a', page_number: 1, bbox: box, source: 'native_text' },
        { type: 'Text', text: 'b', page_number: 1, bbox: box, source: 'ocr' },
      ],
    });
    const { elements } = (await getStore().pages.findGroundingContext(OWNER, pageId))!;
    expect(elements.find(e => e.text === 'a')!.bbox).toEqual(rotateBox(box, 90));
    expect(elements.find(e => e.text === 'b')!.bbox).toEqual(box);
  });
});
