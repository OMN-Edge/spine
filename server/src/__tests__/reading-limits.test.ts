import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { buildTestApp } from './helpers/app.js';
import { seedPage, seedSourceFile, OWNER_ID } from './helpers/seed.js';
import { getStore } from '../store/index.js';
import { chunkPages, mergeExtractions, readDocument } from '../ingestion/document-reading.js';
import { EXTRACTION_FALLBACK } from '../llm/types.js';
import type { PageSummary } from '../store/index.js';

/**
 * What the model sees of a document, and where its answers land. The one cap on text is the
 * context window; the pages are labelled with their real numbers so a field lands on the
 * right page even for a document that starts after page 1.
 */
const mockExtractFields = vi.hoisted(() => vi.fn());
vi.mock('../ingestion/extraction.js', () => ({ extractFields: mockExtractFields }));

let app: Awaited<ReturnType<typeof buildTestApp>>;
const savedBudget = process.env.SPINE_LLM_CONTEXT_CHARS;

beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); });
// Braces: a function returned from beforeEach is run as a cleanup hook, and mockReset returns the mock.
beforeEach(() => { mockExtractFields.mockReset(); });
afterEach(() => {
  if (savedBudget === undefined) delete process.env.SPINE_LLM_CONTEXT_CHARS;
  else process.env.SPINE_LLM_CONTEXT_CHARS = savedBudget;
});

const page = (n: number, text: string): PageSummary =>
  ({ id: `p${n}`, page_number: n, source_page: n, raw_text: text, is_continuation: null, image_width: 1, image_height: 1, extraction_source: 'ocr', hidden: false, rotation: 0 });

const extraction = (title: string, fields: Array<{ label: string; page_number: number; value?: string }> = []) => ({
  title, doc_date: null, provider: null, doc_type: 'other' as const, ai_summary: `${title} summary`, suggested_tags: [title.toLowerCase()], doctors: [], measurements: [],
  fields: fields.map(f => ({ label: f.label, value: f.value ?? f.label, group: null, source_snippet: 'x', page_number: f.page_number, confidence: 1 })),
});

describe('what the model is sent', () => {
  it('is the whole document, each page under its real page number', async () => {
    const sf = await seedSourceFile({ status: 'done' });
    const pages: PageSummary[] = [];
    for (const n of [4, 5, 6]) pages.push({ ...page(n, `text of page ${n}`), id: await seedPage(sf, { pageNumber: n, rawText: `text of page ${n}` }) });
    mockExtractFields.mockResolvedValue(extraction('Doc'));

    await readDocument(OWNER_ID, uuidv4(), pages);

    expect(mockExtractFields).toHaveBeenCalledTimes(1);
    expect(mockExtractFields.mock.calls[0][0]).toBe(
      '--- page 4 ---\ntext of page 4\n\n--- page 5 ---\ntext of page 5\n\n--- page 6 ---\ntext of page 6',
    );
  });

  it('is not cut at any size under the window, even for a long document', async () => {
    const pages = Array.from({ length: 60 }, (_, i) => page(i + 1, 'x'.repeat(3000))); // 180,000 characters
    expect(chunkPages(pages, 300_000)).toHaveLength(1);
    expect(chunkPages(pages, 300_000)[0].length).toBeGreaterThan(180_000);
  });
});

describe('where a field lands', () => {
  it('on the page the model names by its marker, for a document that starts after page 1', async () => {
    const sf = await seedSourceFile({ status: 'done' });
    const ids: Record<number, string> = {};
    for (const n of [4, 5, 6]) ids[n] = await seedPage(sf, { pageNumber: n, rawText: `text ${n}` });
    const pages = [4, 5, 6].map(n => ({ ...page(n, `text ${n}`), id: ids[n] }));
    // The model says what the marker says: this value is under "--- page 5 ---".
    mockExtractFields.mockResolvedValue(extraction('Doc', [{ label: 'on five', page_number: 5 }, { label: 'on six', page_number: 6 }, { label: 'on four', page_number: 4 }]));

    const { fields } = await readDocument(OWNER_ID, uuidv4(), pages);

    const where = Object.fromEntries(fields.map(f => [f.label, Object.entries(ids).find(([, id]) => id === f.pageId)![0]]));
    expect(where).toEqual({ 'on five': '5', 'on six': '6', 'on four': '4' });
  });

  it('on the nearest page when the model names one the document does not have', async () => {
    const sf = await seedSourceFile({ status: 'done' });
    const a = await seedPage(sf, { pageNumber: 4 });
    const b = await seedPage(sf, { pageNumber: 5 });
    mockExtractFields.mockResolvedValue(extraction('Doc', [{ label: 'low', page_number: 1 }, { label: 'high', page_number: 99 }]));
    const { fields } = await readDocument(OWNER_ID, uuidv4(), [{ ...page(4, 'a'), id: a }, { ...page(5, 'b'), id: b }]);
    expect(fields.map(f => [f.label, f.pageId])).toEqual([['low', a], ['high', b]]);
  });
});

