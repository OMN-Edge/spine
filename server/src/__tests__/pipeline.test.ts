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
    title: 'Buletin de analize',
    doc_date: '2026-01-15',
    provider: 'Regina Maria',
    doc_type: 'lab_result',
    ai_summary: 'Lab results summary.',
    suggested_tags: ['lab'],
    doctors: [],
    measurements: [],
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
    expect(docs[0].title).toBe('Buletin de analize');
    // A new document waits in the review queue until the owner has checked it.
    expect(docs[0].reviewed).toBe(0);
  });

  it('stores a blank title as no title, so the page falls back to type and provider', async () => {
    const id = uuidv4();
    await insertSourceFile(id);
    mockRasterizePdf.mockResolvedValueOnce([makePageImage(1)]);
    mockParseDocument.mockResolvedValueOnce(makeParseResult(1));
    mockExtractFields.mockResolvedValueOnce(makeExtraction({ title: '   ' }));

    startIngestionJob(id, OWNER_ID);
    expect((await waitForJob(id)).status).toBe('done');
    expect((await documentsFor(id))[0].title).toBeNull();
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


/** The "Read with AI" button: the upload is read again by the model and replaced. */
describe('pipeline — reading an upload again with the model', () => {
  afterEach(() => resetParser(null));

  const nativeParser = {
    imageEgress: false,
    parse: async () => ({ pages: [{
      page_number: 1,
      elements: [{ type: 'Text', text: 'garbled ocr', page_number: 1, source: 'ocr' as const, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } }],
      extraction_source: 'ocr' as const, image_width: 800, image_height: 1100,
    }] }),
  };
  const modelParser = (text = 'clean text from the model') => ({
    imageEgress: true,
    parse: async () => ({ pages: [{
      page_number: 1,
      elements: [{ type: 'Text', text, page_number: 1, source: 'multimodal' as const, bbox: { x0: 80, y0: 110, x1: 400, y1: 160 } }],
      extraction_source: 'multimodal' as const, image_width: 800, image_height: 1100,
    }] }),
  });

  async function ingestOnce() {
    const id = uuidv4();
    await insertSourceFile(id);
    mockRasterizePdf.mockResolvedValue([makePageImage(1)]);
    mockCheckContinuation.mockResolvedValue({ is_continuation: false, confidence: 0.9, reasoning: 'new' });
    mockExtractFields.mockResolvedValue(makeExtraction({ suggested_tags: ['lab'] }));
    resetParser(nativeParser, modelParser());

    startIngestionJob(id, OWNER_ID);
    expect((await waitForJob(id)).status).toBe('done');
    return id;
  }

  it('replaces the documents with ones read by the model', async () => {
    const id = await ingestOnce();
    const before = await documentsFor(id);
    expect(before).toHaveLength(1);

    startIngestionJob(id, OWNER_ID, { reread: true });
    expect((await waitForJob(id)).status).toBe('done');

    const after = await documentsFor(id);
    expect(after).toHaveLength(1);
    expect(after[0].id).not.toBe(before[0].id); // a new document, not an edit of the old one
    expect(await getStore().documents.findFor(OWNER_ID, before[0].id)).toBeNull();

    const store = getStore();
    const [page] = await store.pages.listForDocument(OWNER_ID, after[0].id);
    expect(page.extraction_source).toBe('multimodal');
    expect(await store.pages.listForSourceFile(OWNER_ID, id)).toHaveLength(1); // not duplicated
    expect(await store.tags.namesForDocument(OWNER_ID, after[0].id)).toContain('lab');
  });

  it('uses the model parser, not the one the server is configured with', async () => {
    const id = await ingestOnce();
    const defaultParse = vi.spyOn(nativeParser, 'parse');
    resetParser(nativeParser, modelParser());
    defaultParse.mockClear();

    startIngestionJob(id, OWNER_ID, { reread: true });
    await waitForJob(id);

    expect(defaultParse).not.toHaveBeenCalled();
  });

  it('keeps the old documents if the new reading fails', async () => {
    const id = await ingestOnce();
    const before = await documentsFor(id);

    resetParser(nativeParser, {
      imageEgress: true, parse: async () => { throw new Error('page 1 could not be read'); },
    });
    startIngestionJob(id, OWNER_ID, { reread: true });
    expect((await waitForJob(id)).status).toBe('error');

    const after = await documentsFor(id);
    expect(after.map(d => d.id)).toEqual(before.map(d => d.id));
    expect(await getStore().fields.listForDocument(OWNER_ID, before[0].id)).not.toHaveLength(0);
  });

  it('leaves the vocabulary of tags alone', async () => {
    const id = await ingestOnce();
    const tagsBefore = (await getStore().tags.listFor(OWNER_ID)).map(t => t.name);

    startIngestionJob(id, OWNER_ID, { reread: true });
    await waitForJob(id);

    expect((await getStore().tags.listFor(OWNER_ID)).map(t => t.name)).toEqual(tagsBefore);
  });
});

/**
 * The checks and the reads wait on the model and are independent, so they run several at once.
 * What has to stay true is that an answer lands on the pair of pages it was asked about, however
 * the answers arrive, and that no more are in flight than the setting allows.
 */
describe('pipeline — model calls in parallel', () => {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const saved = process.env.SPINE_LLM_CONCURRENCY;
  afterEach(() => {
    if (saved === undefined) delete process.env.SPINE_LLM_CONCURRENCY;
    else process.env.SPINE_LLM_CONCURRENCY = saved;
  });

  it('puts each continuation answer on its own pair of pages, though they finish out of order', async () => {
    process.env.SPINE_LLM_CONCURRENCY = '4';
    const id = uuidv4();
    await insertSourceFile(id);
    const count = 12;
    mockRasterizePdf.mockResolvedValueOnce(Array.from({ length: count }, (_, i) => makePageImage(i + 1)));
    mockParseDocument.mockResolvedValueOnce(makeParseResult(count));

    // Pages 5, 9 and 10 start new documents. The answer is a function of the pair's text, and the
    // calls finish in a scrambled order, so only a correct pairing gives these documents.
    const startsNew = new Set([5, 9, 10]);
    mockCheckContinuation.mockImplementation(async (_prev: string, curr: string) => {
      const n = Number(curr.match(/page (\d+)/)![1]);
      await sleep((count - n) * 3); // later pages answer first
      return { is_continuation: !startsNew.has(n), confidence: 0.9, reasoning: `page ${n}` };
    });
    mockExtractFields.mockResolvedValue(makeExtraction());

    startIngestionJob(id, OWNER_ID);
    expect((await waitForJob(id)).status).toBe('done');

    const docs = await documentsFor(id);
    expect(docs.map(d => [d.page_start, d.page_end])).toEqual([[1, 4], [5, 8], [9, 9], [10, 12]]);
    // And each page holds the answer about itself.
    const pages = await getStore().pages.listForSourceFile(OWNER_ID, id);
    expect(pages.map(p => p.is_continuation)).toEqual([null, 1, 1, 1, 0, 1, 1, 1, 0, 0, 1, 1]);
  });

  it('never has more checks or extractions in flight than the setting, and does overlap them', async () => {
    process.env.SPINE_LLM_CONCURRENCY = '3';
    const id = uuidv4();
    await insertSourceFile(id);
    const count = 14;
    mockRasterizePdf.mockResolvedValueOnce(Array.from({ length: count }, (_, i) => makePageImage(i + 1)));
    mockParseDocument.mockResolvedValueOnce(makeParseResult(count));

    let now = 0; let peak = 0;
    const slow = async <T>(value: T): Promise<T> => {
      now += 1; peak = Math.max(peak, now);
      await sleep(8);
      now -= 1;
      return value;
    };
    // Every page is its own document, so there are 14 extractions as well as 13 checks.
    mockCheckContinuation.mockImplementation(() => slow({ is_continuation: false, confidence: 0.9, reasoning: 'new' }));
    mockExtractFields.mockImplementation(() => slow(makeExtraction()));

    startIngestionJob(id, OWNER_ID);
    expect((await waitForJob(id)).status).toBe('done');

    expect(peak).toBe(3);
    expect(await documentsFor(id)).toHaveLength(count);
  });

  it('writes nothing, and keeps the old documents of a re-read, when a model call fails', async () => {
    const id = uuidv4();
    await insertSourceFile(id);
    mockRasterizePdf.mockResolvedValueOnce([1, 2, 3].map(makePageImage));
    mockParseDocument.mockResolvedValueOnce(makeParseResult(3));
    mockCheckContinuation
      .mockResolvedValueOnce({ is_continuation: true, confidence: 0.9, reasoning: 'a' })
      .mockRejectedValueOnce(new Error('provider down'));

    startIngestionJob(id, OWNER_ID);
    const job = await waitForJob(id);

    expect(job.status).toBe('error');
    expect(job.error).toMatch(/provider down/);
    // Nothing half-written: no pages from the successful check, no documents.
    expect(await getStore().pages.listForSourceFile(OWNER_ID, id)).toEqual([]);
    expect(await documentsFor(id)).toEqual([]);
  });
});
