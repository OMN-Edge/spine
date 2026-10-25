import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { buildTestApp, loginSession } from './helpers/app.js';
import { OWNER_ID, createTestUser, seedPage, seedSourceFile, TEST_PASSWORD } from './helpers/seed.js';
import { getStore, getAccountsStore } from 'spine-core/store/index.js';
import { announceUpload } from 'spine-core/chat/notices.js';

const mockStartJob = vi.hoisted(() => vi.fn());
vi.mock('spine-core/ingestion/pipeline.js', () => ({ startIngestionJob: mockStartJob, getJobStatus: vi.fn().mockReturnValue(null) }));

/**
 * A file attached in the chat is the ordinary upload, tied to the conversation it was attached in, so what happens to it is
 * reported there; and the report says what reading it added: doctors, possible duplicates, new tests, whether pages look mixed.
 */
let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
const dir = join(tmpdir(), `spine-attach-${Date.now()}`);

beforeAll(async () => { mkdirSync(dir, { recursive: true }); process.env.DATA_DIR = dir; app = await buildTestApp(); cookie = await loginSession(app); });
afterAll(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(async () => {
  for (const f of await getStore().sourceFiles.listFor(OWNER_ID)) await getStore().sourceFiles.delete(OWNER_ID, f.id);
  await getStore().conversations.removeAll(OWNER_ID);
  for (const d of await getStore().doctors.listFor(OWNER_ID)) await getStore().doctors.remove(OWNER_ID, d.id);
  mockStartJob.mockClear();
});

const B = 'AttachBoundary';
function form(parts: Array<{ field?: [string, string]; file?: { name: string; content: Buffer } }>): Buffer {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    if (p.field) chunks.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${p.field[0]}"\r\n\r\n${p.field[1]}\r\n`));
    if (p.file) chunks.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="files"; filename="${p.file.name}"\r\nContent-Type: application/pdf\r\n\r\n`), p.file.content, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${B}--`));
  return Buffer.concat(chunks);
}
const pdf = (text: string) => Buffer.from(`%PDF-1.4 ${text}`);
const attach = (parts: Parameters<typeof form>[0], c = cookie) =>
  app.inject({ method: 'POST', url: '/api/chat/attachments', headers: { cookie: c, 'content-type': `multipart/form-data; boundary=${B}` }, payload: form(parts) });

describe('attaching a file in the chat', () => {
  it('starts a conversation named after the file, reads it as an upload, and says so in the conversation', async () => {
    const res = await attach([{ file: { name: 'results-march.pdf', content: pdf('first scan') } }]);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.conversation.title).toBe('results-march.pdf');
    expect(body.files).toEqual([expect.objectContaining({ name: 'results-march.pdf', state: 'reading', upload_id: expect.any(String) })]);
    expect(mockStartJob).toHaveBeenCalledWith(body.files[0].upload_id, OWNER_ID);

    expect((await getStore().sourceFiles.findFor(OWNER_ID, body.files[0].upload_id))!.chat_conversation_id).toBe(body.conversation.id);
    const messages = await getStore().conversations.messages(OWNER_ID, body.conversation.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'user', kind: 'attachment' });
    expect(messages[0].content).toMatch(/Being read: results-march\.pdf/);
  });

  it('adds to the conversation named before the files, several files at once, and says what was not accepted', async () => {
    const start = (await attach([{ file: { name: 'one.pdf', content: pdf('one') } }])).json();
    const res = await attach([
      { field: ['conversation_id', start.conversation.id] },
      { file: { name: 'two.pdf', content: pdf('two') } },
      { file: { name: 'one-again.pdf', content: pdf('one') } },
      { file: { name: 'notes.txt', content: Buffer.from([0, 1, 2, 255]) } },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json().conversation.id).toBe(start.conversation.id);
    expect(res.json().files.map((f: { state: string }) => f.state)).toEqual(['reading', 'already_held', 'skipped']);
    expect((await getStore().conversations.messages(OWNER_ID, start.conversation.id))).toHaveLength(2);
  });

  it('refuses a conversation that is not theirs before saving any file, and nothing at all', async () => {
    await createTestUser('attacher@spine.test');
    const other = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'attacher@spine.test', password: TEST_PASSWORD } })).cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const mine = (await attach([{ file: { name: 'mine.pdf', content: pdf('mine') } }])).json();
    const before = (await getStore().sourceFiles.listFor(OWNER_ID)).length;
    const res = await attach([{ field: ['conversation_id', mine.conversation.id] }, { file: { name: 'sneaky.pdf', content: pdf('sneaky') } }], other);
    expect(res.statusCode).toBe(404);
    expect((await getStore().sourceFiles.listFor(OWNER_ID)).length).toBe(before);
    expect(await getStore().sourceFiles.listFor((await getAccountsStore().users.findByEmail('attacher@spine.test'))!.id)).toEqual([]);
    expect((await attach([{ field: ['conversation_id', 'x'.repeat(100)] }, { file: { name: 'a.pdf', content: pdf('a') } }])).statusCode).toBe(404);
  });

  it('needs a file and a session', async () => {
    expect((await attach([{ field: ['note', 'nothing attached'] }])).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/chat/attachments', headers: { 'content-type': `multipart/form-data; boundary=${B}` }, payload: form([]) })).statusCode).toBe(401);
  });
});

