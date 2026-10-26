import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { buildTestApp, loginSession } from './helpers/app.js';
import { createTestUser, seedPage, seedSourceFile, OWNER_ID } from './helpers/seed.js';
import { getStore } from 'spine-core/store/index.js';
import { planMove, type PageGroup } from 'spine-core/ingestion/move-page.js';

/**
 * Moving a page: the list work on its own, then through the route with the real store, which has to leave
 * page numbers unique, every document's range matching its pages, and what was read from a page with it.
 */
const mockExtractFields = vi.hoisted(() => vi.fn());
vi.mock('spine-core/ingestion/extraction.js', () => ({ extractFields: mockExtractFields }));

describe('planMove', () => {
  const groups = (): PageGroup[] => [
    { documentId: 'A', pageIds: ['a1', 'a2', 'a3'] },
    { documentId: 'B', pageIds: ['b1', 'b2'] },
    { documentId: 'C', pageIds: ['c1'] },
  ];
  const ids = (plan: { groups: PageGroup[] }) => plan.groups.map(g => `${g.documentId}:${g.pageIds.join(',')}`);

  it('reorders within a document, before a named page or at the end', () => {
    expect(ids(planMove(groups(), 'a3', { documentId: 'A', beforePageId: 'a1' }, 'N'))).toEqual(['A:a3,a1,a2', 'B:b1,b2', 'C:c1']);
    expect(ids(planMove(groups(), 'a1', { documentId: 'A', beforePageId: null }, 'N'))).toEqual(['A:a2,a3,a1', 'B:b1,b2', 'C:c1']);
  });

  it('moves a page into another document at a chosen place, and says where it came from and went', () => {
    const plan = planMove(groups(), 'a2', { documentId: 'B', beforePageId: 'b2' }, 'N');
    expect(ids(plan)).toEqual(['A:a1,a3', 'B:b1,a2,b2', 'C:c1']);
    expect(plan).toMatchObject({ origin: 'A', destination: 'B', emptied: null, created: null, changed: true });
  });

  it('moves a page far away, to a document that is not next to its own', () => {
    expect(ids(planMove(groups(), 'a1', { documentId: 'C', beforePageId: null }, 'N'))).toEqual(['A:a2,a3', 'B:b1,b2', 'C:c1,a1']);
  });

  it('makes a document of its own, before one or last', () => {
    const before = planMove(groups(), 'b2', { newDocument: true, beforeDocumentId: 'A' }, 'N');
    expect(ids(before)).toEqual(['N:b2', 'A:a1,a2,a3', 'B:b1', 'C:c1']);
    expect(before).toMatchObject({ created: 'N', destination: 'N' });
    expect(ids(planMove(groups(), 'a1', { newDocument: true, beforeDocumentId: null }, 'N'))).toEqual(['A:a2,a3', 'B:b1,b2', 'C:c1', 'N:a1']);
  });

  it('drops a document that lost its only page, and names it', () => {
    const plan = planMove(groups(), 'c1', { documentId: 'A', beforePageId: 'a1' }, 'N');
    expect(ids(plan)).toEqual(['A:c1,a1,a2,a3', 'B:b1,b2']);
    expect(plan).toMatchObject({ emptied: 'C', origin: 'C', destination: 'A' });
  });

  it('says nothing changed when the page ends up where it was', () => {
    expect(planMove(groups(), 'a2', { documentId: 'A', beforePageId: 'a3' }, 'N').changed).toBe(false);
    expect(planMove(groups(), 'a3', { documentId: 'A', beforePageId: null }, 'N').changed).toBe(false);
    expect(planMove(groups(), 'c1', { newDocument: true, beforeDocumentId: null }, 'N').changed).toBe(false);
  });

  it('refuses a page or a target that is not there, and a page before itself', () => {
    expect(() => planMove(groups(), 'zz', { documentId: 'A', beforePageId: null }, 'N')).toThrow(/not in this upload/);
    expect(() => planMove(groups(), 'a1', { documentId: 'Z', beforePageId: null }, 'N')).toThrow(/not in this upload/);
    expect(() => planMove(groups(), 'a1', { documentId: 'B', beforePageId: 'a2' }, 'N')).toThrow(/not in that document/);
    expect(() => planMove(groups(), 'a1', { documentId: 'A', beforePageId: 'a1' }, 'N')).toThrow(/before itself/);
    expect(() => planMove(groups(), 'a1', { newDocument: true, beforeDocumentId: 'Z' }, 'N')).toThrow(/not in this upload/);
  });

  it('does not change the groups it was given', () => {
    const original = groups();
    planMove(original, 'a1', { documentId: 'B', beforePageId: null }, 'N');
    expect(ids({ groups: original })).toEqual(['A:a1,a2,a3', 'B:b1,b2', 'C:c1']);
  });
});

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
beforeAll(async () => { app = await buildTestApp(); cookie = await loginSession(app); });
afterAll(async () => { await app.close(); });
beforeEach(() => { mockExtractFields.mockReset(); });

