import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { buildTestApp, loginAs, loginSession } from './helpers/app.js';
import { createTestUser, seedPage, seedSourceFile, OWNER_ID } from './helpers/seed.js';
import { getStore } from '../store/index.js';
import { EXTRACTION_FALLBACK } from '../llm/types.js';

/**
 * Regrouping an upload's pages: split and join, the reading that follows, and the two
 * routes the regrouping screen uses. The model is mocked; everything else is real.
 */
const mockExtractFields = vi.hoisted(() => vi.fn());
vi.mock('../ingestion/extraction.js', () => ({ extractFields: mockExtractFields }));

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;

beforeAll(async () => {
  app = await buildTestApp();
  cookie = await loginSession(app);
});
afterAll(async () => { await app.close(); });
// Braces matter: a function returned from beforeEach is run as a cleanup hook, and
// mockReset returns the mock itself.
beforeEach(() => { mockExtractFields.mockReset(); });

const reading = (title: string, fieldPage = 1) => ({
  title, doc_date: '2026-05-01', provider: 'Synevo', doc_type: 'lab_result' as const,
  ai_summary: `${title} summary`, suggested_tags: ['lab'], doctors: [], measurements: [],
  fields: [{ label: 'value', value: title, source_snippet: 'x', page_number: fieldPage, confidence: 0.9 }],
});

/** An upload of `pages` pages, as one document covering them all, with a field on each page. */
async function upload(pages: number, userId = OWNER_ID) {
  const store = getStore();
  const sf = await seedSourceFile({ userId, status: 'done' });
  const pageIds: string[] = [];
  for (let n = 1; n <= pages; n++) pageIds.push(await seedPage(sf, { userId, pageNumber: n, rawText: `text of page ${n}` }));
  const doc = uuidv4();
  await store.documents.create(userId, { id: doc, sourceFileId: sf, pageStart: 1, pageEnd: pages, title: 'Original', docType: 'lab_result' });
  await store.tags.setForDocument(userId, doc, ['chronic']);
  for (const [i, pageId] of pageIds.entries()) {
    await store.fields.create(userId, { id: uuidv4(), documentId: doc, pageId, label: `p${i + 1}`, value: 'v', sourceSnippet: null, bbox: null, confidence: 1 });
  }
  return { sf, doc, pageIds };
}

const post = (url: string, payload: object, c = cookie) => app.inject({ method: 'POST', url, payload, headers: { cookie: c } });
const labels = async (doc: string) => (await getStore().fields.listForDocument(OWNER_ID, doc)).map(f => f.label).sort();

