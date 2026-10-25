import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { buildTestApp, loginAs, loginSession } from './helpers/app.js';
import { createTestUser, seedPage, seedSourceFile, OWNER_ID } from './helpers/seed.js';
import { getStore } from 'spine-core/store/index.js';

/**
 * One edit session is one PATCH: the details, the tags, the extracted fields and whether
 * the document is now reviewed. Checked first, written in one transaction.
 */
let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;

beforeAll(async () => {
  app = await buildTestApp();
  cookie = await loginSession(app);
});
afterAll(async () => { await app.close(); });

/** A two-page document with two fields, one on each page. */
async function document(userId = OWNER_ID) {
  const store = getStore();
  const sf = await seedSourceFile({ userId, status: 'done' });
  const p1 = await seedPage(sf, { userId, pageNumber: 1 });
  const p2 = await seedPage(sf, { userId, pageNumber: 2 });
  const id = uuidv4();
  await store.documents.create(userId, { id, sourceFileId: sf, pageStart: 1, pageEnd: 2, title: 'Original', docType: 'lab_result', provider: 'Synevo', docDate: '2026-01-01' });
  const f1 = uuidv4(); const f2 = uuidv4();
  await store.fields.create(userId, { id: f1, documentId: id, pageId: p1, label: 'diagnosis', value: 'anemia', sourceSnippet: 'anemie', bbox: { x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.2 }, confidence: 0.9 });
  await store.fields.create(userId, { id: f2, documentId: id, pageId: p2, label: 'dose', value: '50 mg', sourceSnippet: '50', bbox: null, confidence: 0.7 });
  return { id, p1, p2, f1, f2 };
}

const patch = (id: string, payload: object, c = cookie) => app.inject({ method: 'PATCH', url: `/api/documents/${id}`, payload, headers: { cookie: c } });
const load = async (id: string) => (await app.inject({ method: 'GET', url: `/api/documents/${id}`, headers: { cookie } })).json() as {
  title: string | null; doc_date: string | null; provider: string | null; doc_type: string; ai_summary: string | null;
  user_notes: string | null; reviewed: number; tags: string[]; fields: Array<{ id: string; label: string; value: string; page_id: string; source_snippet: string | null; bbox_x0: number | null; confidence: number | null }>;
};

describe('saving an edit session', () => {
  it('applies details, tags, field changes and the reviewed flag together', async () => {
    const { id, p2, f1, f2 } = await document();
    const res = await patch(id, {
      title: '  Buletin de analize  ', doc_date: '2026-02-03', provider: 'MedLife', doc_type: 'imaging',
      ai_summary: 'Edited summary.', user_notes: 'ask the doctor', tags: ['lab', 'follow-up-needed'], reviewed: true,
      fields: {
        update: [{ id: f1, label: 'Diagnosis', value: 'iron deficiency' }],
        remove: [f2],
        add: [{ label: 'Follow-up', value: 'in six weeks', page_id: p2 }],
      },
    });
    expect(res.statusCode).toBe(200);

    const after = await load(id);
    expect([after.title, after.doc_date, after.provider, after.doc_type]).toEqual(['Buletin de analize', '2026-02-03', 'MedLife', 'imaging']);
    expect([after.ai_summary, after.user_notes, after.reviewed]).toEqual(['Edited summary.', 'ask the doctor', 1]);
    expect(after.tags.sort()).toEqual(['follow-up-needed', 'lab']);
    expect(after.fields.map(f => `${f.label}=${f.value}`).sort()).toEqual(['Diagnosis=iron deficiency', 'Follow-up=in six weeks']);
  });

  it('keeps where a corrected field was read from, and marks a new one as having no source', async () => {
    const { id, p2, f1 } = await document();
    await patch(id, { fields: { update: [{ id: f1, label: 'diagnosis', value: 'changed' }], add: [{ label: 'new', value: 'v', page_id: p2 }] } });
    const { fields } = await load(id);
    const changed = fields.find(f => f.id === f1)!;
    expect([changed.value, changed.source_snippet, changed.bbox_x0]).toEqual(['changed', 'anemie', 0.1]);
    const added = fields.find(f => f.label === 'new')!;
    expect([added.page_id, added.source_snippet, added.bbox_x0, added.confidence]).toEqual([p2, null, null, null]);
  });

  it('clears a detail when it is sent empty', async () => {
    const { id } = await document();
    await patch(id, { title: '', provider: '   ', doc_date: '' });
    const after = await load(id);
    expect([after.title, after.provider, after.doc_date]).toEqual([null, null, null]);
  });

  it('still accepts the small patches the app made before (just notes, just reviewed)', async () => {
    const { id } = await document();
    expect((await patch(id, { user_notes: 'n' })).statusCode).toBe(200);
    expect((await patch(id, { reviewed: true })).statusCode).toBe(200);
    expect((await load(id)).reviewed).toBe(1);
  });
});