/** An upload of `sizes` documents, in order, with a field named after each page on that page, and tags on each document. */
async function upload(sizes: number[], userId = OWNER_ID, status: 'done' | 'processing' = 'done') {
  const store = getStore();
  const sf = await seedSourceFile({ userId, status });
  const pageIds: string[] = [];
  const docs: string[] = [];
  let n = 0;
  for (const size of sizes) {
    const doc = uuidv4();
    docs.push(doc);
    await store.documents.create(userId, { id: doc, sourceFileId: sf, pageStart: n + 1, pageEnd: n + size, title: `Doc ${docs.length}`, docType: 'other' });
    await store.documents.update(userId, doc, { reviewed: true });
    await store.tags.setForDocument(userId, doc, [`tag-${docs.length}`]);
    for (let i = 0; i < size; i++) {
      n += 1;
      const pageId = await seedPage(sf, { userId, pageNumber: n, rawText: `text of page ${n}` });
      pageIds.push(pageId);
      await store.fields.create(userId, { id: uuidv4(), documentId: doc, pageId, label: `f${n}`, value: 'v', sourceSnippet: null, bbox: null, confidence: 1 });
    }
  }
  return { sf, pageIds, docs };
}

const move = (pageId: string, payload: object, c = cookie) =>
  app.inject({ method: 'POST', url: `/api/pages/${pageId}/move`, payload, headers: { cookie: c } });
const layout = async (sf: string, userId = OWNER_ID) => {
  const store = getStore();
  const pages = await store.pages.listForSourceFile(userId, sf);
  const docs = (await store.documents.listFor(userId, { sourceFileId: sf, limit: 100, offset: 0, includeHidden: true })).sort((a, b) => a.page_start - b.page_start);
  return {
    numbers: pages.map(p => p.page_number),
    sources: pages.map(p => p.source_page),
    ranges: docs.map(d => [d.title, d.page_start, d.page_end] as const),
    docIds: docs.map(d => d.id),
    pages,
  };
};
const labels = async (doc: string) => (await getStore().fields.listForDocument(OWNER_ID, doc)).map(f => f.label).sort();