describe('splitting a document', () => {
  it('creates the tail, moves its fields with their pages, and reads both again', async () => {
    const { doc } = await upload(4);
    mockExtractFields.mockResolvedValueOnce(reading('Head')).mockResolvedValueOnce(reading('Tail'));

    const res = await post(`/api/documents/${doc}/boundary`, { action: 'split', at_page: 3 });
    expect(res.statusCode).toBe(200);
    const { split_into, reread } = res.json() as { split_into: [string, string]; reread: string };
    expect(reread).toBe('done');

    const store = getStore();
    const [head, tail] = await Promise.all(split_into.map(id => store.documents.findFor(OWNER_ID, id)));
    expect([head!.page_start, head!.page_end, tail!.page_start, tail!.page_end]).toEqual([1, 2, 3, 4]);
    expect([head!.title, tail!.title]).toEqual(['Head', 'Tail']);
    expect([head!.reviewed, tail!.reviewed]).toEqual([0, 0]);

    // Each was read from its own pages' text only.
    expect(mockExtractFields.mock.calls[0][0]).toContain('text of page 2');
    expect(mockExtractFields.mock.calls[0][0]).not.toContain('text of page 3');
    expect(mockExtractFields.mock.calls[1][0]).toContain('text of page 3');
    expect(mockExtractFields.mock.calls[1][0]).not.toContain('text of page 2');
  });

  it('keeps the new grouping, and the old reading, when the model cannot be reached', async () => {
    const { doc } = await upload(4);
    mockExtractFields.mockRejectedValue(new Error('provider down'));

    const res = await post(`/api/documents/${doc}/boundary`, { action: 'split', at_page: 3 });
    expect(res.statusCode).toBe(200);
    const { split_into, reread } = res.json() as { split_into: [string, string]; reread: string };
    expect(reread).toBe('failed');

    const store = getStore();
    const head = (await store.documents.findFor(OWNER_ID, split_into[0]))!;
    const tail = (await store.documents.findFor(OWNER_ID, split_into[1]))!;
    expect([head.page_end, tail.page_start]).toEqual([2, 3]);
    expect(head.title).toBe('Original');
    expect(tail.doc_type).toBe('lab_result'); // carried over until it can be read
    expect(await labels(split_into[0])).toEqual(['p1', 'p2']);
    expect(await labels(split_into[1])).toEqual(['p3', 'p4']);
    expect(await store.tags.namesForDocument(OWNER_ID, split_into[1])).toEqual(['chronic']);
  });

  it('does not write "extraction failed" over a document when the answer fails validation', async () => {
    const { doc } = await upload(2);
    mockExtractFields.mockResolvedValue(EXTRACTION_FALLBACK);
    const res = await post(`/api/documents/${doc}/boundary`, { action: 'split', at_page: 2 });
    expect((res.json() as { reread: string }).reread).toBe('failed');
    expect((await getStore().documents.findFor(OWNER_ID, doc))!.title).toBe('Original');
  });

  it('refuses a split outside the document', async () => {
    const { doc } = await upload(3);
    for (const at_page of [1, 4, 0, '2']) {
      expect((await post(`/api/documents/${doc}/boundary`, { action: 'split', at_page })).statusCode).toBe(400);
    }
  });
});

describe('joining documents', () => {
  async function twoDocuments() {
    const { sf, doc } = await upload(4);
    mockExtractFields.mockResolvedValueOnce(reading('A')).mockResolvedValueOnce(reading('B'));
    const { split_into } = (await post(`/api/documents/${doc}/boundary`, { action: 'split', at_page: 3 })).json() as { split_into: [string, string] };
    mockExtractFields.mockReset();
    return { sf, first: split_into[0], second: split_into[1] };
  }

  it('joins a document with the one after it, keeps all fields, and reads it again', async () => {
    const { first, second } = await twoDocuments();
    mockExtractFields.mockResolvedValueOnce(reading('Whole', 1));

    const res = await post(`/api/documents/${first}/boundary`, { action: 'merge', with_document_id: second });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { reread: string }).reread).toBe('done');

    const store = getStore();
    const merged = (await store.documents.findFor(OWNER_ID, first))!;
    expect([merged.page_start, merged.page_end, merged.title, merged.reviewed]).toEqual([1, 4, 'Whole', 0]);
    expect(await store.documents.findFor(OWNER_ID, second)).toBeNull();
    // Read again from all four pages.
    for (const n of [1, 2, 3, 4]) expect(mockExtractFields.mock.calls[0][0]).toContain(`text of page ${n}`);
  });

  it('keeps the joined fields when reading fails', async () => {
    const { first, second } = await twoDocuments();
    mockExtractFields.mockRejectedValue(new Error('down'));
    await post(`/api/documents/${first}/boundary`, { action: 'merge', with_document_id: second });
    // The re-read of A replaced its fields with A's reading (one field); B's re-read gave one more.
    expect((await labels(first)).length).toBe(2);
  });

  it('refuses to join backwards, with a gap, or across uploads', async () => {
    const { first, second } = await twoDocuments();
    expect((await post(`/api/documents/${second}/boundary`, { action: 'merge', with_document_id: first })).statusCode).toBe(400);

    const other = await upload(2);
    expect((await post(`/api/documents/${first}/boundary`, { action: 'merge', with_document_id: other.doc })).statusCode).toBe(400);
    expect(mockExtractFields).not.toHaveBeenCalled();
    // Nothing changed.
    expect((await getStore().documents.findFor(OWNER_ID, first))!.page_end).toBe(2);
  });

  it('cannot touch another user’s document', async () => {
    const intruder = await createTestUser('intruder@spine.test');
    const theirs = await upload(2, intruder.id);
    const mine = await upload(2);
    const res = await post(`/api/documents/${mine.doc}/boundary`, { action: 'merge', with_document_id: theirs.doc });
    expect(res.statusCode).toBe(404);

    const intruderCookie = await loginAs(app, 'intruder@spine.test');
    expect((await post(`/api/documents/${mine.doc}/boundary`, { action: 'split', at_page: 2 }, intruderCookie)).statusCode).toBe(404);
  });
});

