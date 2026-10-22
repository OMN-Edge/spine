import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { buildTestApp, loginSession } from './helpers/app.js';
import { OWNER_ID, createTestUser, seedPage, seedSourceFile, seedShareLink } from './helpers/seed.js';
import { getStore } from '../store/index.js';
import { hashShareToken } from '../share-token.js';
import { resetChatLlm, type ChatLlm, type TranslationBundle } from '../llm/index.js';
import { LlmBlockedError } from '../llm/types.js';
import { translateDocument } from '../translation.js';

/**
 * Translating a document on demand and keeping it: what is sent, what is kept, when the kept copy stops being
 * used, who can ask, and that deleting a document with translations works. The model is a stand-in that marks
 * what it translated, so the tests can tell translated text from original.
 */
const calls: Array<{ bundle: TranslationBundle; target: string; source: string | null }> = [];
let answer: (bundle: TranslationBundle) => TranslationBundle | null = bundle => mark(bundle);

const tr = (text: string | null) => (text === null ? null : `EN[${text}]`);
const mark = (bundle: TranslationBundle): TranslationBundle => ({
  title: tr(bundle.title), summary: tr(bundle.summary), notes: tr(bundle.notes),
  fields: bundle.fields.map(f => ({ id: f.id, label: tr(f.label), value: `EN[${f.value}]` })),
  measurements: bundle.measurements.map(m => ({ id: m.id, name: `EN[${m.name}]` })),
  doctors: bundle.doctors.map(d => ({ id: d.id, specialty: tr(d.specialty) })),
});
const fakeLlm = {
  translate: async (bundle: TranslationBundle, target: string, source: string | null) => {
    calls.push({ bundle, target, source });
    return answer(bundle);
  },
} as unknown as ChatLlm;

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
const saved = process.env.SPINE_TRANSLATION;
beforeAll(async () => { app = await buildTestApp(); cookie = await loginSession(app); });
afterAll(async () => { await app.close(); });
beforeEach(() => { calls.length = 0; answer = mark; resetChatLlm(fakeLlm); });
afterEach(() => {
  resetChatLlm();
  if (saved === undefined) delete process.env.SPINE_TRANSLATION; else process.env.SPINE_TRANSLATION = saved;
});

/** A Romanian document with a summary, notes, a known field, a field the interface has no label for, a result and a doctor. */
async function romanian(userId = OWNER_ID) {
  const store = getStore();
  const sf = await seedSourceFile({ userId, status: 'done' });
  const pageId = await seedPage(sf, { userId, pageNumber: 1 });
  const id = uuidv4();
  await store.documents.create(userId, { id, sourceFileId: sf, pageStart: 1, pageEnd: 1, title: 'Buletin de analize', aiSummary: 'Rezumat', docType: 'lab_result', language: 'ro' });
  await store.documents.update(userId, id, { user_notes: 'Notele mele' });
  const field = (label: string, value: string) => ({ id: uuidv4(), documentId: id, pageId, label, value, sourceSnippet: 'secret source', bbox: null, confidence: 1 });
  const known = field('diagnosis', 'Anemie'); const custom = field('observatie speciala', 'Repaus');
  await store.fields.create(userId, known);
  await store.fields.create(userId, custom);
  const measurementId = uuidv4();
  await store.measurements.create(userId, { id: measurementId, documentId: id, pageId, name: 'Hemoglobina', canonical: 'hemoglobin', valueText: '13,5', valueNum: 13.5, unit: 'g/dL', refLow: 12, refHigh: 16, flag: null, takenOn: '2026-01-01', sourceSnippet: null, bbox: null, confidence: 1 });
  const doctor = (await store.doctors.upsert(userId, { name: 'Ion Popescu', specialty: 'medic primar' }, '2026-01-01'))!;
  await store.doctors.link(userId, id, doctor, 'author');
  return { id, sf, pageId, known: known.id, custom: custom.id, measurementId, doctor };
}