describe('POST /api/pages/:id/move', () => {
  it('reorders inside a document: numbers stay 1..n, the range stays, and the file index does not move', async () => {
    const { sf, pageIds, docs } = await upload([4]);
    const res = await move(pageIds[3], { document_id: docs[0], before_page_id: pageIds[0] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ moved: true, touched: [docs[0]], deleted: [], created: null });

    const now = await layout(sf);
    expect(now.pages.map(p => p.id)).toEqual([pageIds[3], pageIds[0], pageIds[1], pageIds[2]]);
    expect(now.numbers).toEqual([1, 2, 3, 4]);
    expect(now.sources).toEqual([4, 1, 2, 3]); // where each is in the file, unchanged
    expect(now.ranges).toEqual([['Doc 1', 1, 4]]);
  });

  it('moves a page into another document: ranges follow, its fields go with it, both documents go back to review', async () => {
    const { sf, pageIds, docs } = await upload([3, 3]);
    const res = await move(pageIds[1], { document_id: docs[1], before_page_id: pageIds[4] }); // page 2 into the second document, before page 5
    expect(res.json()).toMatchObject({ moved: true, touched: [docs[0], docs[1]], deleted: [] });

    const now = await layout(sf);
    expect(now.ranges).toEqual([['Doc 1', 1, 2], ['Doc 2', 3, 6]]);
    expect(now.pages.map(p => p.id)).toEqual([pageIds[0], pageIds[2], pageIds[3], pageIds[1], pageIds[4], pageIds[5]]);
    expect(await labels(docs[0])).toEqual(['f1', 'f3']);
    expect(await labels(docs[1])).toEqual(['f2', 'f4', 'f5', 'f6']);
    for (const d of docs) expect((await getStore().documents.findFor(OWNER_ID, d))?.reviewed).toBeFalsy();
  });

  it('moves a page to a document far from its own', async () => {
    const { sf, pageIds, docs } = await upload([2, 2, 2]);
    await move(pageIds[0], { document_id: docs[2], before_page_id: null });
    const now = await layout(sf);
    expect(now.ranges).toEqual([['Doc 1', 1, 1], ['Doc 2', 2, 3], ['Doc 3', 4, 6]]);
    expect(await labels(docs[2])).toEqual(['f1', 'f5', 'f6']);
  });

  it('makes a new document of its own where it is dropped, that waits to be read', async () => {
    const { sf, pageIds, docs } = await upload([3, 2]);
    const res = await move(pageIds[1], { new_document: true, before_document_id: docs[1] });
    const body = res.json() as { created: string; touched: string[] };
    expect(body.created).toBeTruthy();

    const now = await layout(sf);
    expect(now.ranges.map(r => [r[1], r[2]])).toEqual([[1, 2], [3, 3], [4, 5]]);
    expect(now.docIds[1]).toBe(body.created);
    expect(await labels(body.created)).toEqual(['f2']);
    const made = (await getStore().documents.findFor(OWNER_ID, body.created))!;
    expect(made.reviewed).toBeFalsy();
    expect(body.touched).toContain(body.created);
  });

  it('folds a document into where its only page went, as a join does', async () => {
    const { sf, pageIds, docs } = await upload([2, 1]);
    const res = await move(pageIds[2], { document_id: docs[0], before_page_id: pageIds[0] });
    expect(res.json()).toMatchObject({ moved: true, touched: [docs[0]], deleted: [docs[1]] });

    const now = await layout(sf);
    expect(now.ranges).toEqual([['Doc 1', 1, 3]]);
    expect(await getStore().documents.findFor(OWNER_ID, docs[1])).toBeNull();
    expect(await labels(docs[0])).toEqual(['f1', 'f2', 'f3']);
    expect(await getStore().tags.namesForDocument(OWNER_ID, docs[1])).toEqual([]);
  });

  it('does nothing, and says so, when the page would not change place', async () => {
    const { sf, pageIds, docs } = await upload([3]);
    const before = await layout(sf);
    const res = await move(pageIds[1], { document_id: docs[0], before_page_id: pageIds[2] });
    expect(res.json()).toEqual({ moved: false, touched: [], deleted: [], created: null });
    expect(await layout(sf)).toEqual(before);
    expect((await getStore().documents.findFor(OWNER_ID, docs[0]))?.reviewed).toBeTruthy(); // not sent back to review
  });

  it('keeps a hidden page hidden wherever it goes', async () => {
    const { sf, pageIds, docs } = await upload([2, 2]);
    await getStore().pages.setHidden(OWNER_ID, pageIds[0], true);
    await move(pageIds[0], { document_id: docs[1], before_page_id: null });
    const moved = (await layout(sf)).pages.find(p => p.id === pageIds[0])!;
    expect(!!moved.hidden).toBe(true);
  });

  it('refuses a bad body, a page of someone else, an unknown page, a target outside the upload, and a busy upload', async () => {
    const { pageIds, docs } = await upload([2, 2]);
    for (const bad of [{}, { document_id: 7 }, { document_id: docs[0], before_page_id: 7 }, { new_document: true, before_document_id: 7 }]) {
      expect((await move(pageIds[0], bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await move(uuidv4(), { document_id: docs[0], before_page_id: null })).statusCode).toBe(404);
    expect((await move(pageIds[0], { document_id: uuidv4(), before_page_id: null })).statusCode).toBe(400);
    expect((await move(pageIds[0], { document_id: docs[1], before_page_id: pageIds[0] })).statusCode).toBe(400);

    const other = await createTestUser('mover-else@spine.test');
    const theirs = await upload([2], other.id);
    expect((await move(theirs.pageIds[0], { document_id: theirs.docs[0], before_page_id: null })).statusCode).toBe(404);
    expect((await layout(theirs.sf, other.id)).numbers).toEqual([1, 2]);

    const busy = await upload([2], OWNER_ID, 'processing');
    expect((await move(busy.pageIds[0], { document_id: busy.docs[0], before_page_id: null })).statusCode).toBe(409);

    // A page cannot be put into a document of a different upload.
    const elsewhere = await upload([1]);
    expect((await move(pageIds[0], { document_id: elsewhere.docs[0], before_page_id: null })).statusCode).toBe(400);
    expect((await layout(elsewhere.sf)).numbers).toEqual([1]);
  });

  it('needs a signed-in user', async () => {
    const { pageIds, docs } = await upload([1]);
    expect((await app.inject({ method: 'POST', url: `/api/pages/${pageIds[0]}/move`, payload: { document_id: docs[0], before_page_id: null } })).statusCode).toBe(401);
  });

  it('keeps the search right: text moves with the page', async () => {
    const needle = `w${uuidv4().replace(/-/g, '').replace(/[0-9]/g, d => 'ghijklmnop'[Number(d)]).slice(0, 14)}`;
    const { pageIds, docs } = await upload([2, 2]);
    await getStore().pages.updateReading(OWNER_ID, pageIds[0], { rawText: `rare ${needle}`, elements: [], extractionSource: 'native_text' });
    const find = async () => ((await app.inject({ method: 'GET', url: `/api/documents?q=${needle}`, headers: { cookie } })).json() as Array<{ id: string }>).map(d => d.id);
    expect(await find()).toEqual([docs[0]]);
    await move(pageIds[0], { document_id: docs[1], before_page_id: null });
    expect(await find()).toEqual([docs[1]]);
  });
});
