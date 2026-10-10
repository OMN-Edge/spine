import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

// Set in-memory DB before any module that opens the store is imported
process.env.SPINE_DB_PATH = ':memory:';
process.env.ANTHROPIC_API_KEY = 'test';

const mockRasterizePdf = vi.hoisted(() => vi.fn());
const mockGetPageImageDimensions = vi.hoisted(() => vi.fn());
const mockParseDocument = vi.hoisted(() => vi.fn());
const mockCheckContinuation = vi.hoisted(() => vi.fn());
const mockExtractFields = vi.hoisted(() => vi.fn());

vi.mock('../ingestion/rasterize.js', () => ({
  rasterizePdf: mockRasterizePdf,
  getPageImageDimensions: mockGetPageImageDimensions,
}));
vi.mock('../ingestion/ingestion-client.js', () => ({
  parseDocument: mockParseDocument,
}));
vi.mock('../ingestion/continuation.js', () => ({
  checkContinuation: mockCheckContinuation,
}));
vi.mock('../ingestion/extraction.js', () => ({
  extractFields: mockExtractFields,
}));

import { startIngestionJob, getJobStatus } from '../ingestion/pipeline.js';
import { getStore } from '../store/index.js';
import { resetParser } from '../parser/index.js';
import { seedSourceFile, createTestUser, OWNER_ID } from './helpers/seed.js';

// Helpers
function makePageImage(n: number) {
  return { page_number: n, image_path: `/tmp/page-${n}.png` };
}

function makeParseResult(pageCount: number) {
  return {
    pages: Array.from({ length: pageCount }, (_, i) => ({
      page_number: i + 1,
      elements: [{ type: 'NarrativeText', text: `text for page ${i + 1}`, page_number: i + 1, bbox: { x0: 0, y0: 0, x1: 100, y1: 20 }, source: 'native_text' }],
      extraction_source: 'native_text',
      image_width: 800,
      image_height: 1100,
    })),
  };
}

function makeExtraction(overrides = {}) {
  return {
    doc_date: '2026-01-15',
    provider: 'Regina Maria',
    doc_type: 'lab_result',
    ai_summary: 'Lab results summary.',
    suggested_tags: ['lab'],
    fields: [{ label: 'haemoglobin', value: '13.5', source_snippet: 'text for page 1', page_number: 1, confidence: 0.9 }],
    ...overrides,
  };
}

async function insertSourceFile(id: string) {
  await seedSourceFile({ id });
}

/** Documents produced for one upload, in page order. */
async function documentsFor(sourceFileId: string) {
  const all = await getStore().documents.listFor(OWNER_ID, { limit: 100, offset: 0 });
  return all
    .filter(d => d.source_file_id === sourceFileId)
    .sort((a, b) => a.page_start - b.page_start);
}

async function waitForJob(id: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = getJobStatus(id);
    if (job?.status === 'done' || job?.status === 'error') return job;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('Job timed out');
}

beforeAll(async () => {
  mockGetPageImageDimensions.mockReturnValue({ width: 800, height: 1100 });
  // Rows reference their owner, so the account has to exist first.
  await createTestUser();
});

describe('pipeline — single page document', () => {
  it('creates one document from one page', async () => {
    const id = uuidv4();
    await insertSourceFile(id);

    mockRasterizePdf.mockResolvedValueOnce([makePageImage(1)]);
    mockParseDocument.mockResolvedValueOnce(makeParseResult(1));
    mockExtractFields.mockResolvedValueOnce(makeExtraction());

    startIngestionJob(id, OWNER_ID);
    const job = await waitForJob(id);

    expect(job.status).toBe('done');

    const docs = await documentsFor(id);
    expect(docs).toHaveLength(1);
    expect(docs[0].page_start).toBe(1);
    expect(docs[0].page_end).toBe(1);
    expect(docs[0].doc_date).toBe('2026-01-15');
    expect(docs[0].provider).toBe('Regina Maria');
  });
});

