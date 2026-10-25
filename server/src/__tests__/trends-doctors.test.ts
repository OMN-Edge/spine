import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { buildTestApp, loginAs, loginSession } from './helpers/app.js';
import { createTestUser, seedPage, seedSourceFile, OWNER_ID } from './helpers/seed.js';
import { getStore } from 'spine-core/store/index.js';
import { DOC_TYPES } from 'spine-core/llm/types.js';

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
beforeAll(async () => { app = await buildTestApp(); cookie = await loginSession(app); });
afterAll(async () => { await app.close(); });

const get = (url: string, c = cookie) => app.inject({ method: 'GET', url, headers: { cookie: c } });
const send = (method: 'PATCH' | 'POST' | 'DELETE', url: string, payload?: object, c = cookie) =>
  app.inject({ method, url, payload, headers: { cookie: c } });

async function documentFor(userId: string, date: string | null, title = 'Lab') {
  const store = getStore();
  const sf = await seedSourceFile({ userId, status: 'done' });
  const pageId = await seedPage(sf, { userId, pageNumber: 1 });
  const id = uuidv4();
  await store.documents.create(userId, { id, sourceFileId: sf, pageStart: 1, pageEnd: 1, title, docDate: date });
  return { id, pageId };
}

async function value(userId: string, doc: { id: string; pageId: string }, canonical: string, v: string, over: { unit?: string | null; takenOn?: string | null; name?: string } = {}) {
  const num = Number(v.replace(',', '.'));
  await getStore().measurements.create(userId, {
    id: uuidv4(), documentId: doc.id, pageId: doc.pageId, name: over.name ?? canonical, canonical, valueText: v,
    valueNum: Number.isFinite(num) ? num : null, unit: over.unit === undefined ? 'g/dL' : over.unit, refLow: 12, refHigh: 16, flag: null,
    takenOn: over.takenOn === undefined ? null : over.takenOn, sourceSnippet: null, bbox: null, confidence: null,
  });
}

describe('the list of tests', () => {
  it('lists each test once with its latest value, newest by date', async () => {
    const t = `t-${uuidv4().slice(0, 6)}`;
    const old = await documentFor(OWNER_ID, '2025-01-01'); const recent = await documentFor(OWNER_ID, '2026-02-02');
    await value(OWNER_ID, recent, t, '14', { takenOn: '2026-02-02' });
    await value(OWNER_ID, old, t, '12', { takenOn: '2025-01-01' }); // inserted later, but older
    const row = ((await get('/api/measurements')).json() as Array<{ canonical: string; count: number; latest_value_text: string; latest_taken_on: string }>).find(r => r.canonical === t)!;
    expect([row.count, row.latest_value_text, row.latest_taken_on]).toEqual([2, '14', '2026-02-02']);
  });

  it('shows only the caller’s tests', async () => {
    const other = await createTestUser(`m-${uuidv4()}@spine.test`);
    const t = `private-${uuidv4().slice(0, 6)}`;
    await value(other.id, await documentFor(other.id, '2026-01-01'), t, '1', { takenOn: '2026-01-01' });
    expect(((await get('/api/measurements')).json() as Array<{ canonical: string }>).some(r => r.canonical === t)).toBe(false);
    const theirs = await loginAs(app, other.email);
    expect(((await get('/api/measurements', theirs)).json() as Array<{ canonical: string }>).some(r => r.canonical === t)).toBe(true);
  });
});

