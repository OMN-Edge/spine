import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { buildTestApp, loginSession } from './helpers/app.js';
import { createTestUser, seedPage, seedSourceFile, OWNER_ID } from './helpers/seed.js';
import { createStore, getStore } from 'spine-core/store/index.js';
import { rereadDocument } from 'spine-core/ingestion/document-reading.js';

/**
 * Setting a page aside: it stays in the upload, with its image and text, but leaves the document's
 * view, the search and the next reading, and the documents that hold it go back to review. A database
 * made before the column existed is brought forward when it is opened.
 */
const mockExtractFields = vi.hoisted(() => vi.fn());
vi.mock('spine-core/ingestion/extraction.js', () => ({ extractFields: mockExtractFields }));

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
beforeAll(async () => { app = await buildTestApp(); cookie = await loginSession(app); });
afterAll(async () => { await app.close(); });
beforeEach(() => { mockExtractFields.mockReset(); });

const word = () => `w${uuidv4().replace(/[^a-z]/g, '').slice(0, 10)}`;

async function upload(texts: string[], userId = OWNER_ID) {
  const sf = await seedSourceFile({ userId, status: 'done' });
  const pageIds: string[] = [];
  for (const [i, rawText] of texts.entries()) pageIds.push(await seedPage(sf, { userId, pageNumber: i + 1, rawText }));
  const doc = uuidv4();
  await getStore().documents.create(userId, { id: doc, sourceFileId: sf, pageStart: 1, pageEnd: texts.length, title: 'Report', docDate: '2026-01-01', aiSummary: 'A summary.' });
  await getStore().documents.update(userId, doc, { reviewed: true });
  return { sf, doc, pageIds };
}

const hide = (pageId: string, hidden: unknown, c = cookie) =>
  app.inject({ method: 'PATCH', url: `/api/pages/${pageId}`, payload: { hidden }, headers: { cookie: c } });
const search = async (q: string) =>
  ((await app.inject({ method: 'GET', url: `/api/documents?q=${q}`, headers: { cookie } })).json() as Array<{ id: string }>).map(d => d.id);

describe('PATCH /api/pages/:id', () => {
  it('hides a page: out of the document’s pages and the search, and the document back to review', async () => {
    const [keep, drop] = [word(), word()];
    const { doc, pageIds } = await upload([`first page ${keep}`, `second page ${drop}`]);
    expect(await search(drop)).toContain(doc);

    const res = await hide(pageIds[1], true);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hidden: true, document_ids: [doc] });

    const pages = (await app.inject({ method: 'GET', url: `/api/documents/${doc}`, headers: { cookie } })).json().pages as Array<{ id: string }>;
    expect(pages.map(p => p.id)).toEqual([pageIds[0]]);
    expect(await search(drop)).not.toContain(doc);
    expect(await search(keep)).toContain(doc);
    expect((await getStore().documents.findFor(OWNER_ID, doc))?.reviewed).toBeFalsy();
  });

  it('keeps the page in the upload, so it can be shown again, and the search finds it again', async () => {
    const drop = word();
    const { doc, sf, pageIds } = await upload(['one', `two ${drop}`]);
    await hide(pageIds[1], true);

    const kept = await getStore().pages.listForSourceFile(OWNER_ID, sf);
    expect(kept).toHaveLength(2);
    expect(kept.find(p => p.id === pageIds[1])?.hidden).toBeTruthy();

    expect((await hide(pageIds[1], false)).statusCode).toBe(200);
    expect(await search(drop)).toContain(doc);
    expect((await app.inject({ method: 'GET', url: `/api/documents/${doc}`, headers: { cookie } })).json().pages).toHaveLength(2);
  });

  it('shows the page as hidden on the regrouping screen', async () => {
    const { sf, pageIds } = await upload(['one', 'two']);
    await hide(pageIds[0], true);
    const layout = (await app.inject({ method: 'GET', url: `/api/source-files/${sf}`, headers: { cookie } })).json();
    expect(layout.pages.map((p: { hidden: boolean }) => p.hidden)).toEqual([true, false]);
  });

  it('leaves a hidden page out of the next reading', async () => {
    const { doc, pageIds } = await upload(['visible text', 'secret hidden text']);
    await hide(pageIds[1], true);
    mockExtractFields.mockResolvedValue({
      title: 'T', doc_date: null, provider: null, doc_type: 'other', ai_summary: 's', suggested_tags: [], doctors: [], measurements: [], fields: [],
    });

    await rereadDocument(OWNER_ID, doc);
    const sent = String(mockExtractFields.mock.calls[0]?.[0]);
    expect(sent).toContain('visible text');
    expect(sent).not.toContain('secret hidden text');
  });

  it('answers 404 for another user’s page, and changes nothing', async () => {
    const other = await createTestUser('hider-else@spine.test');
    const theirs = await upload(['theirs'], other.id);
    expect((await hide(theirs.pageIds[0], true)).statusCode).toBe(404);
    expect((await getStore().pages.listForSourceFile(other.id, theirs.sf))[0].hidden).toBeFalsy();
    expect((await hide(uuidv4(), true)).statusCode).toBe(404);
  });

  it('refuses a body that is not true or false', async () => {
    const { pageIds } = await upload(['one']);
    for (const bad of [undefined, 'yes', 1, null]) expect((await hide(pageIds[0], bad)).statusCode).toBe(400);
  });

  it('needs a signed-in user', async () => {
    const { pageIds } = await upload(['one']);
    expect((await app.inject({ method: 'PATCH', url: `/api/pages/${pageIds[0]}`, payload: { hidden: true } })).statusCode).toBe(401);
  });
});

