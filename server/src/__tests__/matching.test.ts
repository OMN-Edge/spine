import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { buildTestApp, loginSession } from './helpers/app.js';
import { OWNER_ID, seedDocument, seedSourceFile } from './helpers/seed.js';
import { getStore } from 'spine-core/store/index.js';
import { doctorSuggestion, nameSuggestion } from 'spine-core/matching/similar.js';
import { openQuestions } from 'spine-core/matching/index.js';
import { announceUpload } from 'spine-core/chat/notices.js';

/**
 * Asking the owner whether two entries are the same. What is obvious was merged when the upload was read; what is not is put as a
 * question, with the reason, and an answer of "different" is remembered. The names are invented.
 */
describe('could these be the same?', () => {
  it('sees a name written with other punctuation, a typo, and a name that is a longer form of another', () => {
    expect(nameSuggestion('tag', 'follow-up', 'follow up')).toEqual({ reason: 'punctuation', strength: 'likely' });
    expect(nameSuggestion('test', 'hemoglobina', 'hemoglobin')).toMatchObject({ strength: 'likely' });
    expect(nameSuggestion('test', 'feritin', 'ferritin')).toMatchObject({ reason: 'spelling' });
    expect(nameSuggestion('tag', 'cardio', 'cardiology')).toEqual({ reason: 'prefix', strength: 'unsure' });
  });

  it('does not suggest things that only look alike', () => {
    expect(nameSuggestion('tag', 'cardiology', 'oncology')).toBeNull();
    expect(nameSuggestion('test', 'tsh', 'ft4')).toBeNull();
    // Told apart by a number or a lone letter: two things.
    expect(nameSuggestion('provider', 'Spital A', 'Spital B')).toBeNull();
    expect(nameSuggestion('test', 'vitamin b6', 'vitamin b12')).toBeNull();
    expect(nameSuggestion('tag', 'ward 1', 'ward 2')).toBeNull();
  });

  it('sees a provider with a legal suffix, and one inside the other', () => {
    expect(nameSuggestion('provider', 'Regina Maria SRL', 'Regina Maria')).toEqual({ reason: 'legal_suffix', strength: 'likely' });
    expect(nameSuggestion('provider', 'Regina Maria', 'Regina Maria Policlinica Floreasca')).toEqual({ reason: 'contained', strength: 'unsure' });
  });

  it('sees a doctor by an initial or a longer name, is surer with a shared specialty, and never joins two codes', () => {
    const doctor = (name: string, extra: Partial<{ specialty: string; clinic: string; license_code: string }> = {}) => ({ name, specialty: null, clinic: null, license_code: null, ...extra });
    expect(doctorSuggestion(doctor('Popescu I.', { specialty: 'cardiology' }), doctor('Popescu Ion', { specialty: 'cardiology' }))).toEqual({ reason: 'initial', strength: 'likely' });
    expect(doctorSuggestion(doctor('Popescu Ion'), doctor('Popescu Ion Mihai'))).toEqual({ reason: 'fuller_name', strength: 'unsure' });
    expect(doctorSuggestion(doctor('Popescu I.', { license_code: 'A11111' }), doctor('Popescu Ion', { license_code: 'B22222' }))).toBeNull();
    expect(doctorSuggestion(doctor('Popescu I.', { specialty: 'cardiology' }), doctor('Popescu Ion', { specialty: 'neurology' }))).toBeNull();
    expect(doctorSuggestion(doctor('Popescu'), doctor('Popescu Ion'))).toBeNull();
  });
});

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
beforeAll(async () => { app = await buildTestApp(); cookie = await loginSession(app); });
afterAll(async () => { await app.close(); });
beforeEach(async () => {
  for (const f of await getStore().sourceFiles.listFor(OWNER_ID)) await getStore().sourceFiles.delete(OWNER_ID, f.id);
  for (const d of await getStore().doctors.listFor(OWNER_ID)) await getStore().doctors.remove(OWNER_ID, d.id);
  await getStore().conversations.removeAll(OWNER_ID);
  await getStore().matchDecisions.removeAll(OWNER_ID);
});

const LATER = '2999-01-01T00:00:00Z';
async function result(documentId: string, pageId: string, name: string, canonical: string, unit: string) {
  await getStore().measurements.create(OWNER_ID, { id: uuidv4(), documentId, pageId, name, canonical, valueText: '1', valueNum: 1, unit, refLow: null, refHigh: null, flag: null, takenOn: '2026-01-01', sourceSnippet: null, bbox: null, confidence: 1 });
}