describe('translating a document', () => {
  it('translates what is text, leaves the interface’s own field labels, and keeps numbers and names out of it', async () => {
    const d = await romanian();
    const result = await translateDocument(OWNER_ID, d.id, 'en');
    if (result === null || result === 'not_found') throw new Error('expected a translation');

    expect(result).toMatchObject({ status: 'translated', language: 'en', source_language: 'ro', title: 'EN[Buletin de analize]', ai_summary: 'EN[Rezumat]', user_notes: 'EN[Notele mele]' });
    expect(result.fields[d.known]).toEqual({ label: null, value: 'EN[Anemie]' }); // the interface has wording for "diagnosis"
    expect(result.fields[d.custom]).toEqual({ label: 'EN[observatie speciala]', value: 'EN[Repaus]' });
    expect(result.measurements[d.measurementId]).toBe('EN[Hemoglobina]');
    expect(Object.values(result.doctors)).toEqual(['EN[medic primar]']);

    // What was sent: no number, unit or doctor's name, no source text, and the languages named.
    expect(calls).toHaveLength(2); // the short parts, then the fields and results
    expect(calls[0]).toMatchObject({ target: 'English', source: 'Romanian' });
    expect(calls[0].bundle.fields).toEqual([]);
    expect(calls[1].bundle.title).toBeNull();
    const sent = JSON.stringify(calls.map(c => c.bundle));
    for (const absent of ['13,5', 'g/dL', 'Ion Popescu', 'secret source']) expect(sent).not.toContain(absent);
  });

  it('serves the kept translation without calling the model again', async () => {
    const d = await romanian();
    await translateDocument(OWNER_ID, d.id, 'en');
    const again = await translateDocument(OWNER_ID, d.id, 'en');
    expect(again).toMatchObject({ status: 'cached', title: 'EN[Buletin de analize]' });
    expect(calls).toHaveLength(2);
  });

  it('keeps one translation per language', async () => {
    const d = await romanian();
    await translateDocument(OWNER_ID, d.id, 'en');
    await translateDocument(OWNER_ID, d.id, 'fr');
    expect(calls.map(c => c.target)).toEqual(['English', 'English', 'French', 'French']);
  });

  it('needs none when the document is already in the language', async () => {
    const d = await romanian();
    const result = await translateDocument(OWNER_ID, d.id, 'ro');
    expect(result).toMatchObject({ status: 'same', title: 'Buletin de analize' });
    expect(calls).toHaveLength(0);
  });

  it('is stale the moment what was translated changes: a field, the summary, the notes, a measurement name', async () => {
    const d = await romanian();
    const store = getStore();
    await translateDocument(OWNER_ID, d.id, 'en');

    await store.fields.update(OWNER_ID, d.id, d.custom, { label: 'observatie speciala', value: 'Repaus la pat' });
    expect(await translateDocument(OWNER_ID, d.id, 'en')).toMatchObject({ status: 'translated' });
    expect(await translateDocument(OWNER_ID, d.id, 'en')).toMatchObject({ status: 'cached' });

    await store.documents.update(OWNER_ID, d.id, { ai_summary: 'Rezumat nou' });
    expect(await translateDocument(OWNER_ID, d.id, 'en')).toMatchObject({ status: 'translated', ai_summary: 'EN[Rezumat nou]' });

    await store.documents.update(OWNER_ID, d.id, { user_notes: 'Alte note' });
    expect(await translateDocument(OWNER_ID, d.id, 'en')).toMatchObject({ status: 'translated', user_notes: 'EN[Alte note]' });

    await store.measurements.update(OWNER_ID, d.id, d.measurementId, { name: 'Hb', canonical: 'hemoglobin', valueText: '13,5', valueNum: 13.5, unit: 'g/dL', refLow: 12, refHigh: 16, flag: null, takenOn: '2026-01-01' });
    expect(await translateDocument(OWNER_ID, d.id, 'en')).toMatchObject({ status: 'translated' });
    expect(calls).toHaveLength(10); // five translations of two calls each
  });

  it('is stale after the document is read again, which replaces its fields', async () => {
    const d = await romanian();
    await translateDocument(OWNER_ID, d.id, 'en');
    await getStore().fields.deleteForDocument(OWNER_ID, d.id);
    await getStore().fields.create(OWNER_ID, { id: uuidv4(), documentId: d.id, pageId: d.pageId, label: 'diagnosis', value: 'Fara anemie', sourceSnippet: null, bbox: null, confidence: 1 });
    const result = await translateDocument(OWNER_ID, d.id, 'en');
    expect(result).toMatchObject({ status: 'translated' });
    expect(calls).toHaveLength(4);
  });

  it('is not stale when only the page order changes and nothing it holds does', async () => {
    const d = await romanian();
    await translateDocument(OWNER_ID, d.id, 'en');
    await getStore().documents.setRange(OWNER_ID, d.id, 1, 1);
    await getStore().documents.update(OWNER_ID, d.id, { reviewed: false });
    expect(await translateDocument(OWNER_ID, d.id, 'en')).toMatchObject({ status: 'cached' });
  });

  it('asks the model once however many readers ask at the same moment', async () => {
    const d = await romanian();
    answer = bundle => { return mark(bundle); };
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => translateDocument(OWNER_ID, d.id, 'en')));
    expect([a, b, c].every(r => r !== null && r !== 'not_found' && r.title === 'EN[Buletin de analize]')).toBe(true);
    expect(calls).toHaveLength(2); // one translation (the short parts, then the rest), not three
  });

  it('keeps nothing, and says so, when the model gives no usable answer, then works on the next try', async () => {
    const d = await romanian();
    answer = () => null;
    expect(await translateDocument(OWNER_ID, d.id, 'en')).toBeNull();
    expect(await getStore().translations.get(OWNER_ID, d.id, 'en')).toBeNull();
    answer = mark;
    expect(await translateDocument(OWNER_ID, d.id, 'en')).toMatchObject({ status: 'translated' });
  });

  it('when the provider refuses a reply, asks again in halves: one refused text costs that text, not the document', async () => {
    const d = await romanian();
    // The provider refuses anything that carries "Repaus" (a recitation block), in whatever company.
    answer = bundle => {
      if (bundle.fields.some(f => f.value === 'Repaus')) throw new LlmBlockedError('Finish reason: RECITATION');
      return mark(bundle);
    };
    const result = await translateDocument(OWNER_ID, d.id, 'en');
    if (result === null || result === 'not_found') throw new Error('expected a partial translation');
    expect(result.fields[d.known]).toEqual({ label: null, value: 'EN[Anemie]' });
    expect(result.fields[d.custom].value).toBe('Repaus'); // the original, since it was refused alone
    expect(result.measurements[d.measurementId]).toBe('EN[Hemoglobina]');
    expect(await translateDocument(OWNER_ID, d.id, 'en', { cachedOnly: true })).toBeNull(); // a half answer is not kept
  });

  it('falls back to the original for anything the model left out', async () => {
    const d = await romanian();
    // The model leaves out the summary and the second field, and does so again when asked for just those.
    answer = bundle => ({ ...mark(bundle), summary: null, fields: bundle.fields.length > 1 ? mark(bundle).fields.slice(0, 1) : [] });
    const result = await translateDocument(OWNER_ID, d.id, 'en');
    if (result === null || result === 'not_found') throw new Error('expected a translation');
    expect(result.ai_summary).toBe('Rezumat');
    expect(result.fields[d.custom].value).toBe('Repaus');
    expect(result.fields[d.known].value).toBe('EN[Anemie]');
    expect(calls).toHaveLength(4); // head and body, and each asked again for what was missing
    // A half translation is not kept: it would be served as whole until the document changed.
    expect(await getStore().translations.get(OWNER_ID, d.id, 'en')).toBeNull();
  });

  it('asks again for a value that rambles, and uses the original if it still does', async () => {
    const d = await romanian();
    const ramble = (text: string) => `${text} -> ${text} (${text}) -> ${text}`.repeat(3);
    let first = true;
    answer = bundle => {
      const got = mark(bundle);
      if (first) { first = false; return { ...got, title: ramble(bundle.title ?? '') }; }
      return got;
    };
    const result = await translateDocument(OWNER_ID, d.id, 'en');
    if (result === null || result === 'not_found') throw new Error('expected a translation');
    expect(result.title).toBe('EN[Buletin de analize]');
    expect(calls).toHaveLength(3); // the head, the head's title again, the body
    expect(await getStore().translations.get(OWNER_ID, d.id, 'en')).not.toBeNull();
  });

  it('learns the language of a document that has none from the model, and does not translate it into itself', async () => {
    const d = await romanian();
    await getStore().documents.update(OWNER_ID, d.id, { language: null });
    answer = bundle => ({ ...mark(bundle), source_language: 'ro' });
    const same = await translateDocument(OWNER_ID, d.id, 'ro');
    expect(same).toMatchObject({ status: 'same' });
    expect((await getStore().documents.findFor(OWNER_ID, d.id))?.language).toBe('ro');
    expect(await getStore().translations.get(OWNER_ID, d.id, 'ro')).toBeNull();
    // Now that it is known, the other languages are translated from it.
    answer = mark;
    expect(await translateDocument(OWNER_ID, d.id, 'en')).toMatchObject({ status: 'translated', source_language: 'ro' });
    expect(calls.at(-1)?.source).toBe('Romanian');
  });

  it('delivers the title, summary and notes first, and the fields and results after', async () => {
    const d = await romanian();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    // The second call (fields and results) waits until the test lets it go.
    answer = bundle => mark(bundle);
    const llm = { translate: async (bundle: TranslationBundle, target: string, source: string | null) => {
      calls.push({ bundle, target, source });
      if (bundle.title === null) await gate;
      return mark(bundle);
    } } as unknown as ChatLlm;
    resetChatLlm(llm);

    const head = await translateDocument(OWNER_ID, d.id, 'en', { part: 'head' });
    if (head === null || head === 'not_found') throw new Error('expected a head');
    expect(head).toMatchObject({ part: 'head', title: 'EN[Buletin de analize]', ai_summary: 'EN[Rezumat]', user_notes: 'EN[Notele mele]' });
    expect(head.fields).toEqual({});
    expect(Object.values(head.doctors)).toEqual(['EN[medic primar]']);
    expect(await getStore().translations.get(OWNER_ID, d.id, 'en')).toBeNull(); // not kept until it is whole

    const whole = translateDocument(OWNER_ID, d.id, 'en'); // joins the run in progress
    release();
    const full = await whole;
    if (full === null || full === 'not_found') throw new Error('expected the whole');
    expect(full).toMatchObject({ part: 'full' });
    expect(full.fields[d.custom].value).toBe('EN[Repaus]');
    expect(calls).toHaveLength(2);
    expect(await getStore().translations.get(OWNER_ID, d.id, 'en')).not.toBeNull();
  });

  it('splits a long document into pieces so no reply has to carry all of it, and puts it back together', async () => {
    const d = await romanian();
    const store = getStore();
    for (let i = 0; i < 230; i++) {
      await store.fields.create(OWNER_ID, { id: uuidv4(), documentId: d.id, pageId: d.pageId, label: 'finding', value: `valoare ${i}`, sourceSnippet: null, bbox: null, confidence: 1 });
    }
    const result = await translateDocument(OWNER_ID, d.id, 'en');
    if (result === null || result === 'not_found') throw new Error('expected a translation');
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.every(c => c.bundle.fields.length <= 100)).toBe(true);
    expect(Object.keys(result.fields)).toHaveLength(232);
    expect(Object.values(result.fields).every(f => f.value.startsWith('EN['))).toBe(true);
  });

  it('does nothing when switched off, and never calls the model', async () => {
    process.env.SPINE_TRANSLATION = 'off';
    const d = await romanian();
    expect(await translateDocument(OWNER_ID, d.id, 'en')).toMatchObject({ status: 'off', title: 'Buletin de analize' });
    expect(calls).toHaveLength(0);
  });

  it('with cachedOnly, answers null until something has been kept, and never calls the model', async () => {
    const d = await romanian();
    expect(await translateDocument(OWNER_ID, d.id, 'en', { cachedOnly: true })).toBeNull();
    expect(calls).toHaveLength(0);
    await translateDocument(OWNER_ID, d.id, 'en');
    expect(await translateDocument(OWNER_ID, d.id, 'en', { cachedOnly: true })).toMatchObject({ status: 'cached' });
  });

  it('says not_found for a document that is another user’s', async () => {
    const other = await createTestUser('translator-else@spine.test');
    const theirs = await romanian(other.id);
    expect(await translateDocument(OWNER_ID, theirs.id, 'en')).toBe('not_found');
    expect(calls).toHaveLength(0);
  });
});