describe('PATCH /api/documents/:id/hidden', () => {
  const setAside = (id: string, hidden: unknown, c = cookie) =>
    app.inject({ method: 'PATCH', url: `/api/documents/${id}/hidden`, payload: { hidden }, headers: { cookie: c } });
  const timeline = async () =>
    ((await app.inject({ method: 'GET', url: '/api/documents', headers: { cookie } })).json() as Array<{ id: string }>).map(d => d.id);

  it('hides every page of a document however many it has, and leaves the timeline and search', async () => {
    const needle = word();
    const { doc, sf } = await upload(['one', `two ${needle}`, 'three', 'four']);
    expect(await timeline()).toContain(doc);

    const res = await setAside(doc, true);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hidden: true, document_ids: [doc] });
    expect((await getStore().pages.listForSourceFile(OWNER_ID, sf)).map(p => !!p.hidden)).toEqual([true, true, true, true]);
    expect(await timeline()).not.toContain(doc);
    expect(await search(needle)).not.toContain(doc);
    expect((await getStore().documents.findFor(OWNER_ID, doc))?.reviewed).toBeFalsy();
  });

  it('touches only that document’s pages when an upload holds several', async () => {
    const { doc, sf, pageIds } = await upload(['a1', 'a2', 'b1', 'b2']);
    const split = await app.inject({ method: 'POST', url: `/api/documents/${doc}/boundary`, payload: { action: 'split', at_page: 3, defer: true }, headers: { cookie } });
    const [head, tail] = (split.json() as { split_into: [string, string] }).split_into;
    await setAside(head, true);
    const hidden = (await getStore().pages.listForSourceFile(OWNER_ID, sf)).map(p => [p.id, !!p.hidden]);
    expect(hidden).toEqual([[pageIds[0], true], [pageIds[1], true], [pageIds[2], false], [pageIds[3], false]]);
    expect(await timeline()).toContain(tail);
    expect(await timeline()).not.toContain(head);
  });

  it('brings it back when shown, every page again', async () => {
    const { doc, sf } = await upload(['one', 'two', 'three']);
    await setAside(doc, true);
    expect((await setAside(doc, false)).statusCode).toBe(200);
    expect((await getStore().pages.listForSourceFile(OWNER_ID, sf)).every(p => !p.hidden)).toBe(true);
    expect(await timeline()).toContain(doc);
  });

  it('answers 404 for another user’s document and changes nothing, 400 for a bad body, 401 without a session', async () => {
    const other = await createTestUser('hide-doc-else@spine.test');
    const theirs = await upload(['theirs one', 'theirs two'], other.id);
    expect((await setAside(theirs.doc, true)).statusCode).toBe(404);
    expect((await getStore().pages.listForSourceFile(other.id, theirs.sf)).every(p => !p.hidden)).toBe(true);

    const mine = await upload(['one']);
    for (const bad of [undefined, 'yes', 1, null]) expect((await setAside(mine.doc, bad)).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: `/api/documents/${mine.doc}/hidden`, payload: { hidden: true } })).statusCode).toBe(401);
  });
});

