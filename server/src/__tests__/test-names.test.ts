import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { buildTestApp, loginAs, loginSession } from './helpers/app.js';
import { createTestUser, seedPage, seedSourceFile, OWNER_ID } from './helpers/seed.js';
import { getStore } from '../store/index.js';
import { buildExtractionPrompt } from '../llm/prompts.js';
import { knownTestNames, rereadDocument } from '../ingestion/document-reading.js';

const mockExtractFields = vi.hoisted(() => vi.fn());
vi.mock('../ingestion/extraction.js', () => ({ extractFields: mockExtractFields }));

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
beforeAll(async () => { app = await buildTestApp(); cookie = await loginSession(app); });
afterAll(async () => { await app.close(); });
beforeEach(() => { mockExtractFields.mockReset(); });

const tag = () => uuidv4().slice(0, 6);
const post = (url: string, payload: object, c = cookie) => app.inject({ method: 'POST', url, payload, headers: { cookie: c } });
const get = (url: string, c = cookie) => app.inject({ method: 'GET', url, headers: { cookie: c } });

async function doc(userId = OWNER_ID, date = '2026-05-12', text = 'Hemoglobina 13,5') {
  const sf = await seedSourceFile({ userId, status: 'done' });
  const pageId = await seedPage(sf, { userId, pageNumber: 1, rawText: text });
  const id = uuidv4();
  await getStore().documents.create(userId, { id, sourceFileId: sf, pageStart: 1, pageEnd: 1, title: 'Lab', docDate: date });
  return { id, pageId };
}
async function value(userId: string, d: { id: string; pageId: string }, canonical: string, v = '1', unit = 'mg/dL', on = '2026-05-12') {
  await getStore().measurements.create(userId, {
    id: uuidv4(), documentId: d.id, pageId: d.pageId, name: canonical, canonical, valueText: v, valueNum: Number(v), unit,
    refLow: null, refHigh: null, flag: null, takenOn: on, sourceSnippet: null, bbox: null, confidence: null,
  });
}
const reading = (canonical: string) => ({
  title: 't', doc_date: '2026-05-12', provider: null, doc_type: 'lab_result' as const, ai_summary: 's', suggested_tags: [], doctors: [], fields: [],
  measurements: [{ name: 'Hormon tireostimulant', canonical, value: '3.10', unit: 'uUI/mL', ref_low: null, ref_high: null, flag: null, date: null, source_snippet: 'x', page_number: 1, confidence: 1 }],
});
const names = async (userId = OWNER_ID) => (await getStore().measurements.names(userId)).map(n => n.canonical);