/** What was already held, then an upload that brought: a doctor, a tag, a clinic and a test each written another way. */
async function scene() {
  const store = getStore();
  const old = await seedDocument({ provider: 'Regina Maria', tags: ['cardiology'], docDate: '2025-01-01' });
  await result(old.id, old.pageId!, 'Hemoglobin', 'hemoglobin', 'g/dL');
  const oldDoctor = await store.doctors.upsert(OWNER_ID, { name: 'Popescu Ion', specialty: 'cardiology', clinic: 'Regina Maria' }, '2020-01-01T00:00:00Z');
  await store.doctors.link(OWNER_ID, old.id, oldDoctor!, 'author');

  const upload = await seedSourceFile({ status: 'done' });
  const doc = await seedDocument({ sourceFileId: upload, provider: 'Regina Maria SRL', tags: ['cardio'], docDate: '2026-02-01' });
  await result(doc.id, doc.pageId!, 'Hemoglobina', 'hemoglobina', 'g/L');
  const newDoctor = await store.doctors.upsert(OWNER_ID, { name: 'Popescu I.', specialty: 'cardiology' }, LATER);
  await store.doctors.link(OWNER_ID, doc.id, newDoctor!, 'author');
  return { upload, doc, oldDoctor: oldDoctor!, newDoctor: newDoctor!, old };
}
const kinds = (qs: Awaited<ReturnType<typeof openQuestions>>) => qs.map(q => q.kind).sort();

describe('the questions an upload leaves', () => {
  it('asks about each thing it introduced that may be one the archive already had, with the reason and what decides', async () => {
    const { upload } = await scene();
    const questions = await openQuestions(OWNER_ID, upload);
    expect(kinds(questions)).toEqual(['doctor', 'provider', 'tag', 'test']);
    const doctor = questions.find(q => q.kind === 'doctor')!;
    expect(doctor).toMatchObject({ reason: 'initial', strength: 'likely', keep: 'existing' });
    expect(doctor.new.name).toBe('Popescu I.'); expect(doctor.existing!.name).toBe('Popescu Ion');
    const test = questions.find(q => q.kind === 'test')!;
    expect(test.new.canonical).toBe('hemoglobina'); expect(test.existing!.canonical).toBe('hemoglobin');
    // The same test in grams per litre and per decilitre: merging would mix the values, and the question says so.
    expect(test.unit_mismatch).toBe(true);
    expect(questions.find(q => q.kind === 'provider')).toMatchObject({ reason: 'legal_suffix', strength: 'likely' });
    expect(questions.find(q => q.kind === 'tag')).toMatchObject({ reason: 'prefix', strength: 'unsure' });
    // Likely before unsure.
    expect(questions.at(-1)!.strength).toBe('unsure');
  });

  it('asks nothing about what is plainly different', async () => {
    const { upload } = await scene();
    const otherUpload = await seedSourceFile({ status: 'done' });
    const unrelated = await seedDocument({ sourceFileId: otherUpload, provider: 'Spital Exemplu', tags: ['oncology'] });
    await result(unrelated.id, unrelated.pageId!, 'Glucose', 'glucose', 'mmol/L');
    expect(await openQuestions(OWNER_ID, otherUpload)).toEqual([]);
    expect(upload).toBeDefined();
  });

  it('does not suggest two tests that sit side by side in one document', async () => {
    const upload = await seedSourceFile({ status: 'done' });
    const doc = await seedDocument({ sourceFileId: upload });
    await result(doc.id, doc.pageId!, 'Hemoglobin', 'hemoglobin', 'g/dL');
    await result(doc.id, doc.pageId!, 'Hemoglobina glicata', 'hemoglobina glicata', '%');
    expect((await openQuestions(OWNER_ID, upload)).filter(q => q.kind === 'test')).toEqual([]);
  });

  it('forgets a question once the owner has said they are different, and once the two have been merged', async () => {
    const { upload, oldDoctor, newDoctor } = await scene();
    const first = await openQuestions(OWNER_ID, upload);
    const tag = first.find(q => q.kind === 'tag')!;
    expect((await app.inject({ method: 'POST', url: '/api/match-decisions', headers: { cookie }, payload: { id: tag.id, decision: 'different' } })).statusCode).toBe(200);
    expect(kinds(await openQuestions(OWNER_ID, upload))).toEqual(['doctor', 'provider', 'test']);

    // "Yes" is the merge itself, through the ordinary route: the new entry goes into the one that stays.
    const merged = await app.inject({ method: 'POST', url: `/api/doctors/${oldDoctor}/merge`, headers: { cookie }, payload: { from: newDoctor } });
    expect(merged.statusCode).toBe(200);
    expect(kinds(await openQuestions(OWNER_ID, upload))).toEqual(['provider', 'test']);
  });

  it('refuses a decision that is not about a question, and one with no session', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/match-decisions', headers: { cookie }, payload: { id: 'nonsense', decision: 'different' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/match-decisions', headers: { cookie }, payload: { id: 'tag:1|2', decision: 'delete everything' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/match-decisions', payload: { id: 'tag:1|2', decision: 'different' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/source-files/${uuidv4()}/matches`, headers: { cookie } })).statusCode).toBe(404);
  });
});