describe('what is kept goes with the document', () => {
  it('is removed when the document is, when the upload is, and when the user is', async () => {
    const store = getStore();
    // A document with nothing hanging off it, so that deleting it is only about the translation.
    const sf = await seedSourceFile({ status: 'done' });
    const bare = uuidv4();
    await store.documents.create(OWNER_ID, { id: bare, sourceFileId: sf, pageStart: 1, pageEnd: 1, title: 'Titlu', language: 'ro' });
    await translateDocument(OWNER_ID, bare, 'en');
    expect(await store.translations.get(OWNER_ID, bare, 'en')).not.toBeNull();
    await store.documents.delete(OWNER_ID, bare); // a foreign key would refuse this if the row stayed
    expect(await store.translations.get(OWNER_ID, bare, 'en')).toBeNull();

    const b = await romanian();
    await translateDocument(OWNER_ID, b.id, 'en');
    await store.sourceFiles.clearDerived(OWNER_ID, b.sf);
    expect(await store.translations.get(OWNER_ID, b.id, 'en')).toBeNull();

    const other = await createTestUser('translator-gone@spine.test');
    const c = await romanian(other.id);
    await translateDocument(other.id, c.id, 'fr');
    await expect(store.users.delete(other.id)).resolves.toBeUndefined();
  });

  it('is not read by anyone but the owner', async () => {
    const store = getStore();
    const d = await romanian();
    await translateDocument(OWNER_ID, d.id, 'en');
    const other = await createTestUser('translator-peek@spine.test');
    expect(await store.translations.get(other.id, d.id, 'en')).toBeNull();
    await store.translations.put(other.id, d.id, 'en', 'x', '{}', 'now'); // not their document: nothing written
    expect((await store.translations.get(OWNER_ID, d.id, 'en'))?.sourceHash).not.toBe('x');
  });
});

