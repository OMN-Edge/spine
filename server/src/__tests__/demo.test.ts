import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { buildTestApp, loginAs, loginSession } from './helpers/app.js';
import { createTestUser } from './helpers/seed.js';
import { getStore } from '../store/index.js';
import { demoRecords } from '../demo/records.js';
import { manifestSchema, EXPORT_FORMAT } from '../archive/manifest.js';

const OWNER = 'user-owner';
const hasPoppler = (() => { try { execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();

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

const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, c = cookie) =>
  app.inject({ method, url, headers: { cookie: c }, ...(payload === undefined ? {} : { payload: payload as object }) });

async function untilSettled(userId: string) {
  for (let i = 0; i < 200; i++) {
    const uploads = (await getStore().sourceFiles.listFor(userId)).filter(u => u.sample);
    if (uploads.length > 0 && uploads.every(u => u.status === 'done' || u.status === 'error')) return uploads;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('the sample records did not settle');
}

describe('the sample records are valid records', () => {
  it.each(['en', 'ro'] as const)('in %s: a manifest the importer would accept, with invented content only', lang => {
    const records = demoRecords(lang, new Date('2026-10-22T12:00:00Z'));
    const manifest = { format: EXPORT_FORMAT, version: 3, exported_at: '2026-10-22T12:00:00Z', kind: 'archive', files: records.map(r => r.file) };
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
    // Dates count back from today, and none is in the future.
    const dates = records.flatMap(r => r.file.documents.map(d => d.doc_date!));
    expect(dates.every(d => d <= '2026-10-22')).toBe(true);
    expect(records.map(r => r.file.documents[0].doc_type)).toEqual(['consultation_note', 'lab_result', 'prescription', 'lab_result', 'imaging']);
    // The same tests twice, so there is a trend to look at.
    const names = records.flatMap(r => r.file.documents[0].measurements.map(m => m.canonical));
    expect(names.filter(n => n === 'ldl cholesterol')).toHaveLength(2);
  });
});

describe.skipIf(!hasPoppler)('POST /api/demo', () => {
  it('writes sample records without a model, marks them, and removes only them', async () => {
    const store = getStore();
    expect((await call('GET', '/api/demo')).json()).toEqual({ loaded: false, processing: false });

    const started = await call('POST', '/api/demo', { language: 'en' });
    expect(started.statusCode).toBe(202);
    expect(started.json().loaded).toBe(true);
    const uploads = await untilSettled(OWNER);
    expect(uploads).toHaveLength(5);
    expect(uploads.every(u => u.status === 'done' && u.sample)).toBe(true);

    const docs = (await call('GET', '/api/documents')).json() as Array<{ id: string; reviewed: boolean; doc_type: string }>;
    expect(docs).toHaveLength(5);
    expect(docs.every(d => d.reviewed)).toBe(true);
    const trend = (await call('GET', '/api/measurements/series?name=ldl%20cholesterol')).json() as { points: Array<{ value_num: number }> };
    expect(trend.points).toHaveLength(2);
    // Each has a page to look at.
    const one = (await call('GET', `/api/documents/${docs[0].id}`)).json() as { pages: Array<{ id: string }> };
    expect((await call('GET', `/api/pages/${one.pages[0].id}/image`)).statusCode).toBe(200);

    expect((await call('POST', '/api/demo', { language: 'en' })).statusCode).toBe(409); // not twice
    expect((await call('POST', '/api/demo', { language: 'xx' })).statusCode).toBe(400);

    // A real upload and the samples side by side: removal takes the samples only.
    const real = await store.sourceFiles.create(OWNER, { id: 'real-upload', uploadedAt: new Date().toISOString(), originalFilename: 'mine.pdf', filePath: join(dir, 'mine.pdf'), mimeType: 'application/pdf', checksum: 'abc' });
    void real;
    expect((await call('DELETE', '/api/demo')).statusCode).toBe(200);
    const left = await store.sourceFiles.listFor(OWNER);
    expect(left.map(u => u.id)).toEqual(['real-upload']);
    expect((await call('GET', '/api/documents')).json()).toEqual([]);
    expect((await call('DELETE', '/api/demo')).statusCode).toBe(404);
    expect(existsSync(join(dir, 'originals', OWNER))).toBe(true);
  });

  it('is the account’s own: another account sees none of it and starts from nothing', async () => {
    await call('POST', '/api/demo', { language: 'ro' });
    await untilSettled(OWNER);
    const other = await createTestUser('visitor@spine.test');
    const otherCookie = await loginAs(app, other.email, other.password);
    expect((await call('GET', '/api/documents', undefined, otherCookie)).json()).toEqual([]);
    expect((await call('GET', '/api/demo', undefined, otherCookie)).json()).toEqual({ loaded: false, processing: false });
    expect((await call('DELETE', '/api/demo', undefined, otherCookie)).statusCode).toBe(404);
    const titles = ((await call('GET', '/api/documents')).json() as Array<{ title: string }>).map(d => d.title);
    expect(titles).toContain('Radiografie toracică');
    expect((await app.inject({ method: 'POST', url: '/api/demo', payload: {} })).statusCode).toBe(401);
  });
});