describe('merging two names for one test', () => {
  it('moves every value to the other name and lists them as one test', async () => {
    const a = `tsh-${tag()}`, b = `thyroid stimulating hormone ${tag()}`;
    await value(OWNER_ID, await doc(), a, '2.8', 'uIU/mL', '2026-01-01');
    await value(OWNER_ID, await doc(), b, '3.1', 'uIU/mL', '2026-06-01');
    const res = await post('/api/measurements/merge', { from: a, into: b });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, canonical: b });

    expect(await names()).not.toContain(a);
    const series = (await get(`/api/measurements/series?name=${encodeURIComponent(b)}`)).json() as { points: Array<{ value_text: string }> };
    expect(series.points.map(p => p.value_text)).toEqual(['2.8', '3.1']);
    expect((await get(`/api/measurements/series?name=${encodeURIComponent(a)}`)).statusCode).toBe(404);
  });

  it('is case-insensitive about the names it is given', async () => {
    const a = `abc-${tag()}`, b = `xyz-${tag()}`;
    await value(OWNER_ID, await doc(), a); await value(OWNER_ID, await doc(), b);
    expect((await post('/api/measurements/merge', { from: ` ${a.toUpperCase()} `, into: b.toUpperCase() })).statusCode).toBe(200);
  });

  it('remembers the old name, so a later reading that uses it is filed under the new one', async () => {
    const a = `tsh-${tag()}`, b = `thyroid stimulating hormone ${tag()}`;
    await value(OWNER_ID, await doc(), a); await value(OWNER_ID, await doc(), b);
    await post('/api/measurements/merge', { from: a, into: b });

    const later = await doc();
    mockExtractFields.mockResolvedValue(reading(a)); // the model says the old name again
    expect(await rereadDocument(OWNER_ID, later.id)).toBe(true);
    expect((await getStore().measurements.listForDocument(OWNER_ID, later.id)).map(m => m.canonical)).toEqual([b]);
  });

  it('follows a chain: merging into a name that was itself merged still ends at the last one', async () => {
    const a = `a-${tag()}`, b = `b-${tag()}`, c = `c-${tag()}`;
    for (const n of [a, b, c]) await value(OWNER_ID, await doc(), n);
    await post('/api/measurements/merge', { from: a, into: b });
    await post('/api/measurements/merge', { from: b, into: c });
    expect(await getStore().measurements.resolveCanonical(OWNER_ID, a)).toBe(c); // a's alias was repointed, not left at b
    expect(await getStore().measurements.resolveCanonical(OWNER_ID, b)).toBe(c);
    expect(await getStore().measurements.resolveCanonical(OWNER_ID, c)).toBe(c);
  });

  it('files an edit that renames a test under its merged name', async () => {
    const a = `tsh-${tag()}`, b = `thyroid stimulating hormone ${tag()}`;
    await value(OWNER_ID, await doc(), a); const target = await doc(); await value(OWNER_ID, target, b);
    await post('/api/measurements/merge', { from: a, into: b });

    const mine = await doc(); await value(OWNER_ID, mine, `other-${tag()}`);
    const row = (await getStore().measurements.listForDocument(OWNER_ID, mine.id))[0];
    const res = await app.inject({ method: 'PATCH', url: `/api/documents/${mine.id}`, headers: { cookie }, payload: { measurements: {
      update: [{ id: row.id, name: a, canonical: '', value: '5' }],
      add: [{ name: a, value: '6', page_id: mine.pageId }],
    } } });
    expect(res.statusCode).toBe(200);
    expect((await getStore().measurements.listForDocument(OWNER_ID, mine.id)).map(m => m.canonical)).toEqual([b, b]);
  });

  it.each([
    ['nothing to merge', {}],
    ['a missing name', { from: 'x' }],
    ['names that are not text', { from: 5, into: 6 }],
    ['the same test twice', { from: 'same', into: 'SAME' }],
  ])('refuses %s', async (_n, body) => {
    expect((await post('/api/measurements/merge', body)).statusCode).toBe(400);
  });

  it('answers not found for a test the user does not have, and changes nothing', async () => {
    const a = `real-${tag()}`;
    await value(OWNER_ID, await doc(), a);
    expect((await post('/api/measurements/merge', { from: a, into: 'no-such-test' })).statusCode).toBe(404);
    expect((await post('/api/measurements/merge', { from: 'no-such-test', into: a })).statusCode).toBe(404);
    expect(await names()).toContain(a);
    expect(await getStore().measurements.resolveCanonical(OWNER_ID, 'no-such-test')).toBe('no-such-test');
  });

  it('never touches another user’s tests or aliases, and the same name means nothing to them', async () => {
    const other = await createTestUser(`mg-${uuidv4()}@spine.test`);
    const a = `shared-${tag()}`, b = `target-${tag()}`;
    await value(OWNER_ID, await doc(), a); await value(OWNER_ID, await doc(), b);
    await value(other.id, await doc(other.id), a);

    // Merging is by name within the caller's own archive: the other user has no `b`, so cannot merge into it.
    const theirs = await loginAs(app, other.email);
    expect((await post('/api/measurements/merge', { from: a, into: b }, theirs)).statusCode).toBe(404);
    expect(await names(other.id)).toContain(a);

    await post('/api/measurements/merge', { from: a, into: b });
    expect(await names(other.id)).toContain(a);                    // still theirs, still under that name
    expect(await names(other.id)).not.toContain(b);
    expect(await getStore().measurements.resolveCanonical(other.id, a)).toBe(a); // my alias is not theirs
  });

  it('is removed with the user', async () => {
    const other = await createTestUser(`del-${uuidv4()}@spine.test`);
    const a = `a-${tag()}`, b = `b-${tag()}`;
    await value(other.id, await doc(other.id), a); await value(other.id, await doc(other.id), b);
    await getStore().measurements.mergeTests(other.id, a, b);
    await expect(getStore().users.delete(other.id)).resolves.toBeUndefined();
    expect(await getStore().measurements.resolveCanonical(other.id, a)).toBe(a);
  });

  it('needs a session', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/measurements/merge', payload: { from: 'a', into: 'b' } })).statusCode).toBe(401);
  });
});

