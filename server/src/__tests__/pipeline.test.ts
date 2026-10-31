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
const mockExtractPdfPages = vi.hoisted(() => vi.fn());

vi.mock('spine-core/ingestion/rasterize.js', () => ({
  rasterizePdf: mockRasterizePdf,
}));
vi.mock('spine-core/ingestion/image-size.js', () => ({
  getPageImageDimensions: mockGetPageImageDimensions,
}));
vi.mock('spine-core/ingestion/pdf-text.js', () => ({
  parseDocument: mockParseDocument,
}));
vi.mock('spine-core/ingestion/continuation.js', () => ({
  checkContinuation: mockCheckContinuation,
}));
vi.mock('spine-core/ingestion/extraction.js', () => ({
  extractFields: mockExtractFields,
}));
vi.mock('spine-core/archive/pdf-pages.js', () => ({
  extractPdfPages: mockExtractPdfPages,
}));

import { startIngestionJob, getJobStatus } from 'spine-core/ingestion/pipeline.js';
import { getReadingJob, isReadingUpload, readUpload } from 'spine-core/ingestion/read-upload.js';
import { getStore } from 'spine-core/store/index.js';
import { resetParser } from 'spine-core/parser/index.js';
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
    provider: 'Clinica Aurora',
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
  const all = await getStore().documents.listFor(OWNER_ID, { limit: 100, offset: 0, includeUnconfirmed: true });
  return all
    .filter(d => d.source_file_id === sourceFileId)
    .sort((a, b) => a.page_start - b.page_start);
}