describe('pipeline — multi-page merged PDF', () => {
  it('groups continuation pages into one document', async () => {
    const id = uuidv4();
    await insertSourceFile(id);

    mockRasterizePdf.mockResolvedValueOnce([1, 2, 3].map(makePageImage));
    mockParseDocument.mockResolvedValueOnce(makeParseResult(3));
    // Page 2 and 3 are continuations of page 1
    mockCheckContinuation
      .mockResolvedValueOnce({ is_continuation: true, confidence: 0.95, reasoning: 'Same doc' })
      .mockResolvedValueOnce({ is_continuation: true, confidence: 0.92, reasoning: 'Same doc' });
    mockExtractFields.mockResolvedValueOnce(makeExtraction());

    startIngestionJob(id, OWNER_ID);
    const job = await waitForJob(id);

    expect(job.status).toBe('done');

    const docs = await documentsFor(id);
    expect(docs).toHaveLength(1);
    expect(docs[0].page_start).toBe(1);
    expect(docs[0].page_end).toBe(3);
  });

  it('splits at a non-continuation page boundary', async () => {
    const id = uuidv4();
    await insertSourceFile(id);

    mockRasterizePdf.mockResolvedValueOnce([1, 2, 3, 4].map(makePageImage));
    mockParseDocument.mockResolvedValueOnce(makeParseResult(4));
    mockCheckContinuation
      .mockResolvedValueOnce({ is_continuation: true,  confidence: 0.9,  reasoning: 'continues' })
      .mockResolvedValueOnce({ is_continuation: false, confidence: 0.97, reasoning: 'new doc' })
      .mockResolvedValueOnce({ is_continuation: true,  confidence: 0.88, reasoning: 'continues' });
    mockExtractFields
      .mockResolvedValueOnce(makeExtraction({ doc_date: '2026-01-10' }))
      .mockResolvedValueOnce(makeExtraction({ doc_date: '2026-02-05' }));

    startIngestionJob(id, OWNER_ID);
    const job = await waitForJob(id);

    expect(job.status).toBe('done');

    const docs = await documentsFor(id);
    expect(docs).toHaveLength(2);
    expect(docs[0].page_start).toBe(1);
    expect(docs[0].page_end).toBe(2);
    expect(docs[1].page_start).toBe(3);
    expect(docs[1].page_end).toBe(4);
  });
});

describe('pipeline — extracted fields and grounding', () => {
  it('stores extracted fields with bboxes', async () => {
    const id = uuidv4();
    await insertSourceFile(id);

    mockRasterizePdf.mockResolvedValueOnce([makePageImage(1)]);
    mockParseDocument.mockResolvedValueOnce(makeParseResult(1));
    mockExtractFields.mockResolvedValueOnce(makeExtraction());

    startIngestionJob(id, OWNER_ID);
    await waitForJob(id);

    const doc = (await documentsFor(id))[0];
    const fields = await getStore().fields.listForDocument(OWNER_ID, doc.id);

    expect(fields).toHaveLength(1);
    expect(fields[0].label).toBe('haemoglobin');
    expect(fields[0].value).toBe('13.5');
    // Grounded — bbox should be non-null (source_snippet matches the element text)
    expect(fields[0].bbox_x0).not.toBeNull();
  });

  it('seeds tags and links them to the document', async () => {
    const id = uuidv4();
    await insertSourceFile(id);

    mockRasterizePdf.mockResolvedValueOnce([makePageImage(1)]);
    mockParseDocument.mockResolvedValueOnce(makeParseResult(1));
    mockExtractFields.mockResolvedValueOnce(makeExtraction({ suggested_tags: ['lab', 'follow-up-needed'] }));

    startIngestionJob(id, OWNER_ID);
    await waitForJob(id);

    const doc = (await documentsFor(id))[0];
    const tags = await getStore().tags.namesForDocument(OWNER_ID, doc.id);

    expect(tags).toContain('lab');
    expect(tags).toContain('follow-up-needed');
  });
});

describe('pipeline — error handling', () => {
  it('marks source_file as error when rasterize fails', async () => {
    const id = uuidv4();
    await insertSourceFile(id);

    mockRasterizePdf.mockRejectedValueOnce(new Error('pdftoppm not found'));

    startIngestionJob(id, OWNER_ID);
    const job = await waitForJob(id);

    expect(job.status).toBe('error');
    expect(job.error).toMatch(/pdftoppm/);

    const row = await getStore().sourceFiles.findFor(OWNER_ID, id);
    expect(row?.status).toBe('error');
    expect(row?.error_message).toMatch(/pdftoppm/);
  });

  it('does not start a second job if one is already running', async () => {
    const id = uuidv4();
    await insertSourceFile(id);

    // Don't resolve so the job stays 'processing'
    mockRasterizePdf.mockReturnValueOnce(new Promise(() => {}));

    startIngestionJob(id, OWNER_ID);
    const firstJob = getJobStatus(id);

    // Calling again should be a no-op
    startIngestionJob(id, OWNER_ID);
    const secondJob = getJobStatus(id);

    expect(firstJob).toBe(secondJob);
  });
});


