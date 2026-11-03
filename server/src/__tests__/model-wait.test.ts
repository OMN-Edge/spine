import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

process.env.SPINE_DB_PATH = ':memory:';

const mockRasterizePdf = vi.hoisted(() => vi.fn());
const mockParseDocument = vi.hoisted(() => vi.fn());
const mockCheckContinuation = vi.hoisted(() => vi.fn());
const mockExtractFields = vi.hoisted(() => vi.fn());

vi.mock('spine-core/ingestion/rasterize.js', () => ({ rasterizePdf: mockRasterizePdf }));
vi.mock('spine-core/ingestion/image-size.js', () => ({ getPageImageDimensions: () => ({ width: 800, height: 1100 }) }));
vi.mock('spine-core/ingestion/pdf-text.js', () => ({ parseDocument: mockParseDocument }));
vi.mock('spine-core/ingestion/continuation.js', () => ({ checkContinuation: mockCheckContinuation }));
vi.mock('spine-core/ingestion/extraction.js', () => ({ extractFields: mockExtractFields }));

import { startIngestionJob, getJobStatus } from 'spine-core/ingestion/pipeline.js';
import { getReadingJob, readUpload, resumeUnreadDocuments } from 'spine-core/ingestion/read-upload.js';
import { getStore, getAccountsStore } from 'spine-core/store/index.js';
import { seedSourceFile, createTestUser, OWNER_ID } from './helpers/seed.js';

/**
 * Reading an upload never gives up on a document because the model could not be asked (a daily limit, an outage): it waits and
 * reads it again by itself. On Nov 2 an upload's pages were kept with no text because the relay failed, and the documents made of
 * them were read as empty; a reading that failed for that reason was a failure the owner had to notice and start again.
 */
const relay = (status: number, code?: string) => Object.assign(new Error(`the model service answered ${status}`), { status, code });

const page = (n: number) => ({ page_number: n, image_path: `/tmp/wait-page-${n}.png` });
const parsed = (count: number) => ({
  pages: Array.from({ length: count }, (_, i) => ({
    page_number: i + 1,
    elements: [{ type: 'NarrativeText', text: `text for page ${i + 1}`, page_number: i + 1, bbox: { x0: 0, y0: 0, x1: 100, y1: 20 }, source: 'native_text' }],
    extraction_source: 'native_text', image_width: 800, image_height: 1100,
  })),
});
const extraction = (title: string) => ({
  title, doc_date: '2026-01-15', provider: 'Clinica Exemplu', doc_type: 'lab_result', ai_summary: 'A summary.',
  suggested_tags: [], doctors: [], measurements: [], fields: [],
});

const documentsOf = async (id: string) =>
  (await getStore().documents.listFor(OWNER_ID, { sourceFileId: id, includeUnconfirmed: true, limit: 50, offset: 0 })).sort((a, b) => a.page_start - b.page_start);

/** Two pages, two documents, as the pipeline leaves them for the owner to confirm. */
async function uploadOfTwo(): Promise<string> {
  const id = uuidv4();
  await seedSourceFile({ id });
  mockRasterizePdf.mockResolvedValueOnce([page(1), page(2)]);
  mockParseDocument.mockResolvedValueOnce(parsed(2));
  mockCheckContinuation.mockResolvedValueOnce({ is_continuation: false, confidence: 0.9, reasoning: 'new document' });
  startIngestionJob(id, OWNER_ID);
  await vi.waitFor(() => expect(getJobStatus(id)?.status).toBe('done'));
  return id;
}

beforeAll(async () => { await createTestUser(); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('an upload the model could not be asked about', () => {
  it('waits instead of failing, writes nothing, and is read again by itself when the model answers', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const id = uuidv4();
    await seedSourceFile({ id });
    mockRasterizePdf.mockResolvedValue([page(1), page(2)]);
    mockParseDocument.mockResolvedValue(parsed(2));
    mockCheckContinuation.mockRejectedValueOnce(relay(503, 'unavailable'));

    startIngestionJob(id, OWNER_ID);
    await vi.waitFor(() => expect(getJobStatus(id)?.status).toBe('pending'));

    const job = getJobStatus(id)!;
    expect(job.step).toBe('waiting for the model');
    expect(job.waiting?.reason).toBe('unavailable');
    expect((await getStore().sourceFiles.findFor(OWNER_ID, id))!.status).toBe('pending');
    expect(await getStore().pages.listForSourceFile(OWNER_ID, id)).toEqual([]);

    // A minute later the model answers.
    mockCheckContinuation.mockResolvedValueOnce({ is_continuation: true, confidence: 0.9, reasoning: 'same' });
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(getJobStatus(id)?.status).toBe('done'));
    expect(await getStore().pages.listForSourceFile(OWNER_ID, id)).toHaveLength(2);
    expect((await getStore().sourceFiles.findFor(OWNER_ID, id))!.status).toBe('done');
  });

  it('still fails for what waiting would not change', async () => {
    const id = uuidv4();
    await seedSourceFile({ id });
    mockRasterizePdf.mockResolvedValueOnce([page(1), page(2)]);
    mockParseDocument.mockResolvedValueOnce(parsed(2));
    mockCheckContinuation.mockRejectedValueOnce(relay(502, 'rejected'));
    startIngestionJob(id, OWNER_ID);
    await vi.waitFor(() => expect(getJobStatus(id)?.status).toBe('error'));
    expect((await getStore().sourceFiles.findFor(OWNER_ID, id))!.status).toBe('error');
  });
});

