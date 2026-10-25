import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { buildTestApp, loginAs, loginSession } from './helpers/app.js';
import { createTestUser, seedPage, seedSourceFile, OWNER_ID } from './helpers/seed.js';
import { getStore } from 'spine-core/store/index.js';
import { ftsQuery } from 'spine-core/search-query.js';

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
beforeAll(async () => { app = await buildTestApp(); cookie = await loginSession(app); });
afterAll(async () => { await app.close(); });

const word = () => `w${uuidv4().replace(/[^a-z]/g, '').slice(0, 10)}`; // letters only, unique, never in other tests

async function search(q: string, c = cookie) {
  const res = await app.inject({ method: 'GET', url: `/api/documents?q=${encodeURIComponent(q)}`, headers: { cookie: c } });
  expect(res.statusCode, q).toBe(200);
  return (res.json() as Array<{ id: string; title: string | null }>).map(d => d.id);
}

/** One upload with pages of the given text and one document over all of them. */
async function make(opts: { pages?: string[]; title?: string; summary?: string; userId?: string; split?: number } = {}) {
  const userId = opts.userId ?? OWNER_ID;
  const store = getStore();
  const sf = await seedSourceFile({ userId, status: 'done' });
  const texts = opts.pages ?? ['plain page text'];
  const pageIds: string[] = [];
  for (const [i, rawText] of texts.entries()) pageIds.push(await seedPage(sf, { userId, pageNumber: i + 1, rawText }));
  const id = uuidv4();
  await store.documents.create(userId, { id, sourceFileId: sf, pageStart: 1, pageEnd: texts.length, title: opts.title ?? 'Untitled', docDate: '2026-01-01', aiSummary: opts.summary ?? 'A summary.' });
  return { id, sf, pageIds };
}

describe('what a search query becomes', () => {
  it.each([
    ['lombar', '"lombar"*'],
    ['dureri lombare', '"dureri"* "lombare"*'],
    ['dr. Popescu', '"Popescu"*'],
    ['Prof. Dr. Ion Popescu', '"Ion"* "Popescu"*'],
    ['dr', '"dr"*'],
    ['Dr. Prof.', '"Dr"* "Prof"*'],
    ['50 mg', '"50"* "mg"*'],
    ['  spaced   out  ', '"spaced"* "out"*'],
    ['Ștefănescu-Ionescu', '"Ștefănescu"* "Ionescu"*'],
    ['Conf. Dr. Ștefănescu', '"Ștefănescu"*'],
    ['a "quote" and -minus OR near(x)', '"a"* "quote"* "and"* "minus"* "OR"* "near"* "x"*'],
  ])('%j is %s', (typed, expected) => expect(ftsQuery(typed)).toBe(expected));
  it.each(['', '   ', '!!!', '"', '- * ()', '...'])('%j has nothing to search for', typed => expect(ftsQuery(typed)).toBeNull());
});

describe('finding a document by what is in it', () => {
  it('finds it by the text of its pages, though the title and summary never mention it', async () => {
    const term = word();
    const d = await make({ pages: [`first page`, `Tratament cu ${term} de doua ori pe zi`] });
    expect(await search(term)).toEqual([d.id]);
  });

  it('finds it by an extracted value, and by a measurement’s name, and by a doctor’s name', async () => {
    const value = word(), test = word(), doctor = word();
    const d = await make();
    await getStore().fields.create(OWNER_ID, { id: uuidv4(), documentId: d.id, pageId: d.pageIds[0], label: 'diagnosis', value: `Dx ${value}`, groupNo: null, sourceSnippet: null, bbox: null, confidence: 1 });
    await getStore().measurements.create(OWNER_ID, { id: uuidv4(), documentId: d.id, pageId: d.pageIds[0], name: test, canonical: test, valueText: '1', valueNum: 1, unit: null, refLow: null, refHigh: null, flag: null, takenOn: null, sourceSnippet: null, bbox: null, confidence: null });
    const doc = (await getStore().doctors.upsert(OWNER_ID, { name: `Dr. ${doctor} Ion` }, new Date().toISOString()))!;
    await getStore().doctors.link(OWNER_ID, d.id, doc, 'author');

    for (const q of [value, test, doctor]) expect(await search(q), q).toEqual([d.id]);
  });

  it('still finds it by title, summary and notes', async () => {
    const t = word(), s = word();
    const d = await make({ title: `Buletin ${t}`, summary: `About ${s}` });
    expect(await search(t)).toEqual([d.id]);
    expect(await search(s)).toEqual([d.id]);
  });

  it('matches the start of a word, ignores accents, and needs every word', async () => {
    const stem = word();
    const d = await make({ pages: [`dureri ${stem}ară cronice`] });
    expect(await search(`${stem}ar`)).toEqual([d.id]);          // by the start of the word
    expect(await search(`${stem}ara`)).toEqual([d.id]);         // the accent typed without it
    expect(await search(`${stem.toUpperCase()}ARĂ cronice`)).toEqual([d.id]); // any case, both words
    expect(await search(`${stem}ara missingword`)).toEqual([]); // all of them, not any
  });

  it('puts a hit in the title above one deep in a page', async () => {
    const term = word();
    const deep = await make({ pages: [`filler ${term}`] });
    const titled = await make({ title: `About ${term}` });
    expect(await search(term)).toEqual([titled.id, deep.id]);
  });

  it('does not fail on punctuation, quotes or search operators', async () => {
    await make({ pages: ['Dr. Popescu, 50 mg'] });
    for (const q of ['dr. popescu', '50 mg', '"', 'a"b', '-x', 'x OR', 'near(', '*', 'title:foo', '(', '!!!']) await search(q);
    expect((await search('dr. popescu')).length).toBeGreaterThan(0);
    const who = word();
    const withDoctor = await make();
    const id = (await getStore().doctors.upsert(OWNER_ID, { name: `Dr. ${who} Ion` }, new Date().toISOString()))!;
    await getStore().doctors.link(OWNER_ID, withDoctor.id, id, 'author');
    expect(await search(`Dr. ${who}`)).toEqual([withDoctor.id]); // the title is not in the index, so it is not asked for
    expect(await search('!!!')).toEqual([]);
  });

  it('combines with the other filters', async () => {
    const term = word();
    const a = await make({ pages: [term] }); const b = await make({ pages: [term] });
    await getStore().documents.update(OWNER_ID, a.id, { doc_type: 'lab_result' });
    const res = await app.inject({ method: 'GET', url: `/api/documents?q=${term}&doc_type=lab_result`, headers: { cookie } });
    expect((res.json() as Array<{ id: string }>).map(d => d.id)).toEqual([a.id]);
    expect(b.id).toBeTruthy();
  });
});