describe('a document whose every page is hidden', () => {
  const timeline = async () =>
    ((await app.inject({ method: 'GET', url: '/api/documents', headers: { cookie } })).json() as Array<{ id: string }>).map(d => d.id);
  const uploads = async () =>
    (await app.inject({ method: 'GET', url: '/api/source-files', headers: { cookie } })).json() as Array<{ id: string; documents: unknown[]; hidden_documents: number }>;
  const layout = async (sf: string) =>
    (await app.inject({ method: 'GET', url: `/api/source-files/${sf}`, headers: { cookie } })).json() as { documents: Array<{ id: string; hidden: boolean }> };

  it('leaves the timeline and search, and is marked on the regrouping screen', async () => {
    const needle = word();
    const { doc, sf, pageIds } = await upload([`only page ${needle}`]);
    expect(await timeline()).toContain(doc);

    await hide(pageIds[0], true);
    expect(await timeline()).not.toContain(doc);
    expect(await search(needle)).not.toContain(doc);
    expect((await layout(sf)).documents).toEqual([expect.objectContaining({ id: doc, hidden: true })]);
  });

  it('is counted on the upload card, which no longer lists it, so the upload can still be opened', async () => {
    const { sf, pageIds } = await upload(['only page']);
    await hide(pageIds[0], true);
    const card = (await uploads()).find(u => u.id === sf)!;
    expect(card.documents).toEqual([]);
    expect(card.hidden_documents).toBe(1);
  });

  it('comes back when a page is shown again', async () => {
    const { doc, sf, pageIds } = await upload(['only page']);
    await hide(pageIds[0], true);
    await hide(pageIds[0], false);
    expect(await timeline()).toContain(doc);
    expect((await layout(sf)).documents[0].hidden).toBe(false);
    expect((await uploads()).find(u => u.id === sf)!.hidden_documents).toBe(0);
  });

  it('stays in the timeline while any of its pages is shown', async () => {
    const { doc, sf, pageIds } = await upload(['one', 'two']);
    await hide(pageIds[0], true);
    expect(await timeline()).toContain(doc);
    expect((await layout(sf)).documents[0].hidden).toBe(false);
    await hide(pageIds[1], true);
    expect(await timeline()).not.toContain(doc);
  });

  it('is not shared, whatever the link says', async () => {
    const { doc, pageIds } = await upload(['only page']);
    const link = (scope: string, scopeValue: string | null) => ({ id: 'l', userId: OWNER_ID, scope, scopeValue, expiresAt: '2999-01-01', includeScans: false, language: null, requireApproval: false, allowChat: false });
    const shared = async () => (await getStore().documents.listForShare(link('all', null))).map(d => d.id);
    const byId = async () => (await getStore().documents.listForShare(link('document_ids', JSON.stringify([doc])))).map(d => d.id);
    expect(await shared()).toContain(doc);
    expect(await byId()).toEqual([doc]);

    await hide(pageIds[0], true);
    expect(await shared()).not.toContain(doc);
    expect(await byId()).toEqual([]);
  });

  it('is not counted for a doctor, and not listed under them', async () => {
    const { doc, pageIds } = await upload(['only page']);
    const store = getStore();
    const doctor = await store.doctors.upsert(OWNER_ID, { name: `Dr Hidden ${word()}` }, '2026-01-01');
    await store.doctors.link(OWNER_ID, doc, doctor!, 'author');
    const count = async () => (await store.doctors.listFor(OWNER_ID)).find(d => d.id === doctor)!.document_count;
    expect(await count()).toBe(1);
    await hide(pageIds[0], true);
    expect(await count()).toBe(0);
  });

  it('leaves its measurements out of the trends', async () => {
    const { doc, pageIds } = await upload(['only page']);
    const canonical = word();
    await getStore().measurements.create(OWNER_ID, {
      id: uuidv4(), documentId: doc, pageId: pageIds[0], name: canonical, canonical, valueText: '5', valueNum: 5, unit: 'mg',
      refLow: null, refHigh: null, flag: null, takenOn: '2026-01-01', sourceSnippet: null, bbox: null, confidence: 1,
    });
    expect(await getStore().measurements.series(OWNER_ID, canonical)).toHaveLength(1);
    await hide(pageIds[0], true);
    expect(await getStore().measurements.series(OWNER_ID, canonical)).toHaveLength(0);
    expect((await getStore().measurements.names(OWNER_ID)).map(n => n.canonical)).not.toContain(canonical);
  });
});

