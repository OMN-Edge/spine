import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildTestApp, loginAs, loginSession } from './helpers/app.js';
import { createTestUser, seedDocument, seedSourceFile } from './helpers/seed.js';
import { getStore } from 'spine-core/store/index.js';

const OWNER = 'user-owner';
import { hasPoppler } from 'spine-core/testing/tools.js';

process.env.SPINE_DB_PATH = ':memory:';
let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spine-demo-'));
  process.env.DATA_DIR = dir;
  app = await buildTestApp();
  cookie = await loginSession(app);
});
afterAll(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, c = cookie) =>
  app.inject({ method, url, headers: { cookie: c }, ...(payload === undefined ? {} : { payload: payload as object }) });

async function untilSettled(userId: string) {
  for (let i = 0; i < 200; i++) {
    const uploads = (await getStore().sourceFiles.listFor(userId)).filter(u => u.sample);
    if (uploads.length > 0 && uploads.every(u => u.status === 'done' || u.status === 'error')) return uploads;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('the sample records did not settle');
}

describe.skipIf(!hasPoppler)('POST /api/demo', () => {
  const store = () => getStore();
  const docs = async () => (await call('GET', '/api/documents')).json() as Array<{ id: string; title: string | null; doc_type: string; reviewed: boolean; doc_date: string }>;

  it('writes the sample archive without a model, marks it, links and groups it as a person would have, and removes only it', async () => {
    expect((await call('GET', '/api/demo')).json()).toEqual({ loaded: false, processing: false });

    const started = await call('POST', '/api/demo', { language: 'en' });
    expect(started.statusCode).toBe(202);
    expect(started.json().loaded).toBe(true);
    const uploads = await untilSettled(OWNER);
    expect(uploads).toHaveLength(7);
    expect(uploads.every(u => u.status === 'done' && u.sample)).toBe(true);

    // the documents, read: in Romanian, dated, with their results and doctors
    const held = await docs();
    expect(held).toHaveLength(7);
    expect(held.filter(d => !d.reviewed)).toEqual([]);
    const lab = held.find(d => d.doc_type === 'lab_result')!;
    const results = await store().measurements.listForDocument(OWNER, lab.id);
    expect(results.map(m => m.canonical).sort()).toEqual(['anti-tpo antibodies', 'free t4', 'tsh']);
    expect((await store().doctors.forDocument(OWNER, lab.id)).map(d => d.name)).toEqual(['Marinescu Elena']);

    // the links and episodes arrive after the documents: the thyroid cycle and the eye check, each its own episode
    let episodes: Array<{ id: string; state: string; title: string; document_ids: string[] }> = [];
    for (let i = 0; i < 80 && episodes.length < 2; i++) { episodes = (await call('GET', '/api/episodes')).json(); if (episodes.length < 2) await new Promise(r => setTimeout(r, 100)); }
    expect(episodes.map(e => e.state)).toEqual(['confirmed', 'confirmed']);
    expect(episodes.map(e => e.document_ids.length).sort()).toEqual([2, 4]);
    expect(episodes.every(e => e.title.length > 10)).toBe(true);
    const thyroid = episodes.find(e => e.document_ids.length === 4)!;
    expect(thyroid.title).toMatch(/hypothyroidism/i);
    const links = await store().links.all(OWNER);
    expect(links.length).toBeGreaterThanOrEqual(5);
    expect(links.every(l => l.state === 'confirmed' && l.source === 'owner')).toBe(true);
    // the eye check and the thyroid blood test of the same day and the same clinic are not related
    const byTitle = (re: RegExp) => held.find(d => re.test(d.title ?? ''))!;
    const eye = byTitle(/oftalmologie/i);
    expect(links.some(l => [l.from_document_id, l.to_document_id].includes(eye.id) && [l.from_document_id, l.to_document_id].includes(lab.id))).toBe(false);

    // translated by hand: the reader's language is served from what is kept, whether or not a model is configured
    const english = (await call('GET', `/api/documents/${lab.id}/translation?lang=en`)).json() as { status: string; title: string; ai_summary: string; measurements: Record<string, string> };
    expect(english.status).toBe('cached');
    expect(english.title).toMatch(/Thyroid hormone tests/);
    expect(english.ai_summary).toMatch(/TSH/);
    expect(Object.values(english.measurements).sort()).toEqual(['Anti-TPO antibodies', 'FT4 (free thyroxine)', 'TSH (thyroid-stimulating hormone)']);
    expect(((await call('GET', `/api/documents/${lab.id}/translation?lang=fr`)).json() as { title: string }).title).toMatch(/Bilan des hormones thyroïdiennes/);
    expect(((await call('GET', `/api/documents/${lab.id}/translation?lang=de`)).json() as { title: string }).title).toMatch(/Schilddrüsenwerte/);
    // and the Romanian original is what a Romanian reader has, with nothing to translate
    expect(((await call('GET', `/api/documents/${lab.id}/translation?lang=ro`)).json() as { status: string }).status).toBe('same');

    expect((await call('POST', '/api/demo', { language: 'en' })).statusCode).toBe(409); // not twice
    expect((await call('POST', '/api/demo', { language: 'xx' })).statusCode).toBe(400);

    // The person's own record is not the sample's, and removing the samples takes the documents, their links and episodes, and what was kept of their translations, and nothing else.
    const own = await seedSourceFile({ userId: OWNER });
    const mine = await seedDocument({ userId: OWNER, sourceFileId: own, docDate: '2026-05-05', provider: 'Own Clinic' });
    expect((await call('DELETE', '/api/demo')).statusCode).toBe(200);
    expect((await docs()).map(d => d.id)).toEqual([mine.id]);
    expect((await call('GET', '/api/episodes')).json()).toEqual([]);
    expect(await store().links.all(OWNER)).toEqual([]);
    expect((await call('DELETE', '/api/demo')).statusCode).toBe(404);
  }, 60_000);

  it('keeps an episode the person added their own document to, when the sample is removed', async () => {
    await call('DELETE', '/api/demo');
    expect((await call('POST', '/api/demo', { language: 'en' })).statusCode).toBe(202);
    await untilSettled(OWNER);
    let episodes: Array<{ id: string; document_ids: string[] }> = [];
    for (let i = 0; i < 80 && episodes.length < 2; i++) { episodes = (await call('GET', '/api/episodes')).json(); if (episodes.length < 2) await new Promise(r => setTimeout(r, 100)); }
    const own = await seedSourceFile({ userId: OWNER });
    const mine = await seedDocument({ userId: OWNER, sourceFileId: own, docDate: '2025-06-03', provider: 'Own Clinic' });
    const target = episodes.find(e => e.document_ids.length === 2)!;
    expect((await call('PATCH', `/api/episodes/${target.id}`, { document_ids: [...target.document_ids, mine.id] })).statusCode).toBe(200);
    expect((await call('DELETE', '/api/demo')).statusCode).toBe(200);
    const left = (await call('GET', '/api/episodes')).json() as Array<{ id: string; document_ids: string[] }>;
    expect(left.map(e => e.id)).toEqual([target.id]);
    expect(left[0]!.document_ids).toEqual([mine.id]);
  }, 60_000);

  it('names the episodes in the screen\u2019s language', async () => {
    await call('DELETE', '/api/demo');
    expect((await call('POST', '/api/demo', { language: 'ro' })).statusCode).toBe(202);
    await untilSettled(OWNER);
    let episodes: Array<{ title: string }> = [];
    for (let i = 0; i < 80 && episodes.length < 2; i++) { episodes = (await call('GET', '/api/episodes')).json(); if (episodes.length < 2) await new Promise(r => setTimeout(r, 100)); }
    expect(episodes.map(e => e.title).join(' ')).toMatch(/Hipotiroidism/);
    expect((await call('DELETE', '/api/demo')).statusCode).toBe(200);
  }, 60_000);

  it('is the account\u2019s own: another account sees none of it and starts from nothing', async () => {
    await call('POST', '/api/demo', { language: 'ro' });
    await untilSettled(OWNER);
    const other = await createTestUser('demo-other@spine.test');
    const otherCookie = await loginAs(app, other.email, other.password);
    expect((await call('GET', '/api/demo', undefined, otherCookie)).json()).toEqual({ loaded: false, processing: false });
    expect((await call('DELETE', '/api/demo', undefined, otherCookie)).statusCode).toBe(404);
    expect((await call('GET', '/api/documents', undefined, otherCookie)).json()).toEqual([]);
    expect((await call('GET', '/api/episodes', undefined, otherCookie)).json()).toEqual([]);
    await call('DELETE', '/api/demo');
  }, 60_000);

  it('needs a sign-in', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/demo', payload: {} })).statusCode).toBe(401);
  });
});