async function waitForJob(id: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = getJobStatus(id);
    if (job?.status === 'done' || job?.status === 'error') {
      // The pipeline stops at the grouping; the documents are read when the owner confirms it (M-29), which is what these tests look at.
      // A one-page upload has nothing to group, so the pipeline starts reading it itself and these only wait for that.
      if (job.status === 'done') {
        if (getReadingJob(id)) { while (isReadingUpload(id)) await new Promise(r => setTimeout(r, 20)); }
        else await readUpload(OWNER_ID, id, false);
      }
      return job;
    }
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
    // One page has no grouping to check: it was read at once and its document is shown.
    expect((await getStore().sourceFiles.findFor(OWNER_ID, id))!.grouping_confirmed).toBe(true);
    expect(await getStore().documents.listFor(OWNER_ID, { sourceFileId: id, limit: 10, offset: 0 })).toHaveLength(1);

    const docs = await documentsFor(id);
    expect(docs).toHaveLength(1);
    expect(docs[0].page_start).toBe(1);
    expect(docs[0].page_end).toBe(1);
    expect(docs[0].doc_date).toBe('2026-01-15');
    expect(docs[0].provider).toBe('Clinica Aurora');
    expect(docs[0].title).toBe('Buletin de analize');
    // A new document waits in the review queue until the owner has checked it.
    expect(docs[0].reviewed).toBe(0);
  });

  it('tells the owner, in their Activity conversation, when the upload has been read', async () => {
    const id = uuidv4();
    await insertSourceFile(id);
    mockRasterizePdf.mockResolvedValueOnce([makePageImage(1)]);
    mockParseDocument.mockResolvedValueOnce(makeParseResult(1));
    mockExtractFields.mockResolvedValueOnce(makeExtraction());
    startIngestionJob(id, OWNER_ID);
    await waitForJob(id);
    await vi.waitFor(async () => {
      const notice = (await getStore().conversations.list(OWNER_ID, 50)).find(c => c.origin === 'activity');
      expect(notice).toMatchObject({ unread: true, title: 'Activity' });
    });
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


describe('pipeline — trying a failed upload again', () => {
  const failFirstThenRead = async (id: string) => {
    // The first attempt gets as far as storing the pages and the documents, and then fails (the upload is marked failed, as a
    // crash after the pages were stored would leave it). Reading the documents is the second stage and no longer part of it.
    mockRasterizePdf.mockResolvedValueOnce([makePageImage(1)]);
    mockParseDocument.mockResolvedValueOnce(makeParseResult(1));
    mockExtractFields.mockRejectedValueOnce(new Error('provider unavailable'));
    startIngestionJob(id, OWNER_ID);
    expect((await waitForJob(id)).status).toBe('done');
    await getStore().sourceFiles.setStatus(OWNER_ID, id, 'error', 'provider unavailable');
  };

  it('reads it again and replaces what the failed attempt left, without duplicating pages', async () => {
    const id = uuidv4();
    await insertSourceFile(id);
    await failFirstThenRead(id);
    expect(await getStore().pages.listForSourceFile(OWNER_ID, id)).toHaveLength(1);
    expect(await documentsFor(id)).toHaveLength(1); // made by the failed attempt, replaced by the next

    mockRasterizePdf.mockResolvedValueOnce([makePageImage(1)]);
    mockParseDocument.mockResolvedValueOnce(makeParseResult(1));
    mockExtractFields.mockResolvedValueOnce(makeExtraction());
    startIngestionJob(id, OWNER_ID, { retry: true });
    const job = await waitForJob(id);

    expect(job.status).toBe('done');
    expect(job.error).toBeUndefined();
    expect(await documentsFor(id)).toHaveLength(1);
    expect(await getStore().pages.listForSourceFile(OWNER_ID, id)).toHaveLength(1);
    expect((await getStore().sourceFiles.findFor(OWNER_ID, id))!.status).toBe('done');
  });

  it('reads it the way it was first read: the configured parser, not the model for every page', async () => {
    const id = uuidv4();
    await insertSourceFile(id);
    await failFirstThenRead(id);
    mockParseDocument.mockClear();

    mockRasterizePdf.mockResolvedValueOnce([makePageImage(1)]);
    mockParseDocument.mockResolvedValueOnce(makeParseResult(1));
    mockExtractFields.mockResolvedValueOnce(makeExtraction());
    startIngestionJob(id, OWNER_ID, { retry: true });
    expect((await waitForJob(id)).status).toBe('done');
    expect(mockParseDocument).toHaveBeenCalledTimes(1); // the sidecar, which sends nothing off the host
  });

  it('leaves what is there as it was if the second attempt fails too', async () => {
    const id = uuidv4();
    await insertSourceFile(id);
    await failFirstThenRead(id);

    mockRasterizePdf.mockResolvedValueOnce([makePageImage(1)]);
    mockParseDocument.mockRejectedValueOnce(new Error('sidecar down'));
    startIngestionJob(id, OWNER_ID, { retry: true });
    const job = await waitForJob(id);

    expect(job.status).toBe('error');
    expect(job.error).toMatch(/sidecar down/);
    expect(await getStore().pages.listForSourceFile(OWNER_ID, id)).toHaveLength(1);
    expect((await getStore().sourceFiles.findFor(OWNER_ID, id))!.status).toBe('error');
  });
});

describe('pipeline — the demo reads the first pages only (SECURITY.md M-39)', () => {
  afterEach(() => { delete process.env.SPINE_DEMO_MAX_UPLOADS; delete process.env.SPINE_DEMO_MAX_PAGES; });

  it('keeps, parses and judges no page past the limit', async () => {
    mockExtractPdfPages.mockReset();
    mockExtractPdfPages.mockResolvedValue(Buffer.from('%PDF-1.4 the first five pages'));
    process.env.SPINE_DEMO_MAX_UPLOADS = '3';
    process.env.SPINE_DEMO_MAX_PAGES = '5';
    const id = uuidv4();
    await insertSourceFile(id);
    mockRasterizePdf.mockResolvedValueOnce(Array.from({ length: 7 }, (_, i) => makePageImage(i + 1)));
    mockParseDocument.mockResolvedValueOnce(makeParseResult(7));
    mockCheckContinuation.mockReset();
    mockCheckContinuation.mockResolvedValue({ is_continuation: true, confidence: 0.9, reasoning: 'same' });
    mockExtractFields.mockResolvedValueOnce(makeExtraction());

    startIngestionJob(id, OWNER_ID);
    expect((await waitForJob(id)).status).toBe('done');
    const pages = await getStore().pages.listForSourceFile(OWNER_ID, id);
    expect(pages.map(p => p.page_number)).toEqual([1, 2, 3, 4, 5]);
    expect((await getStore().sourceFiles.findFor(OWNER_ID, id))!.page_count).toBe(5);
    // Four neighbouring pairs among five pages: none for the sixth and seventh.
    expect(mockCheckContinuation).toHaveBeenCalledTimes(4);
    expect(mockCheckContinuation.mock.calls.flat().join(' ')).not.toMatch(/page [67]/);
    // The file kept is the pages read: an export of it, and a restore, then agree on how many there are.
    const file = (await getStore().sourceFiles.findFor(OWNER_ID, id))!;
    expect(mockExtractPdfPages).toHaveBeenCalledWith(file.file_path, [1, 2, 3, 4, 5]);
  });

  it('reads every page with no limits set', async () => {
    mockExtractPdfPages.mockReset();
    const id = uuidv4();
    await insertSourceFile(id);
    mockRasterizePdf.mockResolvedValueOnce(Array.from({ length: 7 }, (_, i) => makePageImage(i + 1)));
    mockParseDocument.mockResolvedValueOnce(makeParseResult(7));
    mockCheckContinuation.mockReset();
    mockCheckContinuation.mockResolvedValue({ is_continuation: true, confidence: 0.9, reasoning: 'same' });
    mockExtractFields.mockResolvedValueOnce(makeExtraction());
    startIngestionJob(id, OWNER_ID);
    expect((await waitForJob(id)).status).toBe('done');
    expect(await getStore().pages.listForSourceFile(OWNER_ID, id)).toHaveLength(7);
    expect(mockExtractPdfPages).not.toHaveBeenCalled();
  });
});