describe('a bad edit changes nothing', () => {
  async function untouched(id: string, before: Awaited<ReturnType<typeof load>>) {
    const after = await load(id);
    expect(after).toEqual(before);
  }

  it('is all or nothing: one unknown field id undoes the valid edits beside it', async () => {
    const { id, f1 } = await document();
    const before = await load(id);
    const res = await patch(id, {
      title: 'Should not stick', reviewed: true, tags: ['x'],
      fields: { update: [{ id: f1, label: 'a', value: 'b' }], remove: ['not-a-field'] },
    });
    expect(res.statusCode).toBe(400);
    await untouched(id, before);
  });

  it.each([
    ['an empty label', { update: 'ID', label: '', value: 'v' }],
    ['a blank value', { update: 'ID', label: 'l', value: '   ' }],
    ['a label that is too long', { update: 'ID', label: 'x'.repeat(81), value: 'v' }],
    ['a value that is too long', { update: 'ID', label: 'l', value: 'x'.repeat(2001) }],
    ['a label that is not text', { update: 'ID', label: 5, value: 'v' }],
  ])('refuses %s', async (_name, edit) => {
    const { id, f1 } = await document();
    const before = await load(id);
    const { update: _u, ...rest } = edit;
    const res = await patch(id, { fields: { update: [{ id: f1, ...rest }] } });
    expect(res.statusCode).toBe(400);
    await untouched(id, before);
  });

  it('refuses a field changed and removed in the same request', async () => {
    const { id, f1 } = await document();
    const before = await load(id);
    expect((await patch(id, { fields: { update: [{ id: f1, label: 'a', value: 'b' }], remove: [f1] } })).statusCode).toBe(400);
    await untouched(id, before);
  });

  it('refuses a new field on a page that is not this document’s', async () => {
    const { id } = await document();
    const other = await document();
    const before = await load(id);
    const res = await patch(id, { fields: { add: [{ label: 'l', value: 'v', page_id: other.p1 }] } });
    expect(res.statusCode).toBe(400);
    expect((await patch(id, { fields: { add: [{ label: 'l', value: 'v' }] } })).statusCode).toBe(400);
    await untouched(id, before);
  });

  it('refuses a date that is not a real day, a type the app does not know, and a non-boolean reviewed', async () => {
    const { id } = await document();
    const before = await load(id);
    for (const body of [{ doc_date: '2026-13-45' }, { doc_date: 'yesterday' }, { doc_type: 'invoice' }, { reviewed: 'yes' }, { title: 'x'.repeat(201) }, { tags: ['ok', ''] }, { tags: 'lab' }]) {
      expect((await patch(id, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    await untouched(id, before);
  });

  it('refuses an unreasonable number of field changes in one request', async () => {
    const { id, p1 } = await document();
    const add = Array.from({ length: 201 }, (_, i) => ({ label: `l${i}`, value: 'v', page_id: p1 }));
    expect((await patch(id, { fields: { add } })).statusCode).toBe(400);
    expect((await load(id)).fields).toHaveLength(2);
  });

  it('refuses a field list that is not lists', async () => {
    const { id } = await document();
    expect((await patch(id, { fields: { update: 'x' } })).statusCode).toBe(400);
    expect((await patch(id, { fields: { remove: { a: 1 } } })).statusCode).toBe(400);
  });
});

describe('another user’s data', () => {
  it('cannot be edited through this user’s document, or at all', async () => {
    const mine = await document();
    const intruder = await createTestUser(`edit-${uuidv4()}@spine.test`);
    const theirs = await document(intruder.id);

    // Their field id on my document: not found, and theirs is untouched.
    const res = await patch(mine.id, { fields: { update: [{ id: theirs.f1, label: 'hacked', value: 'hacked' }] } });
    expect(res.statusCode).toBe(400);
    expect((await patch(mine.id, { fields: { remove: [theirs.f1] } })).statusCode).toBe(400);
    const theirFields = await getStore().fields.listForDocument(intruder.id, theirs.id);
    expect(theirFields.map(f => f.value).sort()).toEqual(['50 mg', 'anemia']);

    // Their document: not found, the same answer as for one that does not exist.
    expect((await patch(theirs.id, { title: 'mine now' })).statusCode).toBe(404);
    expect((await patch('no-such-document', { title: 'x' })).statusCode).toBe(404);
    expect((await getStore().documents.findFor(intruder.id, theirs.id))!.title).toBe('Original');
  });

  it('cannot reach a field of a document that is not the one named', async () => {
    const a = await document();
    const b = await document();
    expect((await patch(a.id, { fields: { update: [{ id: b.f1, label: 'x', value: 'y' }] } })).statusCode).toBe(400);
    expect((await load(b.id)).fields.find(f => f.id === b.f1)!.value).toBe('anemia');
  });

  it('requires a session', async () => {
    const { id } = await document();
    const res = await app.inject({ method: 'PATCH', url: `/api/documents/${id}`, payload: { title: 'x' } });
    expect(res.statusCode).toBe(401);
  });

  it('is refused for a second user’s own session on the first user’s document', async () => {
    const mine = await document();
    const intruder = await createTestUser(`other-${uuidv4()}@spine.test`);
    const theirCookie = await loginAs(app, intruder.email);
    expect((await patch(mine.id, { title: 'x' }, theirCookie)).statusCode).toBe(404);
  });
});

describe('the store refuses on its own, whatever the route checked', () => {
  it('will not change or remove a field that is another user’s', async () => {
    const mine = await document();
    const intruder = await createTestUser(`store-${uuidv4()}@spine.test`);
    const theirs = await document(intruder.id);
    const store = getStore();

    expect(await store.fields.update(OWNER_ID, theirs.id, theirs.f1, { label: 'x', value: 'y' })).toBe(false);
    expect(await store.fields.update(OWNER_ID, mine.id, theirs.f1, { label: 'x', value: 'y' })).toBe(false);
    expect(await store.fields.remove(OWNER_ID, theirs.id, theirs.f1)).toBe(false);
    expect(await store.fields.remove(OWNER_ID, mine.id, theirs.f1)).toBe(false);
    expect((await store.fields.listForDocument(intruder.id, theirs.id)).map(f => f.value).sort()).toEqual(['50 mg', 'anemia']);
  });

  it('will not change or remove a field through a document it does not belong to', async () => {
    const a = await document();
    const b = await document();
    const store = getStore();
    expect(await store.fields.update(OWNER_ID, a.id, b.f1, { label: 'x', value: 'y' })).toBe(false);
    expect(await store.fields.remove(OWNER_ID, a.id, b.f1)).toBe(false);
    expect((await store.fields.listForDocument(OWNER_ID, b.id)).find(f => f.id === b.f1)!.value).toBe('anemia');
  });

  it('does change and remove the user’s own field on its own document', async () => {
    const { id, f1, f2 } = await document();
    const store = getStore();
    expect(await store.fields.update(OWNER_ID, id, f1, { label: 'l', value: 'v' })).toBe(true);
    expect(await store.fields.remove(OWNER_ID, id, f2)).toBe(true);
    expect((await store.fields.listForDocument(OWNER_ID, id)).map(f => f.label)).toEqual(['l']);
  });
});

describe('editing a document’s doctors keeps what ties them to it', () => {
  async function withDoctor(name: string, code: string | null, source: 'text' | 'stamp' | 'signature', printed: string | null) {
    const store = getStore();
    const sf = await seedSourceFile({ status: 'done' });
    await seedPage(sf, { pageNumber: 1 });
    const id = uuidv4();
    await store.documents.create(OWNER_ID, { id, sourceFileId: sf, pageStart: 1, pageEnd: 1, title: 'Visit', docDate: '2026-02-01' });
    const doctor = (await store.doctors.upsert(OWNER_ID, { name, specialty: 'cardiology', licenseCode: code }, '2026-01-01'))!;
    await store.doctors.link(OWNER_ID, id, doctor, 'author', source, printed);
    return { id, doctor };
  }
  const patch = async (id: string, doctors: object[]) => (await app.inject({ method: 'PATCH', url: `/api/documents/${id}`, payload: { doctors }, headers: { cookie } }));

  it('a doctor left as they were stays the same entry, with the code and where they were read', async () => {
    const { id, doctor } = await withDoctor('Elena Marinescu', 'X12345', 'stamp', 'X12345');
    const res = await patch(id, [{ id: doctor, name: 'Elena Marinescu', specialty: 'cardiology and internal medicine', role: 'author' }]);
    expect(res.statusCode).toBe(200);
    const [link] = await getStore().doctors.linkInfo(OWNER_ID, id);
    expect(link).toEqual({ doctor_id: doctor, role: 'author', source: 'stamp', printed_code: 'X12345' });
    expect((await getStore().doctors.find(OWNER_ID, doctor))!.license_code).toBe('X12345');
  });

  it('a spelling fixed to a name the directory has points at that entry; the old entry keeps its code and is not renamed', async () => {
    const { id, doctor: typo } = await withDoctor('Radu Tipescu', 'T55555', 'text', null);
    const real = (await getStore().doctors.upsert(OWNER_ID, { name: 'Radu Tipescu-Dan', specialty: null, licenseCode: null }, '2026-01-02'))!;
    const res = await patch(id, [{ id: typo, name: 'Radu Tipescu-Dan', specialty: null, role: 'author' }]);
    expect(res.statusCode).toBe(200);
    expect((await getStore().doctors.linkInfo(OWNER_ID, id)).map(l => l.doctor_id)).toEqual([real]);
    const old = await getStore().doctors.find(OWNER_ID, typo);
    expect(old).toMatchObject({ name: 'Radu Tipescu', license_code: 'T55555' });
  });

  it('a name that is new makes a new entry without the old one’s code', async () => {
    const { id, doctor } = await withDoctor('Maria Kovacs', 'K98765', 'text', null);
    await patch(id, [{ id: doctor, name: 'Vlad Ionescu', specialty: null, role: 'author' }]);
    const [link] = await getStore().doctors.linkInfo(OWNER_ID, id);
    expect(link.doctor_id).not.toBe(doctor);
    expect((await getStore().doctors.find(OWNER_ID, link.doctor_id))!.license_code).toBeNull();
    expect((await getStore().doctors.find(OWNER_ID, doctor))!.license_code).toBe('K98765');
    // Reading the same name again finds that entry.
    const again = await getStore().doctors.upsert(OWNER_ID, { name: 'ionescu VLAD', specialty: null }, '2026-03-01');
    expect(again).toBe(link.doctor_id);
  });

  it('two people of one name: the entry chosen stays, and “new” adds another person', async () => {
    const { id, doctor: first } = await withDoctor('Andrei Lupu', 'L11111', 'text', null);
    const second = (await getStore().doctors.upsert(OWNER_ID, { name: 'Andrei Lupu', licenseCode: 'L22222', newPerson: true }, '2026-01-03'))!;
    expect(second).not.toBe(first);
    // Choosing the second by id keeps it, though the name matches the first.
    await patch(id, [{ id: second, name: 'Andrei Lupu', specialty: null, role: 'author' }]);
    expect((await getStore().doctors.linkInfo(OWNER_ID, id)).map(l => l.doctor_id)).toEqual([second]);
    // A row with no id and `new` is a third person.
    await patch(id, [{ id: second, name: 'Andrei Lupu', specialty: null, role: 'author' }, { name: 'Andrei Lupu', specialty: null, role: 'referrer', new: true }]);
    const held = (await getStore().doctors.linkInfo(OWNER_ID, id)).map(l => l.doctor_id);
    expect(held).toHaveLength(2);
    expect(new Set([first, second, ...held]).size).toBe(3);
  });
});