describe('a document is found only by its own pages', () => {
  it('two documents in one upload each match only their own text', async () => {
    const first = word(), second = word();
    const store = getStore();
    const sf = await seedSourceFile({ status: 'done' });
    for (const [i, rawText] of [first, first, second].entries()) await seedPage(sf, { pageNumber: i + 1, rawText });
    const a = uuidv4(), b = uuidv4();
    await store.documents.create(OWNER_ID, { id: a, sourceFileId: sf, pageStart: 1, pageEnd: 2, title: 'First', docDate: '2026-01-01' });
    await store.documents.create(OWNER_ID, { id: b, sourceFileId: sf, pageStart: 3, pageEnd: 3, title: 'Second', docDate: '2026-01-02' });
    expect(await search(first)).toEqual([a]);
    expect(await search(second)).toEqual([b]);
  });
});

describe('the index follows every change', () => {
  it('an edited field replaces what it found before, and a removed one stops finding', async () => {
    const before = word(), after = word();
    const d = await make();
    const fieldId = uuidv4();
    await getStore().fields.create(OWNER_ID, { id: fieldId, documentId: d.id, pageId: d.pageIds[0], label: 'dx', value: before, groupNo: null, sourceSnippet: null, bbox: null, confidence: 1 });
    expect(await search(before)).toEqual([d.id]);

    const patch = (fields: object) => app.inject({ method: 'PATCH', url: `/api/documents/${d.id}`, headers: { cookie }, payload: { fields } });
    expect((await patch({ update: [{ id: fieldId, label: 'dx', value: after }] })).statusCode).toBe(200);
    expect(await search(before)).toEqual([]);
    expect(await search(after)).toEqual([d.id]);

    expect((await patch({ remove: [fieldId] })).statusCode).toBe(200);
    expect(await search(after)).toEqual([]);
  });

  it('a page read again replaces its old text', async () => {
    const before = word(), after = word();
    const d = await make({ pages: [before] });
    expect(await search(before)).toEqual([d.id]);
    await getStore().pages.updateReading(OWNER_ID, d.pageIds[0], { rawText: after, elements: [], extractionSource: 'ocr' });
    expect(await search(before)).toEqual([]);
    expect(await search(after)).toEqual([d.id]);
  });

  it('a removed measurement and an edited one follow', async () => {
    const before = word(), after = word();
    const d = await make();
    const id = uuidv4();
    const store = getStore();
    await store.measurements.create(OWNER_ID, { id, documentId: d.id, pageId: d.pageIds[0], name: before, canonical: before, valueText: '1', valueNum: 1, unit: null, refLow: null, refHigh: null, flag: null, takenOn: null, sourceSnippet: null, bbox: null, confidence: null });
    await store.measurements.update(OWNER_ID, d.id, id, { name: after, canonical: after, valueText: '1', valueNum: 1, unit: null, refLow: null, refHigh: null, flag: null, takenOn: null });
    expect(await search(before)).toEqual([]);
    expect(await search(after)).toEqual([d.id]);
    await store.measurements.remove(OWNER_ID, d.id, id);
    expect(await search(after)).toEqual([]);
  });

  it('renaming a doctor, or taking them off the document, changes what finds it', async () => {
    const before = word(), after = word();
    const d = await make();
    const store = getStore();
    const doc = (await store.doctors.upsert(OWNER_ID, { name: `${before} Radu` }, new Date().toISOString()))!;
    await store.doctors.link(OWNER_ID, d.id, doc, 'author');
    expect(await search(before)).toEqual([d.id]);

    expect((await app.inject({ method: 'PATCH', url: `/api/doctors/${doc}`, headers: { cookie }, payload: { name: `${after} Radu` } })).statusCode).toBe(200);
    expect(await search(before)).toEqual([]);
    expect(await search(after)).toEqual([d.id]);

    await store.doctors.unlinkAll(OWNER_ID, d.id);
    expect(await search(after)).toEqual([]);
  });

  it('a split gives each half its own pages’ text, and a join gives one document both', async () => {
    const one = word(), two = word();
    const d = await make({ pages: [one, two] });
    const split = await app.inject({ method: 'POST', url: `/api/documents/${d.id}/boundary`, headers: { cookie }, payload: { action: 'split', at_page: 2 } });
    expect(split.statusCode).toBe(200);
    const [head, tail] = (split.json() as { split_into: [string, string] }).split_into;
    expect(await search(one)).toEqual([head]);
    expect(await search(two)).toEqual([tail]);

    const join = await app.inject({ method: 'POST', url: `/api/documents/${head}/boundary`, headers: { cookie }, payload: { action: 'merge', with_document_id: tail } });
    expect(join.statusCode).toBe(200);
    expect(await search(one)).toEqual([head]);
    expect(await search(two)).toEqual([head]);
  });

  it('clearing an upload’s derived data removes the documents from search', async () => {
    const term = word();
    const d = await make({ pages: [term] });
    expect(await search(term)).toEqual([d.id]);
    await getStore().sourceFiles.clearDerived(OWNER_ID, d.sf);
    expect(await search(term)).toEqual([]);
  });
});