/** An upload that has been read: documents with the doctors, tests and pages the test gives it. */
async function readUpload(options: { mixed?: boolean } = {}) {
  const attached = (await attach([{ file: { name: 'export.pdf', content: pdf(`export ${uuidv4()}`) } }])).json();
  const upload = attached.files[0].upload_id as string;
  await getStore().sourceFiles.setStatus(OWNER_ID, upload, 'done');
  const LAB = (n: number) => `Laborator Exemplu SRL Raport nr. LAB-2026-00417 Pagina ${n} din 2 Data 12.03.2026 Hemoglobina Leucocite Trombocite rezultate ${n}`;
  const DIS = (n: number) => `Spital Exemplu Foaie de externare ADM-884201 Pagina ${n} din 2 Internat 02.04.2026 diagnostic tratament ${n}`;
  const pages = options.mixed
    ? [LAB(1), DIS(1), LAB(2), DIS(2)]
    : [LAB(1), LAB(2), DIS(1), DIS(2)];
  for (const [i, text] of pages.entries()) await seedPage(upload, { pageNumber: i + 1, rawText: text });
  const first = uuidv4(); const second = uuidv4();
  await getStore().documents.create(OWNER_ID, { id: first, sourceFileId: upload, pageStart: 1, pageEnd: 2, docType: 'lab_result', docDate: '2026-03-12' });
  await getStore().documents.create(OWNER_ID, { id: second, sourceFileId: upload, pageStart: 3, pageEnd: 4, docType: 'discharge_note', docDate: '2026-04-02' });
  return { upload, first, second, conversation: attached.conversation.id as string };
}

describe('the report of a finished upload', () => {
  it('lands in the conversation the file was attached in, unread, and starts no conversation of its own', async () => {
    const { upload, conversation } = await readUpload();
    await announceUpload(OWNER_ID, upload);
    const list = await getStore().conversations.list(OWNER_ID, 10);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: conversation, unread: true });
    const messages = await getStore().conversations.messages(OWNER_ID, conversation);
    expect(messages.map(m => m.kind)).toEqual(['attachment', 'upload']);
    expect(messages[1].role).toBe('assistant');
  });

  it('says which doctors it added and which it found, the pairs that may be one person, and the tests it introduced', async () => {
    const { upload, first, second } = await readUpload();
    const long = new Date(Date.now() + 60_000).toISOString();
    const store = getStore();
    const known = await store.doctors.upsert(OWNER_ID, { name: 'Popescu Ion', specialty: 'cardiology' }, '2020-01-01T00:00:00Z');
    const fresh = await store.doctors.upsert(OWNER_ID, { name: 'Popescu I.', specialty: 'cardiology' }, long);
    const other = await store.doctors.upsert(OWNER_ID, { name: 'Zorila Maria' }, long);
    await store.doctors.link(OWNER_ID, first, known!, 'author');
    await store.doctors.link(OWNER_ID, first, fresh!, 'referrer');
    await store.doctors.link(OWNER_ID, second, other!, 'author');
    const page = (await store.pages.listForSourceFile(OWNER_ID, upload))[0].id;
    const test = (documentId: string, canonical: string) => store.measurements.create(OWNER_ID, { id: uuidv4(), documentId, pageId: page, name: canonical, canonical, valueText: '1', valueNum: 1, unit: null, refLow: null, refHigh: null, flag: null, takenOn: '2026-03-12', sourceSnippet: null, bbox: null, confidence: 1 });
    await test(first, 'hemoglobin'); await test(second, 'hemoglobin');
    await test(first, 'ferritin');
    // An earlier upload already had hemoglobin; ferritin is new.
    const earlier = await seedSourceFile({ status: 'done' });
    const earlierDoc = uuidv4();
    await store.documents.create(OWNER_ID, { id: earlierDoc, sourceFileId: earlier, pageStart: 1, pageEnd: 1, docType: 'other' });
    await store.measurements.create(OWNER_ID, { id: uuidv4(), documentId: earlierDoc, pageId: await seedPage(earlier, { pageNumber: 1 }), name: 'hemoglobin', canonical: 'hemoglobin', valueText: '2', valueNum: 2, unit: null, refLow: null, refHigh: null, flag: null, takenOn: '2025-01-01', sourceSnippet: null, bbox: null, confidence: 1 });

    await announceUpload(OWNER_ID, upload);
    const data = (await store.conversations.messages(OWNER_ID, (await store.conversations.list(OWNER_ID, 5))[0].id)).find(m => m.kind === 'upload')!.data as {
      doctors_added: string[]; doctors_matched: number; possible_duplicates: Array<[string, string]>; tests_new: string[];
    };
    expect(data.doctors_added.sort()).toEqual(['Popescu I.', 'Zorila Maria']);
    expect(data.doctors_matched).toBe(1);
    expect(data.possible_duplicates).toHaveLength(1);
    expect(data.possible_duplicates[0].sort()).toEqual(['Popescu I.', 'Popescu Ion']);
    expect(data.tests_new).toEqual(['ferritin']);
  });

  it('notes, from the pages’ own text and with no model, when the documents look cut from mixed pages', async () => {
    const aligned = await readUpload();
    await announceUpload(OWNER_ID, aligned.upload);
    const mixed = await readUpload({ mixed: true });
    await announceUpload(OWNER_ID, mixed.upload);
    const notice = async (conversation: string) => (await getStore().conversations.messages(OWNER_ID, conversation)).find(m => m.kind === 'upload')!;
    expect((await notice(aligned.conversation)).data).toMatchObject({ looks_mixed: false });
    expect((await notice(mixed.conversation)).data).toMatchObject({ looks_mixed: true });
    expect((await notice(mixed.conversation)).content).toMatch(/may be worth checking/);
  });
});
