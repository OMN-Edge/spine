import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

process.env.SPINE_DB_PATH = ':memory:';
process.env.ANTHROPIC_API_KEY = 'test';

const mockRasterizePdf = vi.hoisted(() => vi.fn());
const mockGetPageImageDimensions = vi.hoisted(() => vi.fn());
const mockCheckContinuation = vi.hoisted(() => vi.fn());
const mockExtractFields = vi.hoisted(() => vi.fn());
const mockReadSignatures = vi.hoisted(() => vi.fn());
const mockReadSigners = vi.hoisted(() => vi.fn());
const sidecarParse = vi.hoisted(() => vi.fn());
const modelParse = vi.hoisted(() => vi.fn());
const mockAllowed = vi.hoisted(() => vi.fn());

vi.mock('../ingestion/rasterize.js', () => ({ rasterizePdf: mockRasterizePdf, getPageImageDimensions: mockGetPageImageDimensions }));
vi.mock('../ingestion/continuation.js', () => ({ checkContinuation: mockCheckContinuation }));
vi.mock('../ingestion/extraction.js', () => ({ extractFields: mockExtractFields }));
vi.mock('../ingestion/signatures.js', () => ({ readSignatures: mockReadSignatures, readDigitalSigners: mockReadSigners }));
vi.mock('../ingestion/photo.js', () => ({ normalisePhoto: vi.fn().mockResolvedValue([{ page_number: 1, image_path: '/tmp/photo-page.png' }]), MAX_PHOTO_SIDE: 2600 }));
vi.mock('../parser/index.js', () => ({
  getParser: () => ({ parse: sidecarParse, imageEgress: false }),
  getModelParser: () => ({ parse: modelParse, imageEgress: true }),
  aiReadingAllowed: mockAllowed,
  resetParser: () => {},
}));

import { startIngestionJob, getJobStatus } from '../ingestion/pipeline.js';
import { rereadDocument } from '../ingestion/document-reading.js';
import { getStore } from '../store/index.js';
import { buildTestApp, loginSession } from './helpers/app.js';
import { seedPage, seedSourceFile, OWNER_ID } from './helpers/seed.js';