describe('one test over time', () => {
  it('returns the values oldest first, with the document each came from', async () => {
    const t = `s-${uuidv4().slice(0, 6)}`;
    const a = await documentFor(OWNER_ID, '2026-03-01', 'March'); const b = await documentFor(OWNER_ID, '2025-06-01', 'June');
    await value(OWNER_ID, a, t, '13,5', { takenOn: '2026-03-01' }); await value(OWNER_ID, b, t, '12,8', { takenOn: '2025-06-01' });
    const res = await get(`/api/measurements/series?name=${t}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { unit: string; points: Array<{ taken_on: string; value_num: number; document_title: string; charted: boolean; document_id: string }> };
    expect(body.unit).toBe('g/dL');
    expect(body.points.map(p => [p.taken_on, p.value_num, p.document_title, p.charted])).toEqual([['2025-06-01', 12.8, 'June', true], ['2026-03-01', 13.5, 'March', true]]);
  });

  it('charts only values in the unit most of them use, and says so for the others', async () => {
    const t = `u-${uuidv4().slice(0, 6)}`;
    for (const [i, unit] of ['g/dL', 'g/dL', 'g/L'].entries()) await value(OWNER_ID, await documentFor(OWNER_ID, `2026-0${i + 1}-01`), t, '13', { unit, takenOn: `2026-0${i + 1}-01` });
    const body = (await get(`/api/measurements/series?name=${t}`)).json() as { unit: string; points: Array<{ unit: string; charted: boolean }> };
    expect(body.unit).toBe('g/dL');
    expect(body.points.map(p => [p.unit, p.charted])).toEqual([['g/dL', true], ['g/dL', true], ['g/L', false]]);
  });

  it('treats one unit written two ways as one, and draws each value once when a consultation repeats a lab’s', async () => {
    const tag = `un-${uuidv4().slice(0, 6)}`;
    const lab = await documentFor(OWNER_ID, '2026-05-12', 'Lab'); const consult = await documentFor(OWNER_ID, '2026-06-02', 'Consult'); const earlier = await documentFor(OWNER_ID, '2026-03-01', 'Earlier lab');
    const store = getStore();
    const add = (doc: { id: string; pageId: string }, unit: string | null, v: string, on: string, low: number | null) => store.measurements.create(OWNER_ID, {
      id: uuidv4(), documentId: doc.id, pageId: doc.pageId, name: tag, canonical: tag, valueText: v, valueNum: Number(v), unit, refLow: low, refHigh: low === null ? null : 12.4,
      flag: null, takenOn: on, sourceSnippet: null, bbox: null, confidence: null,
    });
    await add(earlier, 'mIU/mL', '1.9', '2026-03-01', 1.5);
    await add(consult, null, '4.2', '2026-05-12', null);        // quoted without a unit: the lab's value again
    await add(consult, 'mUI/mL', '4.2', '2026-05-12', null);    // quoted with a unit, no range
    await add(lab, 'mUI/mL', '4.2', '2026-05-12', 1.5);         // the lab itself, with its range
    const body = (await get(`/api/measurements/series?name=${tag}`)).json() as { points: Array<{ document_title: string; unit: string | null; ref_low: number | null; charted: boolean; repeat: boolean }> };
    const by = (title: string, unit: string | null) => body.points.find(p => p.document_title === title && p.unit === unit)!;
    expect(by('Earlier lab', 'mIU/mL').charted).toBe(true);        // "mIU" and "mUI" are one unit
    expect(by('Lab', 'mUI/mL')).toMatchObject({ charted: true, repeat: false });   // the one with the range is the one drawn
    expect(by('Consult', 'mUI/mL')).toMatchObject({ charted: false, repeat: true });
    expect(by('Consult', null)).toMatchObject({ charted: false, repeat: false });  // no unit: not drawn, and not a repeat of anything
    expect(body.points.filter(p => p.charted)).toHaveLength(2);
    expect(body.points).toHaveLength(4);                             // every value is still listed
  });

  it('lists a value that is not a number, or has no date, without charting it', async () => {
    const t = `n-${uuidv4().slice(0, 6)}`;
    await value(OWNER_ID, await documentFor(OWNER_ID, '2026-01-01'), t, '5', { takenOn: '2026-01-01' });
    await value(OWNER_ID, await documentFor(OWNER_ID, '2026-02-01'), t, '<0.5', { takenOn: '2026-02-01' });
    await value(OWNER_ID, await documentFor(OWNER_ID, null), t, '6', { takenOn: null });
    const body = (await get(`/api/measurements/series?name=${t}`)).json() as { points: Array<{ value_text: string; charted: boolean }> };
    expect(body.points.map(p => [p.value_text, p.charted]).sort()).toEqual([['5', true], ['6', false], ['<0.5', false]]);
  });

  it('matches the name however it is cased, and is not found for an unknown or someone else’s test', async () => {
    const t = `case-${uuidv4().slice(0, 6)}`;
    await value(OWNER_ID, await documentFor(OWNER_ID, '2026-01-01'), t, '1', { takenOn: '2026-01-01' });
    expect((await get(`/api/measurements/series?name=${encodeURIComponent(t.toUpperCase())}`)).statusCode).toBe(200);
    expect((await get('/api/measurements/series?name=nonexistent-test')).statusCode).toBe(404);
    expect((await get('/api/measurements/series')).statusCode).toBe(400);
    expect((await get('/api/measurements/series?name=')).statusCode).toBe(400);

    const other = await createTestUser(`n-${uuidv4()}@spine.test`);
    const theirs = await loginAs(app, other.email);
    expect((await get(`/api/measurements/series?name=${t}`, theirs)).statusCode).toBe(404);
  });

  it('draws a value known only to the month, at that month, and in order with dated ones', async () => {
    const tag = `mo-${uuidv4().slice(0, 6)}`;
    await value(OWNER_ID, await documentFor(OWNER_ID, '2026-06-02'), tag, '2.9', { takenOn: '2026-05-12' });
    await value(OWNER_ID, await documentFor(OWNER_ID, '2026-06-02'), tag, '2.5', { takenOn: '2026-03' });
    await value(OWNER_ID, await documentFor(OWNER_ID, '2026-06-02'), tag, '2.7', { takenOn: '2026-05-02' });
    const body = (await get(`/api/measurements/series?name=${tag}`)).json() as { points: Array<{ taken_on: string; charted: boolean }> };
    expect(body.points.map(p => [p.taken_on, p.charted])).toEqual([['2026-03', true], ['2026-05-02', true], ['2026-05-12', true]]);
  });

  it('puts a test with only text values in the list but gives it no unit to chart', async () => {
    const t = `w-${uuidv4().slice(0, 6)}`;
    await value(OWNER_ID, await documentFor(OWNER_ID, '2026-01-01'), t, 'pozitiv', { unit: null, takenOn: '2026-01-01' });
    const body = (await get(`/api/measurements/series?name=${t}`)).json() as { unit: string | null; points: Array<{ charted: boolean }> };
    expect(body.unit).toBeNull();
    expect(body.points.every(p => !p.charted)).toBe(true);
  });
});

describe('what the review form offers per type', () => {
  it('lists every type with the labels the model was given', async () => {
    const types = (await get('/api/document-types')).json() as Array<{ type: string; label: string; fields: string[]; grouped: string[] }>;
    expect(types.map(t => t.type).sort()).toEqual([...DOC_TYPES].sort());
    expect(types.find(t => t.type === 'prescription')!.grouped).toContain('dose');
    expect(types.find(t => t.type === 'lab_result')!.label).toBe('Lab result');
  });
});

describe('the doctors directory', () => {
  const make = (name: string, userId = OWNER_ID, specialty?: string) => getStore().doctors.upsert(userId, { name, specialty }, new Date().toISOString());

  it('keeps what a document says about a doctor to a bounded length', async () => {
    const store = getStore();
    const id = (await store.doctors.upsert(OWNER_ID, {
      name: `Zorila ${'a'.repeat(500)}`, specialty: 's'.repeat(500), clinic: 'c'.repeat(500), licenseCode: 'X'.repeat(200),
    }, new Date().toISOString()))!;
    const doctor = (await store.doctors.find(OWNER_ID, id))!;
    expect(doctor.name.length).toBeLessThanOrEqual(120);
    expect(doctor.specialty!.length).toBe(120);
    expect(doctor.clinic!.length).toBe(120);
    expect(doctor.license_code).toBeNull(); // too long to be a code at all
    const ok = (await store.doctors.upsert(OWNER_ID, { name: 'Zorila Ok', licenseCode: 'B'.repeat(24) }, new Date().toISOString()))!;
    expect((await store.doctors.find(OWNER_ID, ok))!.license_code).toBe('B'.repeat(24));
  });

  it('lists doctors with their counts, and one doctor with their documents', async () => {
    const tag = uuidv4().slice(0, 6);
    const id = (await make(`Dr. Lister ${tag}`, OWNER_ID, 'cardiology'))!;
    const doc = await documentFor(OWNER_ID, '2026-04-01', 'Visit');
    await getStore().doctors.link(OWNER_ID, doc.id, id, 'author');

    const list = (await get('/api/doctors')).json() as Array<{ id: string; name: string; document_count: number; last_seen: string }>;
    expect(list.find(d => d.id === id)).toMatchObject({ name: `Lister ${tag}`, document_count: 1, last_seen: '2026-04-01' });

    const one = (await get(`/api/doctors/${id}`)).json() as { name: string; specialty: string; documents: Array<{ id: string; title: string; role: string }> };
    expect(one).toMatchObject({ name: `Lister ${tag}`, specialty: 'cardiology' });
    expect(one.documents).toEqual([expect.objectContaining({ id: doc.id, title: 'Visit', role: 'author' })]);
  });

  it('never shows the internal key or another user’s doctors', async () => {
    const other = await createTestUser(`d-${uuidv4()}@spine.test`);
    const tag = uuidv4().slice(0, 6);
    const theirs = (await make(`Dr. Hidden ${tag}`, other.id))!;
    const body = (await get('/api/doctors')).body;
    expect(body).not.toContain(`Hidden ${tag}`);
    expect(body).not.toContain('"key"');
    expect(body).not.toContain('user_id');
    expect((await get(`/api/doctors/${theirs}`)).statusCode).toBe(404);
    expect((await get('/api/doctors/no-such-doctor')).statusCode).toBe(404);
  });

  it('edits a name, specialty and clinic, and lets a name be shared by two people', async () => {
    const tag = uuidv4().slice(0, 6);
    const a = (await make(`Dr. Edit A ${tag}`))!; const b = (await make(`Dr. Edit B ${tag}`))!;
    expect((await send('PATCH', `/api/doctors/${a}`, { specialty: 'urology', clinic: 'MedLife' })).statusCode).toBe(200);
    expect((await get(`/api/doctors/${a}`)).json()).toMatchObject({ specialty: 'urology', clinic: 'MedLife' });
    expect((await send('PATCH', `/api/doctors/${a}`, { specialty: '' })).statusCode).toBe(200);
    expect((await get(`/api/doctors/${a}`)).json()).toMatchObject({ specialty: null, clinic: 'MedLife' });

    const clash = await send('PATCH', `/api/doctors/${a}`, { name: `Dr. Edit B ${tag}` });
    expect(clash.statusCode).toBe(200);
    expect((await get(`/api/doctors/${a}`)).json()).toMatchObject({ name: `Edit B ${tag}` });
    expect((await get(`/api/doctors/${b}`)).json()).toMatchObject({ name: `Edit B ${tag}` });
  });

  it('sets, normalises and clears a professional code, and refuses a short one or another doctor’s', async () => {
    const tag = uuidv4().slice(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, 'X');
    const a = (await make(`Dr. Coded A ${tag}`))!; const b = (await make(`Dr. Coded B ${tag}`))!;
    expect((await send('PATCH', `/api/doctors/${a}`, { license_code: `Cod. H-${tag}` })).statusCode).toBe(200);
    expect(((await get(`/api/doctors/${a}`)).json() as { license_code: string }).license_code).toBe(`H${tag}`);
    expect(((await get('/api/doctors')).json() as Array<{ id: string; license_code: string }>).find(d => d.id === a)!.license_code).toBe(`H${tag}`);

    expect((await send('PATCH', `/api/doctors/${b}`, { license_code: `h ${tag}` })).statusCode).toBe(409);
    expect((await send('PATCH', `/api/doctors/${b}`, { license_code: '12' })).statusCode).toBe(400);
    expect((await send('PATCH', `/api/doctors/${b}`, { license_code: 'x'.repeat(41) })).statusCode).toBe(400);
    expect((await send('PATCH', `/api/doctors/${b}`, { license_code: 5 })).statusCode).toBe(400);

    expect((await send('PATCH', `/api/doctors/${a}`, { license_code: '' })).statusCode).toBe(200);
    expect(((await get(`/api/doctors/${a}`)).json() as { license_code: string | null }).license_code).toBeNull();
    expect((await send('PATCH', `/api/doctors/${b}`, { license_code: `h ${tag}` })).statusCode).toBe(200);
  });

  it.each([
    ['an empty name', { name: '  ' }], ['a name that is too long', { name: 'x'.repeat(121) }], ['a specialty that is too long', { specialty: 'x'.repeat(81) }],
    ['a name that is not text', { name: 5 }], ['a field that does not exist', { key: 'hijack' }],
  ])('refuses %s', async (_n, body) => {
    const id = (await make(`Dr. Refuse ${uuidv4().slice(0, 6)}`))!;
    expect((await send('PATCH', `/api/doctors/${id}`, body)).statusCode).toBe(400);
  });

  it('merges one entry into another, and refuses what is not the user’s or the same doctor', async () => {
    const tag = uuidv4().slice(0, 6);
    const keep = (await make(`Popescu Ion ${tag}`))!; const dupe = (await make(`Popescu I. ${tag}`))!;
    const doc = await documentFor(OWNER_ID, '2026-01-01');
    await getStore().doctors.link(OWNER_ID, doc.id, dupe, 'author');

    expect((await send('POST', `/api/doctors/${keep}/merge`, { from: keep })).statusCode).toBe(400);
    expect((await send('POST', `/api/doctors/${keep}/merge`, {})).statusCode).toBe(400);
    expect((await send('POST', `/api/doctors/${keep}/merge`, { from: dupe })).statusCode).toBe(200);
    expect((await get(`/api/doctors/${dupe}`)).statusCode).toBe(404);
    expect(((await get(`/api/doctors/${keep}`)).json() as { documents: unknown[] }).documents).toHaveLength(1);

    const other = await createTestUser(`mg-${uuidv4()}@spine.test`);
    const theirs = (await make(`Theirs ${tag}`, other.id))!;
    expect((await send('POST', `/api/doctors/${keep}/merge`, { from: theirs })).statusCode).toBe(404);
    expect((await send('POST', `/api/doctors/${theirs}/merge`, { from: keep })).statusCode).toBe(404);
    expect((await getStore().doctors.find(other.id, theirs))).not.toBeNull();
  });

  it('deletes a doctor nothing refers to, and refuses one a document names', async () => {
    const tag = uuidv4().slice(0, 6);
    const free = (await make(`Dr. Free ${tag}`))!; const used = (await make(`Dr. Used ${tag}`))!;
    const doc = await documentFor(OWNER_ID, '2026-01-01');
    await getStore().doctors.link(OWNER_ID, doc.id, used, 'author');
    expect((await send('DELETE', `/api/doctors/${used}`)).statusCode).toBe(409);
    expect((await send('DELETE', `/api/doctors/${free}`)).statusCode).toBe(204);
    expect((await send('DELETE', `/api/doctors/${free}`)).statusCode).toBe(404);
  });

  it('is not editable by another user, and everything needs a session', async () => {
    const other = await createTestUser(`e-${uuidv4()}@spine.test`);
    const id = (await make(`Dr. Mine ${uuidv4().slice(0, 6)}`))!;
    const theirs = await loginAs(app, other.email);
    expect((await send('PATCH', `/api/doctors/${id}`, { name: 'Hacked' }, theirs)).statusCode).toBe(404);
    expect((await send('DELETE', `/api/doctors/${id}`, undefined, theirs)).statusCode).toBe(404);
    for (const [method, url] of [['GET', '/api/doctors'], ['GET', '/api/measurements'], ['GET', '/api/measurements/series?name=x'], ['GET', '/api/document-types'], ['PATCH', `/api/doctors/${id}`], ['POST', `/api/doctors/${id}/merge`], ['DELETE', `/api/doctors/${id}`]] as const) {
      expect((await app.inject({ method, url, payload: method === 'GET' || method === 'DELETE' ? undefined : {} })).statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe('entries that are probably one person', () => {
  const make = (name: string, specialty?: string) => getStore().doctors.upsert(OWNER_ID, { name, specialty }, new Date().toISOString()).then(id => id!);
  // Letters only and different in every position the matcher could compare (random ones with digits turned into 'q' could
  // end up near each other, and near another test's names, now and then).
  let seq = 0;
  const tag = () => { seq += 1; return `${'bcdfghjklmnpqrstvwxz'[seq % 20]}${'aeiou'[Math.floor(seq / 20) % 5]}${'bcdfghjklmnpqrstvwxz'[Math.floor(seq / 100) % 20]}zork`; };
  const suggestions = async (c = cookie) => (await get('/api/doctors/duplicates', c)).json() as Array<{ keep: { id: string; name: string }; other: { id: string; name: string } }>;
  const pairOf = (list: Awaited<ReturnType<typeof suggestions>>, a: string, b: string) => list.find(p => [p.keep.id, p.other.id].sort().join() === [a, b].sort().join());

  it('suggests the fuller name to keep when one is the other with more words', async () => {
    const t = tag();
    const short = await make(`Dr. Ioana ${t}`), full = await make(`${t} Ioana Maria`);
    const hit = pairOf(await suggestions(), short, full)!;
    expect(hit).toBeDefined();
    expect([hit.keep.id, hit.other.id]).toEqual([full, short]);
  });

  it('suggests an initial for the name it stands for', async () => {
    const t = tag();
    const initial = await make(`${t} I.`), whole = await make(`${t} Ion`);
    expect(pairOf(await suggestions(), initial, whole)).toBeDefined();
  });

  it.each([
    ['a single word, which could be anyone', (t: string) => [`Ioana`, `${t} Ioana Maria`]],
    ['two initials and no whole word', (t: string) => [`I. ${t.slice(0, 1)}.`, `Ioana ${t}`]],
    ['words that do not match', (t: string) => [`${t} Ioana`, `${t} Vasile Maria`]],
  ])('does not suggest %s', async (_n, names) => {
    const t = tag();
    const [a, b] = await Promise.all(names(t).map(n => make(n)));
    expect(pairOf(await suggestions(), a, b)).toBeUndefined();
  });

  it('does not suggest two entries with different specialties, and does when one has none or both agree', async () => {
    const t = tag();
    const cardio = await make(`${t} Ioana`, 'cardiology'), uro = await make(`${t} Ioana Maria`, 'urology');
    expect(pairOf(await suggestions(), cardio, uro)).toBeUndefined();
    const t2 = tag();
    const plain = await make(`${t2} Ioana`), known = await make(`${t2} Ioana Maria`, 'urology');
    expect(pairOf(await suggestions(), plain, known)).toBeDefined();
    const t3 = tag();
    const x = await make(`${t3} Ioana`, 'Cardiology '), y = await make(`${t3} Ioana Maria`, 'cardiology');
    expect(pairOf(await suggestions(), x, y)).toBeDefined();
  });

  it('lists each pair once, and never an entry with itself', async () => {
    const t = tag();
    const a = await make(`${t} Ioana`), b = await make(`${t} Ioana Maria`);
    const hits = (await suggestions()).filter(p => [p.keep.id, p.other.id].includes(a) && [p.keep.id, p.other.id].includes(b));
    expect(hits).toHaveLength(1);
    expect((await suggestions()).every(p => p.keep.id !== p.other.id)).toBe(true);
  });

  it('merging the suggestion removes it', async () => {
    const t = tag();
    const a = await make(`${t} Ioana`), b = await make(`${t} Ioana Maria`);
    const hit = pairOf(await suggestions(), a, b)!;
    expect((await send('POST', `/api/doctors/${hit.keep.id}/merge`, { from: hit.other.id })).statusCode).toBe(200);
    expect(pairOf(await suggestions(), a, b)).toBeUndefined();
  });

  it('only looks at the caller’s own directory', async () => {
    const other = await createTestUser(`dup-${uuidv4()}@spine.test`);
    const t = tag();
    const store = getStore(); const now = new Date().toISOString();
    // One half of the pair is mine and the other is theirs: never suggested to anyone.
    const mine = await make(`${t} Ioana`);
    const theirs = (await store.doctors.upsert(other.id, { name: `${t} Ioana Maria` }, now))!;
    expect(pairOf(await suggestions(), mine, theirs)).toBeUndefined();
    expect(pairOf(await suggestions(await loginAs(app, other.email)), mine, theirs)).toBeUndefined();
    // The `id` route name must not swallow this one.
    expect((await get('/api/doctors/duplicates')).statusCode).toBe(200);
  });

  it('needs a session, and returns no match key or user id', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/doctors/duplicates' })).statusCode).toBe(401);
    const t = tag();
    await make(`${t} Ioana`); await make(`${t} Ioana Maria`);
    const body = (await get('/api/doctors/duplicates')).body;
    expect(body).not.toContain('user_id');
    expect(body).not.toContain('"key"');
  });
});

describe('a printed code that another directory entry already holds', () => {
  it('is refused with a 409 that says the two should be merged, and changes nothing', async () => {
    const store = getStore();
    const kept = (await store.doctors.upsert(OWNER_ID, { name: 'Ana Exemplu', specialty: null, licenseCode: 'XA123456' }, '2026-01-01'))!;
    const typo = (await store.doctors.upsert(OWNER_ID, { name: 'Bianca Altcineva', specialty: null, licenseCode: 'XA123450' }, '2026-01-01'))!;
    const res = await send('PATCH', `/api/doctors/${typo}`, { license_code: 'XA123456' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/merge them instead/);
    expect((await store.doctors.listFor(OWNER_ID)).find(d => d.id === typo)?.license_code).toBe('XA123450');
    expect(kept).not.toBe(typo);
  });
});