describe('a database from before pages could be hidden', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  /** The current schema with the column, the view's condition and the trigger's column taken out. */
  function oldDatabase(): string {
    dir = mkdtempSync(path.join(tmpdir(), 'spine-prehide-'));
    const file = path.join(dir, 'spine.db');
    const here = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../core/src/store/sqlite');
    const old = ['schema-accounts.sql', 'schema-records.sql'].map(f => readFileSync(path.join(here, f), 'utf8')).join('\n')
      .replace(/ {2}hidden INTEGER NOT NULL DEFAULT 0,.*\n/, '')
      .replace(/last_accessed_at TEXT,\n {2}include_scans INTEGER NOT NULL DEFAULT 0,[^\n]*\n {2}language TEXT[^\n]*\n {2}require_approval[^\n]*\n {2}allow_chat[^\n]*\n\);/, 'last_accessed_at TEXT\n);')
      .replace(/reviewed INTEGER DEFAULT 0,\n {2}language TEXT[^\n]*\n\);/, 'reviewed INTEGER DEFAULT 0\n);')
      .replace(/ {2}source_page INTEGER NOT NULL DEFAULT 0,[^\n]*\n/, '')
      .replace(' AND p.hidden = 0', '')
      .replace('AFTER UPDATE OF raw_text, hidden ON pages', 'AFTER UPDATE OF raw_text ON pages');
    expect(old).not.toMatch(/hidden/);
    expect(old).not.toMatch(/include_scans/);
    expect(old).not.toMatch(/require_approval INTEGER NOT NULL DEFAULT 0 --/); // the link's column; share_access_requests is a new table
    expect(old).not.toMatch(/source_page/);
    expect(old).not.toMatch(/language TEXT --/); // the two language columns; document_translations has its own, which is new
    const db = new Database(file);
    db.exec(old);
    db.prepare(`INSERT INTO users (id, email, password_hash, created_at, email_verified_at) VALUES ('u1', 'a@spine.test', 'x', '2026-01-01', '2026-01-01')`).run();
    db.prepare(`INSERT INTO source_files (id, user_id, uploaded_at, file_path, status) VALUES ('f1', 'u1', '2026-01-01', '/x.pdf', 'done')`).run();
    const page = db.prepare(`INSERT INTO pages (id, user_id, source_file_id, page_number, image_path, image_width, image_height, raw_text) VALUES (?, 'u1', 'f1', ?, '/p.png', 10, 10, ?)`);
    page.run('p1', 1, 'kept words');
    page.run('p2', 2, 'dropped zebra words');
    db.prepare(`INSERT INTO documents (id, user_id, source_file_id, page_start, page_end, title) VALUES ('d1', 'u1', 'f1', 1, 2, 'Old report')`).run();
    db.prepare(`INSERT INTO share_links (id, user_id, token, scope, created_at, expires_at) VALUES ('l1', 'u1', 'digest', 'all', '2026-01-01', '2999-01-01')`).run();
    db.close();
    return file;
  }

  it('is opened, given the column, and still holds what it held', async () => {
    const file = oldDatabase();
    const store = createStore({ adapter: 'sqlite', location: file });
    const pages = await store.pages.listForSourceFile('u1', 'f1');
    expect(pages.map(p => [p.id, !!p.hidden])).toEqual([['p1', false], ['p2', false]]);
    // Every page was in file order, so its place in the file is the number it had.
    expect(pages.map(p => [p.page_number, p.source_page])).toEqual([[1, 1], [2, 2]]);
    expect((await store.documents.findFor('u1', 'd1'))?.title).toBe('Old report');
    // A link made before links could include scans does not, and the owner sees that.
    expect((await store.shareLinks.listFor('u1')).map(l => [l.id, l.include_scans])).toEqual([['l1', false]]);
    expect((await store.shareLinks.findLiveByTokenHash('digest'))?.includeScans).toBe(false);
    // Neither a document nor a link had a language before, and that is allowed.
    expect((await store.shareLinks.findLiveByTokenHash('digest'))?.language).toBeNull();
    expect((await store.documents.findFor('u1', 'd1'))?.language).toBeNull();
    await store.close?.();
  });

  it('then hides a page from the search, which needs the view and trigger it replaced', async () => {
    const file = oldDatabase();
    const store = createStore({ adapter: 'sqlite', location: file });
    const find = async (q: string) =>
      (await store.documents.listFor('u1', { q: `"${q}"*`, limit: 10, offset: 0 })).map(d => d.id);
    expect(await find('zebra')).toEqual(['d1']);
    await store.pages.setHidden('u1', 'p2', true);
    expect(await find('zebra')).toEqual([]);
    expect(await find('kept')).toEqual(['d1']);
    await store.close?.();
  });

  it('opens a second time without trying to add the column again', () => {
    const file = oldDatabase();
    createStore({ adapter: 'sqlite', location: file });
    expect(() => createStore({ adapter: 'sqlite', location: file })).not.toThrow();
  });
});