describe('telling the model which tests already exist', () => {
  it('names them in the prompt, with the instruction to reuse one', () => {
    const prompt = buildExtractionPrompt('--- page 1 ---\ntext', ['hemoglobin', 'ldl cholesterol']);
    expect(prompt).toContain('Tests already in this person\'s archive (canonical names): hemoglobin, ldl cholesterol.');
    expect(prompt).toMatch(/use that exact name as its canonical/);
  });
  it('says nothing about it when the archive has no tests yet', () => {
    expect(buildExtractionPrompt('text')).not.toMatch(/already in this person/);
    expect(buildExtractionPrompt('text', [])).not.toMatch(/already in this person/);
  });

  it('sends the user’s own test names with a reading, most-used first, and nobody else’s', async () => {
    const other = await createTestUser(`kn-${uuidv4()}@spine.test`);
    // Alphabetical order and insertion order both put `rare` first, so only the count can put `common` ahead.
    const rare = `aaa-rare-${tag()}`, common = `zzz-common-${tag()}`, secret = `secret-${tag()}`;
    await value(OWNER_ID, await doc(), rare);
    for (let i = 0; i < 3; i++) await value(OWNER_ID, await doc(), common);
    await value(other.id, await doc(other.id), secret);

    const target = await doc();
    mockExtractFields.mockResolvedValue(reading(common));
    await rereadDocument(OWNER_ID, target.id);
    const sent = mockExtractFields.mock.calls[0][1] as string[];
    expect(sent.indexOf(common)).toBeGreaterThanOrEqual(0);
    expect(sent.indexOf(common)).toBeLessThan(sent.indexOf(rare));
    expect(sent).not.toContain(secret);
  });

  it('keeps the list to a small share of the context window, and a fixed number of names', async () => {
    const user = await createTestUser(`cap-${uuidv4()}@spine.test`);
    const d = await doc(user.id);
    for (let i = 0; i < 350; i++) await value(user.id, d, `a-test-with-a-fairly-long-name-${i}`);
    const list = await knownTestNames(user.id);
    expect(list.length).toBe(300);
    expect(list.join(', ').length).toBeLessThanOrEqual(300_000 * 0.05);

  });

  it('stops at a character budget before the count cap when names are long', async () => {
    const user = await createTestUser(`chars-${uuidv4()}@spine.test`);
    const d = await doc(user.id);
    for (let i = 0; i < 250; i++) await value(user.id, d, `${'x'.repeat(78)}${String(i).padStart(2, '0')}`); // 80 characters each
    const list = await knownTestNames(user.id);
    expect(list.length).toBeLessThan(250);
    expect(list.length).toBeGreaterThan(150);
    expect(list.join(', ').length).toBeLessThanOrEqual(300_000 * 0.05);
  });

  it('is empty for a user with no values', async () => {
    const user = await createTestUser(`none-${uuidv4()}@spine.test`);
    expect(await knownTestNames(user.id)).toEqual([]);
  });
});