describe('pipeline — the parser interface', () => {
  afterEach(() => resetParser(null));

  it('keeps every page pointing at its own image when the sidecar leaves a blank page out', async () => {
    const id = uuidv4();
    await insertSourceFile(id);

    mockRasterizePdf.mockResolvedValueOnce([1, 2, 3].map(makePageImage));
    // The sidecar omits page 2 because it has no elements.
    const parsed = makeParseResult(3);
    mockParseDocument.mockResolvedValueOnce({ pages: [parsed.pages[0], parsed.pages[2]] });
    mockCheckContinuation.mockResolvedValue({ is_continuation: false, confidence: 0.9, reasoning: 'new' });
    mockExtractFields.mockResolvedValue(makeExtraction());

    startIngestionJob(id, OWNER_ID);
    expect((await waitForJob(id)).status).toBe('done');

    const store = getStore();
    const pages = await store.pages.listForSourceFile(OWNER_ID, id);
    expect(pages.map(page => page.page_number)).toEqual([1, 2, 3]);

    // Page 3's text sits on page 3's image, not shifted onto page 2's.
    const imageOf = async (n: number) =>
      store.pages.findImagePathFor(OWNER_ID, pages.find(page => page.page_number === n)!.id);
    expect(await imageOf(2)).toBe('/tmp/page-2.png');
    expect(await imageOf(3)).toBe('/tmp/page-3.png');
    expect(pages.find(page => page.page_number === 2)!.raw_text).toBe('');
    expect(pages.find(page => page.page_number === 3)!.raw_text).toBe('text for page 3');
  });

  it('stores a model-read page as multimodal and highlights its field from the model’s box', async () => {
    const id = uuidv4();
    await insertSourceFile(id);
    mockRasterizePdf.mockResolvedValueOnce([makePageImage(1)]);
    mockExtractFields.mockResolvedValueOnce(makeExtraction({
      fields: [{
        label: 'diagnosis', value: 'iron deficiency anaemia',
        source_snippet: 'anemie feripriva', page_number: 1, confidence: 0.8,
      }],
    }));

    // A parser that read the page with a model: a box 20%–60% across, 20%–25% down.
    resetParser({
      imageEgress: true,
      parse: async () => ({ pages: [{
        page_number: 1,
        elements: [{
          type: 'Text', text: 'Diagnostic: anemie feripriva', page_number: 1, source: 'multimodal',
          bbox: { x0: 160, y0: 220, x1: 480, y1: 275 },
        }],
        extraction_source: 'multimodal', image_width: 800, image_height: 1100,
      }] }),
    });

    startIngestionJob(id, OWNER_ID);
    expect((await waitForJob(id)).status).toBe('done');

    const store = getStore();
    const doc = (await documentsFor(id))[0];

    const [page] = await store.pages.listForDocument(OWNER_ID, doc.id);
    expect(page.extraction_source).toBe('multimodal');

    const [field] = await store.fields.listForDocument(OWNER_ID, doc.id);
    expect(field.bbox_x0).toBeCloseTo(0.2);
    expect(field.bbox_y0).toBeCloseTo(0.2);
    expect(field.bbox_x1).toBeCloseTo(0.6);
    expect(field.bbox_y1).toBeCloseTo(0.25);
  });

  it('marks the upload as failed, with the reason, when the parser throws', async () => {
    const id = uuidv4();
    await insertSourceFile(id);
    mockRasterizePdf.mockResolvedValueOnce([makePageImage(1)]);
    resetParser({ imageEgress: true, parse: async () => { throw new Error('page 1 could not be read'); } });

    startIngestionJob(id, OWNER_ID);
    expect((await waitForJob(id)).status).toBe('error');

    const row = await getStore().sourceFiles.findFor(OWNER_ID, id);
    expect(row?.error_message).toMatch(/page 1 could not be read/);
  });
});