describe('while the upload’s grouping is not yet confirmed', () => {
  // The state the report is written in: the archive-wide test list holds this upload back, so what it brought is read from its own documents.
  it('still sees the tests it brought, asks about them, and lists them as new', async () => {
    const { upload } = await scene();
    await getStore().sourceFiles.setGroupingConfirmed(OWNER_ID, upload, false);
    const questions = await openQuestions(OWNER_ID, upload);
    const test = questions.find(q => q.kind === 'test')!;
    expect(test).toBeTruthy();
    expect(test.new.canonical).toBe('hemoglobina');
    expect(test.new.units).toEqual(['g/L']);
    expect(test.unit_mismatch).toBe(true);
    await announceUpload(OWNER_ID, upload);
    const [c] = await getStore().conversations.list(OWNER_ID, 5);
    const message = (await getStore().conversations.messages(OWNER_ID, c.id)).find(m => m.kind === 'upload')!;
    expect((message.data as { tests_new: string[] }).tests_new).toEqual(['hemoglobina']);
  });
});

describe('a code that differs from the directory’s', () => {
  it('is asked about, because the directory keeps one code per doctor and the name match leaves it as it is', async () => {
    const store = getStore();
    const known = await store.doctors.upsert(OWNER_ID, { name: 'Ionescu Maria', specialty: 'neurology', licenseCode: 'A11111' }, '2020-01-01T00:00:00Z');
    const upload = await seedSourceFile({ status: 'done' });
    const doc = await seedDocument({ sourceFileId: upload });
    // The same name arrives with another code: the name matches the entry, which keeps its own code.
    const again = await store.doctors.upsert(OWNER_ID, { name: 'Dr. Ionescu Maria', licenseCode: 'B22222' }, LATER);
    expect(again).toBe(known);
    await store.doctors.link(OWNER_ID, doc.id, again!, 'author', 'text', 'B22222');

    const questions = await openQuestions(OWNER_ID, upload);
    const clash = questions.find(q => q.kind === 'code')!;
    expect(clash).toMatchObject({ strength: 'clash', codes: { directory: 'A11111', printed: 'B22222', documents: 1 } });
    expect(clash.new.name).toBe('Ionescu Maria');
    expect(questions[0].id).toBe(clash.id); // before everything else

    // "Keep the directory's code" is remembered.
    await app.inject({ method: 'POST', url: '/api/match-decisions', headers: { cookie }, payload: { id: clash.id, decision: 'keep' } });
    expect((await openQuestions(OWNER_ID, upload)).filter(q => q.kind === 'code')).toEqual([]);
  });

  it('is gone once the directory takes the printed code', async () => {
    const store = getStore();
    const known = await store.doctors.upsert(OWNER_ID, { name: 'Ionescu Maria', licenseCode: 'A11111' }, '2020-01-01T00:00:00Z');
    const upload = await seedSourceFile({ status: 'done' });
    const doc = await seedDocument({ sourceFileId: upload });
    await store.doctors.link(OWNER_ID, doc.id, known!, 'author', 'text', 'B22222');
    expect((await openQuestions(OWNER_ID, upload)).some(q => q.kind === 'code')).toBe(true);
    expect((await app.inject({ method: 'PATCH', url: `/api/doctors/${known}`, headers: { cookie }, payload: { license_code: 'B22222' } })).statusCode).toBe(200);
    expect((await openQuestions(OWNER_ID, upload)).some(q => q.kind === 'code')).toBe(false);
  });
});

describe('the report', () => {
  it('says how many matches wait for an answer', async () => {
    const { upload } = await scene();
    await announceUpload(OWNER_ID, upload);
    const [c] = await getStore().conversations.list(OWNER_ID, 5);
    const message = (await getStore().conversations.messages(OWNER_ID, c.id)).find(m => m.kind === 'upload')!;
    expect((message.data as { matches_open: number }).matches_open).toBe(4);
    expect(message.content).toMatch(/4 matches need the owner's answer/);
  });
});