/** What the review queue shows: the same query the page makes. */
const queue = async () =>
  ((await app.inject({ method: 'GET', url: '/api/documents?reviewed=false&limit=500', headers: { cookie } })).json() as Array<{ id: string }>).map(d => d.id);

describe('what lands in the review queue', () => {
  it('a document that was already reviewed comes back to the queue when it is split or joined', async () => {
    const { doc } = await upload(4);
    await getStore().documents.update(OWNER_ID, doc, { reviewed: true });
    expect(await queue()).not.toContain(doc);

    mockExtractFields.mockResolvedValue(reading('Part'));
    const { split_into } = (await post(`/api/documents/${doc}/boundary`, { action: 'split', at_page: 3 })).json() as { split_into: [string, string] };
    expect(await queue()).toEqual(expect.arrayContaining(split_into));

    // Review both, then join: only the joined document is in the queue, and the removed one is gone.
    for (const id of split_into) await getStore().documents.update(OWNER_ID, id, { reviewed: true });
    expect(await queue()).not.toEqual(expect.arrayContaining(split_into));
    await post(`/api/documents/${split_into[0]}/boundary`, { action: 'merge', with_document_id: split_into[1] });
    const after = await queue();
    expect(after).toContain(split_into[0]);
    expect(after).not.toContain(split_into[1]);
  });

  it('is still in the queue when reading fails, since the grouping changed', async () => {
    const { doc } = await upload(3);
    await getStore().documents.update(OWNER_ID, doc, { reviewed: true });
    mockExtractFields.mockRejectedValue(new Error('down'));
    const { split_into } = (await post(`/api/documents/${doc}/boundary`, { action: 'split', at_page: 2 })).json() as { split_into: [string, string] };
    expect(await queue()).toEqual(expect.arrayContaining(split_into));
  });

  it('a joined document is in the queue even when reading it again fails', async () => {
    const { doc } = await upload(4);
    mockExtractFields.mockResolvedValue(reading('Part'));
    const { split_into } = (await post(`/api/documents/${doc}/boundary`, { action: 'split', at_page: 3 })).json() as { split_into: [string, string] };
    for (const id of split_into) await getStore().documents.update(OWNER_ID, id, { reviewed: true });

    mockExtractFields.mockReset();
    mockExtractFields.mockRejectedValue(new Error('down'));
    const res = await post(`/api/documents/${split_into[0]}/boundary`, { action: 'merge', with_document_id: split_into[1] });
    expect((res.json() as { reread: string }).reread).toBe('failed');
    expect(await queue()).toContain(split_into[0]);
  });

  it('shows all of a large upload’s documents, past the default page size', async () => {
    const store = getStore();
    const sf = await seedSourceFile({ status: 'done' });
    const ids: string[] = [];
    await store.transaction(async tx => {
      for (let i = 1; i <= 120; i++) {
        const id = uuidv4(); ids.push(id);
        await tx.documents.create(OWNER_ID, { id, sourceFileId: sf, pageStart: i, pageEnd: i });
      }
    });
    const shown = await queue();
    for (const id of ids) expect(shown).toContain(id);
  });
});