describe('documents the model could not be asked about', () => {
  it('are not read as empty: they stay unread, the rest are shown, and they are read when the day’s limit starts again', async () => {
    const id = await uploadOfTwo();
    vi.useFakeTimers({ shouldAdvanceTime: true, now: Date.UTC(2026, 10, 2, 6, 0) });
    mockExtractFields.mockResolvedValueOnce(extraction('First')).mockRejectedValueOnce(relay(429));

    const job = await readUpload(OWNER_ID, id, true);

    expect(job.status).toBe('waiting');
    expect(job.waiting).toEqual({ reason: 'limit', retry_at: '2026-11-03T00:05:00.000Z' });
    // The owner's confirmation stands: what was read is shown, and the other is marked as not read yet, not shown as read and empty.
    expect((await getStore().sourceFiles.findFor(OWNER_ID, id))!.grouping_confirmed).toBe(true);
    const [first, second] = await documentsOf(id);
    expect([first.title, !!first.needs_reading]).toEqual(['First', false]);
    expect([second.title, !!second.needs_reading]).toEqual([null, true]);

    mockExtractFields.mockResolvedValueOnce(extraction('Second'));
    await vi.advanceTimersByTimeAsync(18 * 60 * 60_000 + 5 * 60_000);
    await vi.waitFor(() => expect(getReadingJob(id)?.status).toBe('done'));
    expect((await documentsOf(id)).map(d => [d.title, !!d.needs_reading])).toEqual([['First', false], ['Second', false]]);
  });

  it('do not fail a reading when none could be read: it waits', async () => {
    const id = await uploadOfTwo();
    mockExtractFields.mockRejectedValue(relay(503, 'unavailable'));
    const job = await readUpload(OWNER_ID, id, true);
    expect(job.status).toBe('waiting');
    expect((await documentsOf(id)).every(d => d.needs_reading)).toBe(true);
    mockExtractFields.mockReset();
  });

  it('are read when the core starts again, for every upload whose grouping is confirmed', async () => {
    const id = await uploadOfTwo();
    mockExtractFields.mockRejectedValueOnce(relay(503, 'unavailable')).mockRejectedValueOnce(relay(503, 'unavailable'));
    await readUpload(OWNER_ID, id, true);
    const unconfirmed = await uploadOfTwo();

    expect(await getAccountsStore().maintenance.uploadsWithUnreadDocuments()).toContainEqual({ id, user_id: OWNER_ID });
    // Not one waiting for the owner to check its grouping: nothing is read before that (M-29).
    expect(await getAccountsStore().maintenance.uploadsWithUnreadDocuments()).not.toContainEqual(expect.objectContaining({ id: unconfirmed }));

    mockExtractFields.mockResolvedValue(extraction('Read at start'));
    await resumeUnreadDocuments();
    await vi.waitFor(() => expect(getReadingJob(id)?.status).toBe('done'));
    expect((await documentsOf(id)).map(d => d.title)).toEqual(['Read at start', 'Read at start']);
    mockExtractFields.mockReset();
  });
});

describe('readings of several uploads', () => {
  it('take turns, so their writes do not collide on the one connection', async () => {
    const [a, b] = [await uploadOfTwo(), await uploadOfTwo()];
    mockExtractFields.mockResolvedValue(extraction('Read'));
    const jobs = await Promise.all([readUpload(OWNER_ID, a, true), readUpload(OWNER_ID, b, true)]);
    expect(jobs.map(j => [j.status, j.error])).toEqual([['done', undefined], ['done', undefined]]);
    mockExtractFields.mockReset();
  });
});