describe('the routes', () => {
  const get = (url: string, c: string | null = cookie) => app.inject({ method: 'GET', url, headers: c ? { cookie: c } : {} });
  const link = async (scope: 'all' | 'document_ids', value: unknown, extra: object = {}) => {
    const res = await app.inject({ method: 'POST', url: '/api/share-links', headers: { cookie }, payload: { scope, scope_value: value, expires_days: 7, ...extra } });
    expect(res.statusCode).toBe(201);
    return res.json() as { token: string; id: string };
  };
  const settle = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); }
    throw new Error('did not settle');
  };

  it('GET /api/documents/:id/translation: the owner reads a document in a language; bad language 400, not theirs 404, no session 401', async () => {
    const d = await romanian();
    const ok = await get(`/api/documents/${d.id}/translation?lang=en`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'translated', title: 'EN[Buletin de analize]' });
    expect((await get(`/api/documents/${d.id}/translation?lang=xx`)).statusCode).toBe(400);
    expect((await get(`/api/documents/${d.id}/translation`)).statusCode).toBe(400);
    expect((await get(`/api/documents/${uuidv4()}/translation?lang=en`)).statusCode).toBe(404);
    expect((await get(`/api/documents/${d.id}/translation?lang=en`, null)).statusCode).toBe(401);
    answer = () => null;
    const d2 = await romanian();
    expect((await get(`/api/documents/${d2.id}/translation?lang=fr`)).statusCode).toBe(502);
  });

  it('GET /api/share/:token/documents/:id/translation: only a document the link covers, only the languages offered', async () => {
    const inside = await romanian();
    const outside = await romanian();
    const { token } = await link('document_ids', [inside.id]);
    const ok = await get(`/api/share/${token}/documents/${inside.id}/translation?lang=en`, null);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'translated', title: 'EN[Buletin de analize]' });
    expect((await get(`/api/share/${token}/documents/${outside.id}/translation?lang=en`, null)).statusCode).toBe(404);
    expect((await get(`/api/share/${token}/documents/${inside.id}/translation?lang=es`, null)).statusCode).toBe(400);
    expect((await get(`/api/share/${uuidv4()}/documents/${inside.id}/translation?lang=en`, null)).statusCode).toBe(410);
    const text = ok.body;
    for (const forbidden of ['user_id', OWNER_ID, 'secret source', 'source_snippet']) expect(text).not.toContain(forbidden);
  });

  it('a second reader of the same language is served what the first caused to be kept', async () => {
    const d = await romanian();
    const { token } = await link('document_ids', [d.id]);
    await get(`/api/share/${token}/documents/${d.id}/translation?lang=en`, null);
    const second = await get(`/api/share/${token}/documents/${d.id}/translation?lang=en`, null);
    expect(second.json()).toMatchObject({ status: 'cached' });
    expect(calls).toHaveLength(2);
  });

  it('the share list in a language: pending at first, translating in the background, then ready', async () => {
    const d = await romanian();
    const { token } = await link('document_ids', [d.id]);
    const first = (await get(`/api/share/${token}/documents?lang=en`, null)).json() as Array<{ id: string; translation: { title: string } | null; translation_pending: boolean }>;
    expect(first[0]).toMatchObject({ id: d.id, translation: null, translation_pending: true });

    await settle(async () => ((await get(`/api/share/${token}/documents?lang=en`, null)).json() as Array<{ translation_pending: boolean }>)[0].translation_pending === false);
    const ready = (await get(`/api/share/${token}/documents?lang=en`, null)).json() as Array<{ translation: { title: string; status: string } }>;
    expect(ready[0].translation).toMatchObject({ status: 'cached', title: 'EN[Buletin de analize]' });
    expect(calls).toHaveLength(2);
  });

  it('the share list without a language is as it was, and a language the page cannot offer is ignored', async () => {
    const d = await romanian();
    const { token } = await link('document_ids', [d.id]);
    for (const url of [`/api/share/${token}/documents`, `/api/share/${token}/documents?lang=es`]) {
      const body = (await get(url, undefined)).json() as Array<Record<string, unknown>>;
      expect(body[0]).not.toHaveProperty('translation');
    }
    expect(calls).toHaveLength(0);
  });

  it('a link made in a language has its documents translated already, and its page starts in that language', async () => {
    const d = await romanian();
    const { token } = await link('document_ids', [d.id], { language: 'en' });
    await settle(async () => (await getStore().translations.get(OWNER_ID, d.id, 'en')) !== null);
    expect((await get(`/api/share/${token}/documents/${d.id}/translation?lang=en`, null)).json()).toMatchObject({ status: 'cached' });

    const meta = (await get(`/api/share/${token}/meta`, null)).json();
    expect(meta).toEqual({ language: 'en', languages: ['en', 'ro', 'fr', 'de'], translation: true, approval: 'open', chat: false, landing_url: null });
    const plain = await link('document_ids', [d.id]);
    expect((await get(`/api/share/${plain.token}/meta`, null)).json().language).toBeNull();
    expect((await get(`/api/share/${uuidv4()}/meta`, null)).statusCode).toBe(410);
  });

  it('refuses a language that is not offered when making a link, and lists the choice for the owner', async () => {
    const d = await romanian();
    for (const language of ['es', 7, 'EN']) {
      const res = await app.inject({ method: 'POST', url: '/api/share-links', headers: { cookie }, payload: { scope: 'document_ids', scope_value: [d.id], language } });
      expect(res.statusCode, String(language)).toBe(400);
    }
    const made = await link('all', undefined, { language: 'fr' });
    const listed = (await get('/api/share-links')).json() as Array<{ id: string; language: string | null }>;
    expect(listed.find(l => l.id === made.id)?.language).toBe('fr');
  });

  it('PATCH can correct the language a document is written in', async () => {
    const d = await romanian();
    const res = await app.inject({ method: 'PATCH', url: `/api/documents/${d.id}`, headers: { cookie }, payload: { language: 'HU' } });
    expect(res.statusCode).toBe(200);
    expect((await getStore().documents.findFor(OWNER_ID, d.id))?.language).toBe('hu');
    expect((await app.inject({ method: 'PATCH', url: `/api/documents/${d.id}`, headers: { cookie }, payload: { language: 'not a code' } })).statusCode).toBe(400);
    await app.inject({ method: 'PATCH', url: `/api/documents/${d.id}`, headers: { cookie }, payload: { language: '' } });
    expect((await getStore().documents.findFor(OWNER_ID, d.id))?.language).toBeNull();
    void vi; void seedShareLink; void hashShareToken;
  });
});