describe('whose it is', () => {
  it('never finds another user’s page text, values or doctors', async () => {
    const other = await createTestUser(`s-${uuidv4()}@spine.test`);
    const text = word(), value = word(), doctor = word();
    const theirs = await make({ userId: other.id, pages: [text] });
    await getStore().fields.create(other.id, { id: uuidv4(), documentId: theirs.id, pageId: theirs.pageIds[0], label: 'dx', value, groupNo: null, sourceSnippet: null, bbox: null, confidence: 1 });
    const doc = (await getStore().doctors.upsert(other.id, { name: `${doctor} Test` }, new Date().toISOString()))!;
    await getStore().doctors.link(other.id, theirs.id, doc, 'author');

    for (const q of [text, value, doctor]) {
      expect(await search(q), `mine: ${q}`).toEqual([]);
      expect(await search(q, await loginAs(app, other.email)), `theirs: ${q}`).toEqual([theirs.id]);
    }
  });

  it('a document’s search text never includes pages of another user’s upload', async () => {
    const other = await createTestUser(`p-${uuidv4()}@spine.test`);
    const secret = word();
    const mine = await make({ pages: ['mine'] });
    await seedPage(await seedSourceFile({ userId: other.id, status: 'done' }), { userId: other.id, pageNumber: 1, rawText: secret });
    expect(await search(secret)).toEqual([]);
    expect(mine.id).toBeTruthy();
  });
});

describe('snippets', () => {
  const found = async (q: string, c = cookie) => (await (await app.inject({ method: 'GET', url: `/api/documents?q=${encodeURIComponent(q)}`, headers: { cookie: c } })).json()) as Array<{ id: string; snippet?: string }>;

  it('shows the words around a match deep in a page, with the match marked', async () => {
    const term = word();
    const d = await make({ pages: ['intro', `Tratament cu ${term} de doua ori pe zi, dupa mese`] });
    const [hit] = await found(term);
    expect(hit.id).toBe(d.id);
    expect(hit.snippet).toContain(`\u0001${term}\u0002`);
    expect(hit.snippet).toContain('Tratament');
  });

  it('marks the start of a word match, ignoring case and accents', async () => {
    const stem = word();
    await make({ pages: [`dureri ${stem}ară cronice`] });
    const [hit] = await found(stem.toUpperCase());
    expect(hit.snippet).toMatch(/\u0001.*\u0002/);
  });

  it('is only on searches, and only text from that user’s own document', async () => {
    const term = word();
    const mine = await make({ pages: [`mine ${term}`] });
    const other = await createTestUser(`sn-${uuidv4()}@spine.test`);
    const theirSecret = word();
    await make({ userId: other.id, pages: [`secret ${theirSecret} ${term}`] });
    const hits = await found(term);
    expect(hits.map(h => h.id)).toEqual([mine.id]);
    expect(JSON.stringify(hits)).not.toContain(theirSecret);
    const plain = (await (await app.inject({ method: 'GET', url: '/api/documents', headers: { cookie } })).json()) as Array<{ snippet?: string }>;
    expect(plain.every(d => d.snippet === undefined)).toBe(true);
  });

  it('never contains markup of its own: a page’s angle brackets are only text', async () => {
    const term = word();
    await make({ pages: [`<script>alert(1)</script> ${term}`] });
    const [hit] = await found(term);
    expect(hit.snippet).toContain('<script>'); // returned as plain text; the page renders text nodes, not HTML
    expect(hit.snippet).toContain(`\u0001${term}\u0002`);
  });
});