describe('the regrouping screen’s data', () => {
  it('lists every upload newest first, with its documents in page order', async () => {
    const store = getStore();
    const older = await seedSourceFile({ status: 'done' });
    const newer = await seedSourceFile({ status: 'done' });
    await store.documents.create(OWNER_ID, { id: uuidv4(), sourceFileId: newer, pageStart: 2, pageEnd: 2, title: 'Second' });
    await store.documents.create(OWNER_ID, { id: uuidv4(), sourceFileId: newer, pageStart: 1, pageEnd: 1, title: 'First' });

    const res = await app.inject({ method: 'GET', url: '/api/source-files', headers: { cookie } });
    const list = res.json() as Array<{ id: string; uploaded_at: string; documents: Array<{ title: string }> }>;
    const row = list.find(u => u.id === newer)!;
    expect(row.documents.map(d => d.title)).toEqual(['First', 'Second']);
    expect(list.find(u => u.id === older)!.documents).toEqual([]);
    const times = list.map(u => u.uploaded_at);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('gives one upload’s pages and grouping, without server paths or page text', async () => {
    const { sf, pageIds } = await upload(3);
    const res = await app.inject({ method: 'GET', url: `/api/source-files/${sf}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { pages: Array<Record<string, unknown>>; documents: Array<{ page_start: number; page_end: number }> };
    expect(body.pages.map(p => p.id)).toEqual(pageIds);
    expect(body.documents).toHaveLength(1);
    expect(body.documents[0]).toMatchObject({ page_start: 1, page_end: 3 });
    expect(res.body).not.toContain('/tmp/');
    expect(res.body).not.toContain('text of page');
    expect(body.pages[0]).toHaveProperty('image_width');
  });

  it('is not found for someone else’s upload', async () => {
    const intruder = await createTestUser(`other-${uuidv4()}@spine.test`);
    const theirs = await upload(1, intruder.id);
    const res = await app.inject({ method: 'GET', url: `/api/source-files/${theirs.sf}`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });
});

describe('moving fields (store)', () => {
  it('never moves a merged document’s fields into a document that is not the user’s', async () => {
    const mine = await upload(2);
    const intruder = await createTestUser(`merge-victim-${uuidv4()}@spine.test`);
    const theirs = await upload(1, intruder.id);
    await getStore().fields.reassignDocument(OWNER_ID, mine.doc, theirs.doc);
    expect(await labels(mine.doc)).toEqual(['p1', 'p2']);
  });

  it('never moves fields into a document that is not the user’s', async () => {
    const mine = await upload(2);
    const intruder = await createTestUser(`victim-${uuidv4()}@spine.test`);
    const theirs = await upload(1, intruder.id);
    await getStore().fields.reassignFromPage(OWNER_ID, mine.doc, theirs.doc, 1);
    expect(await labels(mine.doc)).toEqual(['p1', 'p2']);
  });
});

describe('reading a document again (rereadDocument)', () => {
  it('puts a reviewed document back to unreviewed, since what it holds changed', async () => {
    const { doc } = await upload(1);
    await getStore().documents.update(OWNER_ID, doc, { reviewed: true });
    const { rereadDocument } = await import('../ingestion/document-reading.js');
    mockExtractFields.mockResolvedValueOnce(reading('Again'));
    expect(await rereadDocument(OWNER_ID, doc)).toBe(true);
    const after = (await getStore().documents.findFor(OWNER_ID, doc))!;
    expect([after.title, after.reviewed]).toEqual(['Again', 0]);
  });

  it('keeps the owner’s notes', async () => {
    const { doc } = await upload(1);
    await getStore().documents.update(OWNER_ID, doc, { user_notes: 'ask about this' });
    const { rereadDocument } = await import('../ingestion/document-reading.js');
    mockExtractFields.mockResolvedValueOnce(reading('Again'));
    await rereadDocument(OWNER_ID, doc);
    expect((await getStore().documents.findFor(OWNER_ID, doc))!.user_notes).toBe('ask about this');
  });
});