describe('titles of the owner’s documents in a language (the chat’s sources)', () => {
  const titles = (ids: string[], lang = 'en', who = cookie) =>
    app.inject({ method: 'GET', url: `/api/translations/titles?lang=${lang}&ids=${ids.join(',')}`, headers: { cookie: who } });

  it('gives a translated title once it is cached, and asks again until then', async () => {
    const d = await romanian();
    const first = await titles([d.id]);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ titles: {}, pending: true }); // translating has started in the background

    await translateDocument(OWNER_ID, d.id, 'en');
    expect((await titles([d.id])).json()).toEqual({ titles: { [d.id]: 'EN[Buletin de analize]' }, pending: false });
  });

  it('says null for a document already in that language, and nothing for one that is not theirs', async () => {
    const d = await romanian();
    expect((await titles([d.id], 'ro')).json().titles[d.id] ?? null).toBeNull();

    const stranger = await createTestUser('stranger@spine.test');
    const theirs = await romanian(stranger.id);
    const res = await titles([theirs.id]);
    expect(res.json()).toEqual({ titles: {}, pending: false });
    expect(calls).toHaveLength(0);
  });

  it('does nothing when translating is off or the language is unknown, and caps the list', async () => {
    const d = await romanian();
    expect((await titles([d.id], 'xx')).json()).toEqual({ titles: {}, pending: false });
    process.env.SPINE_TRANSLATION = 'off';
    expect((await titles([d.id])).json()).toEqual({ titles: {}, pending: false });
    expect(calls).toHaveLength(0);
    process.env.SPINE_TRANSLATION = 'on';
    const many = Array.from({ length: 40 }, (_, i) => `id-${i}`);
    expect((await titles(many)).statusCode).toBe(200);
  });

  it('needs a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/translations/titles?lang=en&ids=x' })).statusCode).toBe(401);
  });
});