let dir: string;
let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spine-flow-'));
  process.env.DATA_DIR = dir;
  app = await buildTestApp();
  cookie = await loginSession(app);
});
afterAll(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

const parsePage = (n: number) => ({ page_number: n, elements: [{ type: 'NarrativeText', text: `text ${n}`, page_number: n, bbox: { x0: 0, y0: 0, x1: 100, y1: 20 }, source: 'native_text' }], extraction_source: 'native_text', image_width: 800, image_height: 1100 });
const extraction = (over: object = {}) => ({ title: 'Raport', doc_date: '2026-05-20', provider: 'Regina Maria', doc_type: 'consultation_note', ai_summary: 's', suggested_tags: [], doctors: [], measurements: [], fields: [], ...over });

async function wait(id: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const job = getJobStatus(id);
    if (job?.status === 'done' || job?.status === 'error') return job;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('timed out');
}
const docsOf = async (sf: string) => (await getStore().documents.listFor(OWNER_ID, { limit: 100, offset: 0 })).filter(d => d.source_file_id === sf).sort((a, b) => a.page_start - b.page_start);

describe('doctors from stamps, in the pipeline', () => {
  const stamp = { name: 'Elena Marinescu', specialty: 'medic specialist cardiologie', code: 'X23456' };

  /** An upload of `pages` pages, with `continues[i]` saying whether page i+2 continues the one before. */
  async function run(pages: number, continues: boolean[], opts: { mimeType?: string } = {}) {
    mockRasterizePdf.mockResolvedValue(Array.from({ length: pages }, (_, i) => ({ page_number: i + 1, image_path: `/tmp/page-${i + 1}.png` })));
    sidecarParse.mockResolvedValue({ pages: Array.from({ length: pages }, (_, i) => parsePage(i + 1)) });
    let n = 0;
    mockCheckContinuation.mockImplementation(async () => ({ is_continuation: continues[n++], confidence: 0.9, reasoning: 'x' }));
    const id = uuidv4();
    await seedSourceFile({ id, mimeType: opts.mimeType });
    startIngestionJob(id, OWNER_ID);
    const job = await wait(id);
    return { id, job };
  }

  beforeEach(() => {
    for (const m of [mockRasterizePdf, mockCheckContinuation, mockExtractFields, mockReadSignatures, mockReadSigners, sidecarParse, modelParse, mockAllowed]) m.mockReset();
    mockExtractFields.mockResolvedValue(extraction());
    mockReadSignatures.mockResolvedValue(new Map());
    mockReadSigners.mockResolvedValue([]);
    modelParse.mockResolvedValue({ pages: [parsePage(1)] });
    mockAllowed.mockReturnValue(true);
    mockGetPageImageDimensions.mockReturnValue({ width: 800, height: 1100 });
  });

  it('asks for the last page of each document, and files what it finds as that document’s author', async () => {
    mockReadSignatures.mockResolvedValue(new Map([[3, [stamp]], [4, [{ name: 'Sorin Lazar', specialty: null, code: null }]]]));
    const { id, job } = await run(4, [true, true, false]); // pages 1-3 one document, page 4 another
    expect(job.status).toBe('done');
    expect(mockReadSignatures).toHaveBeenCalledTimes(1);
    expect(mockReadSignatures.mock.calls[0][1]).toEqual([3, 4]);

    const [first, second] = await docsOf(id);
    const store = getStore();
    const onFirst = await store.doctors.forDocument(OWNER_ID, first.id);
    expect(onFirst).toEqual([expect.objectContaining({ name: 'Elena Marinescu', specialty: 'medic specialist cardiologie', clinic: 'Regina Maria', license_code: 'X23456', role: 'author' })]);
    expect((await store.doctors.forDocument(OWNER_ID, second.id)).map(d => [d.name, d.role])).toEqual([['Sorin Lazar', 'author']]);

    // Filed as coming from a stamp, so reading the text again does not take them off the document.
    await store.doctors.unlinkRead(OWNER_ID, first.id);
    await store.doctors.unlinkRead(OWNER_ID, second.id);
    expect((await store.doctors.forDocument(OWNER_ID, first.id)).map(d => d.name)).toEqual(['Elena Marinescu']);
    expect((await store.doctors.forDocument(OWNER_ID, second.id)).map(d => d.name)).toEqual(['Sorin Lazar']);
  });

  it('keeps one directory entry for a doctor who signs several documents, and gives them the code once', async () => {
    mockReadSignatures.mockResolvedValue(new Map([[1, [stamp]], [2, [{ ...stamp, specialty: null, code: null }]]]));
    const { id } = await run(2, [false]);
    const [a, b] = await docsOf(id);
    const [onA] = await getStore().doctors.forDocument(OWNER_ID, a.id);
    const [onB] = await getStore().doctors.forDocument(OWNER_ID, b.id);
    expect(onB.id).toBe(onA.id);
    expect(onA.license_code).toBe('X23456');
  });

  it('adds nothing when no stamp was read, and the upload is the same as before', async () => {
    const { id, job } = await run(2, [true]);
    expect(job.status).toBe('done');
    const [doc] = await docsOf(id);
    expect(await getStore().doctors.forDocument(OWNER_ID, doc.id)).toEqual([]);
  });

  it('is not a failed upload if reading the stamps throws', async () => {
    mockReadSignatures.mockRejectedValue(new Error('pdfimages exploded'));
    const { id, job } = await run(1, []);
    expect(job.status).toBe('done');
    expect(job.error).toBeUndefined();
    expect((await docsOf(id))).toHaveLength(1);
  });

  it('is not a failed upload if filing a doctor fails after the documents are stored', async () => {
    mockReadSignatures.mockResolvedValue(new Map([[1, [stamp]]]));
    const spy = vi.spyOn(getStore().doctors, 'upsert').mockRejectedValueOnce(new Error('disk full'));
    const { id, job } = await run(1, []);
    spy.mockRestore();
    expect(job.status).toBe('done');
    expect((await docsOf(id))).toHaveLength(1);
  });

  it('does not look for stamps in a photo, which has no separate stamp to cut out', async () => {
    const id = uuidv4();
    await seedSourceFile({ id, mimeType: 'image/jpeg' });
    startIngestionJob(id, OWNER_ID);
    const job = await wait(id);
    expect(job.status).toBe('done');                 // read as a photo, to the end
    expect(modelParse).toHaveBeenCalledTimes(1);
    expect(mockReadSignatures).not.toHaveBeenCalled();
  });
});

describe('doctors who digitally signed the PDF', () => {
  const run = async (pages: number, continues: boolean[]) => {
    mockRasterizePdf.mockResolvedValue(Array.from({ length: pages }, (_, i) => ({ page_number: i + 1, image_path: `/tmp/page-${i + 1}.png` })));
    sidecarParse.mockResolvedValue({ pages: Array.from({ length: pages }, (_, i) => parsePage(i + 1)) });
    let n = 0;
    mockCheckContinuation.mockImplementation(async () => ({ is_continuation: continues[n++], confidence: 0.9, reasoning: 'x' }));
    const id = uuidv4();
    await seedSourceFile({ id });
    startIngestionJob(id, OWNER_ID);
    return { id, job: await wait(id) };
  };
  beforeEach(() => {
    for (const m of [mockRasterizePdf, mockCheckContinuation, mockExtractFields, mockReadSignatures, mockReadSigners, sidecarParse, mockAllowed]) m.mockReset();
    mockExtractFields.mockResolvedValue(extraction());
    mockReadSignatures.mockResolvedValue(new Map());
    mockAllowed.mockReturnValue(false); // image reading OFF: this must not need it
    mockGetPageImageDimensions.mockReturnValue({ width: 800, height: 1100 });
  });

  it('files each signer as an author of every document in the file, without image reading', async () => {
    mockReadSigners.mockResolvedValue([{ name: 'Elena Marinescu', signedAt: null }, { name: 'Radu Stoica', signedAt: null }]);
    const { id, job } = await run(2, [false]);
    expect(job.status).toBe('done');
    for (const d of await docsOf(id)) {
      const on = await getStore().doctors.forDocument(OWNER_ID, d.id);
      expect(on.map(x => [x.name, x.role, x.clinic]).sort()).toEqual([['Elena Marinescu', 'author', 'Regina Maria'], ['Radu Stoica', 'author', 'Regina Maria']]);
    }
  });

  it('survives the text being read again, like a stamp', async () => {
    mockReadSigners.mockResolvedValue([{ name: 'Elena Marinescu', signedAt: null }]);
    const { id } = await run(1, []);
    const [d] = await docsOf(id);
    await getStore().doctors.unlinkRead(OWNER_ID, d.id);
    expect((await getStore().doctors.forDocument(OWNER_ID, d.id)).map(x => x.name)).toEqual(['Elena Marinescu']);
  });

  it('adds nothing when there is no signature, and is not a failed upload if reading it throws', async () => {
    expect((await run(1, [])).job.status).toBe('done');
    mockReadSigners.mockRejectedValue(new Error('pdfsig exploded'));
    const { id, job } = await run(1, []);
    expect(job.status).toBe('done');
    expect(await docsOf(id)).toHaveLength(1);
  });
});

describe('where a doctor link came from', () => {
  async function doc() {
    const sf = await seedSourceFile({ status: 'done' });
    await seedPage(sf, { pageNumber: 1, rawText: 'text' });
    const id = uuidv4();
    await getStore().documents.create(OWNER_ID, { id, sourceFileId: sf, pageStart: 1, pageEnd: 1, title: 'Doc', docDate: '2026-01-01' });
    return id;
  }
  const doctor = (name: string) => getStore().doctors.upsert(OWNER_ID, { name }, new Date().toISOString()).then(id => id!);
  const names = async (docId: string) => (await getStore().doctors.forDocument(OWNER_ID, docId)).map(d => d.name).sort();

  it('reading the text again replaces text doctors and leaves the ones a stamp gave', async () => {
    const d = await doc(); const store = getStore();
    const fromText = await doctor('Text Person'), fromStamp = await doctor('Stamp Person');
    await store.doctors.link(OWNER_ID, d, fromText, 'referrer');
    await store.doctors.link(OWNER_ID, d, fromStamp, 'author', 'stamp');

    mockExtractFields.mockResolvedValue(extraction({ doctors: [{ name: 'Other Text', specialty: null, role: 'referrer' }] }));
    expect(await rereadDocument(OWNER_ID, d)).toBe(true);
    expect(await names(d)).toEqual(['Other Text', 'Stamp Person']);
  });

  it('a stamp takes over a link the text also made, and then survives the text being read again', async () => {
    const d = await doc(); const store = getStore();
    const both = await doctor('Both Ways');
    await store.doctors.link(OWNER_ID, d, both, 'author');
    await store.doctors.link(OWNER_ID, d, both, 'author', 'stamp');
    mockExtractFields.mockResolvedValue(extraction());
    await rereadDocument(OWNER_ID, d);
    expect(await names(d)).toEqual(['Both Ways']);
  });

  it('text arriving after a stamp does not take the link back from it', async () => {
    const d = await doc(); const store = getStore();
    const both = await doctor('Stamp First');
    await store.doctors.link(OWNER_ID, d, both, 'author', 'stamp');
    await store.doctors.link(OWNER_ID, d, both, 'author', 'text');
    await store.doctors.unlinkRead(OWNER_ID, d);
    expect(await names(d)).toEqual(['Stamp First']);
  });

  it('the owner replacing the list replaces all of it, stamps included, and what they enter counts as text', async () => {
    const d = await doc(); const store = getStore();
    await store.doctors.link(OWNER_ID, d, await doctor('Stamp One'), 'author', 'stamp');
    const res = await app.inject({ method: 'PATCH', url: `/api/documents/${d}`, headers: { cookie }, payload: { doctors: [{ name: 'Owner Entered', specialty: null, role: 'author' }] } });
    expect(res.statusCode).toBe(200);
    expect(await names(d)).toEqual(['Owner Entered']);
    await store.doctors.unlinkRead(OWNER_ID, d);
    expect(await names(d)).toEqual([]); // entered by hand is the document's own text-side data, replaced by a re-read
  });

  it('a split and a join carry where the link came from', async () => {
    const sf = await seedSourceFile({ status: 'done' });
    await seedPage(sf, { pageNumber: 1, rawText: 'one' }); await seedPage(sf, { pageNumber: 2, rawText: 'two' });
    const id = uuidv4();
    await getStore().documents.create(OWNER_ID, { id, sourceFileId: sf, pageStart: 1, pageEnd: 2, title: 'Two pages', docDate: '2026-01-01' });
    await getStore().doctors.link(OWNER_ID, id, await doctor('Signer'), 'author', 'stamp');
    mockExtractFields.mockRejectedValue(new Error('down'));
    const split = await app.inject({ method: 'POST', url: `/api/documents/${id}/boundary`, headers: { cookie }, payload: { action: 'split', at_page: 2 } });
    const [head, tail] = (split.json() as { split_into: [string, string] }).split_into;
    for (const half of [head, tail]) {
      await getStore().doctors.unlinkRead(OWNER_ID, half);
      expect(await names(half), half).toEqual(['Signer']); // still a stamp link on both halves
    }
  });
});