describe('a document longer than the context window', () => {
  it('is split at page boundaries into chunks that each fit, with no page lost or repeated', () => {
    const pages = Array.from({ length: 10 }, (_, i) => page(i + 1, 'x'.repeat(1000)));
    const chunks = chunkPages(pages, 3500);

    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(3500);
    expect(chunks.length).toBeGreaterThan(1);
    const markers = chunks.flatMap(c => [...c.matchAll(/--- page (\d+) ---/g)].map(m => Number(m[1])));
    expect(markers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('cuts a single page that is itself larger than the window, and only that', () => {
    const chunks = chunkPages([page(1, 'x'.repeat(50)), page(2, 'y'.repeat(10_000)), page(3, 'z'.repeat(50))], 1000);
    expect(chunks.every(c => c.length <= 1000)).toBe(true);
    expect(chunks.join('')).toContain('x'.repeat(50));
    expect(chunks.join('')).toContain('z'.repeat(50));
    expect(chunks.join('').match(/y+/)![0].length).toBeLessThan(1000);
  });

  it('is read in one call per chunk, in order, and merged', async () => {
    process.env.SPINE_LLM_CONTEXT_CHARS = '10000';
    const sf = await seedSourceFile({ status: 'done' });
    const pages: PageSummary[] = [];
    // About 4,000 characters a page: two fit in a 10,000-character window, three do not.
    for (let n = 1; n <= 6; n++) pages.push({ ...page(n, `page ${n} `.repeat(570)), id: await seedPage(sf, { pageNumber: n }) });
    mockExtractFields
      .mockResolvedValueOnce(extraction('First part', [{ label: 'a', page_number: 1 }, { label: 'shared', page_number: 3 }]))
      .mockResolvedValueOnce(extraction('Second part', [{ label: 'b', page_number: 4 }, { label: 'shared', page_number: 3 }]))
      .mockResolvedValue(extraction('Later part', [{ label: 'c', page_number: 6 }]));

    const { extraction: merged, fields } = await readDocument(OWNER_ID, uuidv4(), pages);

    expect(mockExtractFields).toHaveBeenCalledTimes(3);
    // Each call got whole pages, each page once.
    const seen = mockExtractFields.mock.calls.flatMap(c => [...(c[0] as string).matchAll(/--- page (\d+) ---/g)].map(m => Number(m[1])));
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
    // The opening of the document gives its details; fields are gathered from every part, without duplicates.
    expect(merged.title).toBe('First part');
    expect(fields.map(f => f.label).sort()).toEqual(['a', 'b', 'c', 'shared']);
  });
});

describe('merging the parts of a long document', () => {
  it('takes details from the first part, unions the tags and drops a repeated field', () => {
    const merged = mergeExtractions([
      extraction('One', [{ label: 'x', page_number: 1 }, { label: 'dup', page_number: 2 }]),
      extraction('Two', [{ label: 'dup', page_number: 2 }, { label: 'y', page_number: 5 }]),
    ]);
    expect(merged.title).toBe('One');
    expect(merged.suggested_tags.sort()).toEqual(['one', 'two']);
    expect(merged.fields.map(f => f.label)).toEqual(['x', 'dup', 'y']);
  });

  it('counts the whole document as failed if any part could not be read, rather than looking complete', () => {
    expect(mergeExtractions([extraction('One'), EXTRACTION_FALLBACK])).toBe(EXTRACTION_FALLBACK);
    expect(mergeExtractions([EXTRACTION_FALLBACK, extraction('Two')])).toBe(EXTRACTION_FALLBACK);
  });

  it('leaves a single part exactly as it was', () => {
    const one = extraction('Only');
    expect(mergeExtractions([one])).toBe(one);
  });
});

describe('documents are read in parallel, bounded by the concurrency setting', () => {
  const savedConcurrency = process.env.SPINE_LLM_CONCURRENCY;
  afterEach(() => {
    if (savedConcurrency === undefined) delete process.env.SPINE_LLM_CONCURRENCY;
    else process.env.SPINE_LLM_CONCURRENCY = savedConcurrency;
  });

  async function documents(count: number) {
    const store = getStore();
    const sf = await seedSourceFile({ status: 'done' });
    const ids: string[] = [];
    for (let n = 1; n <= count; n++) {
      await seedPage(sf, { pageNumber: n, rawText: `text ${n}` });
      const id = uuidv4(); ids.push(id);
      await store.documents.create(OWNER_ID, { id, sourceFileId: sf, pageStart: n, pageEnd: n, title: `Doc ${n}` });
    }
    return ids;
  }

  function slowModel() {
    let now = 0; let peak = 0;
    mockExtractFields.mockImplementation(async () => {
      now += 1; peak = Math.max(peak, now);
      await new Promise(r => setTimeout(r, 15));
      now -= 1;
      return extraction('Again');
    });
    return () => peak;
  }

  it('runs several at once but no more than the setting, and writes every one', async () => {
    process.env.SPINE_LLM_CONCURRENCY = '3';
    const ids = await documents(9);
    const peak = slowModel();
    const { rereadDocuments } = await import('../ingestion/document-reading.js');

    const worked = await rereadDocuments(OWNER_ID, ids);

    expect(worked.every(Boolean)).toBe(true);
    expect(peak()).toBe(3);
    for (const id of ids) expect((await getStore().documents.findFor(OWNER_ID, id))!.title).toBe('Again');
  });

  it('is one at a time when the setting is 1', async () => {
    process.env.SPINE_LLM_CONCURRENCY = '1';
    const ids = await documents(4);
    const peak = slowModel();
    const { rereadDocuments } = await import('../ingestion/document-reading.js');
    await rereadDocuments(OWNER_ID, ids);
    expect(peak()).toBe(1);
  });

  it('reports each document on its own, so one failure does not hide the others', async () => {
    const ids = await documents(3);
    mockExtractFields.mockImplementation(async (text: string) => {
      if (text.includes('text 2')) throw new Error('down for this one');
      return extraction('Again');
    });
    const { rereadDocuments } = await import('../ingestion/document-reading.js');
    expect(await rereadDocuments(OWNER_ID, ids)).toEqual([true, false, true]);
    expect((await getStore().documents.findFor(OWNER_ID, ids[1]))!.title).toBe('Doc 2');
  });
});
