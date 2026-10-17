import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { buildTestApp, loginAs, loginSession } from './helpers/app.js';
import { OWNER_ID, createTestUser, seedDocument } from './helpers/seed.js';
import { getStore } from '../store/index.js';

/**
 * What the app extracted and the person reuses: tags, providers, tests. Managed by the person, each scoped to them.
 */
let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
let otherCookie: string;
let otherId: string;

beforeAll(async () => {
  app = await buildTestApp();
  cookie = await loginSession(app);
  const other = await createTestUser('other@spine.test');
  otherId = other.id;
  otherCookie = await loginAs(app, other.email, other.password);
});
afterAll(async () => { await app.close(); });

const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, who = cookie, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie: who }, payload: payload as object | undefined });
const tags = async (who = cookie) => (await call('GET', '/api/tags', who)).json() as Array<{ id: number; name: string; document_count: number }>;
const tagId = async (name: string, who = cookie) => (await tags(who)).find(t => t.name === name)!.id;

describe('tags', () => {
  it('are counted, and kept in one form however they are written', async () => {
    await seedDocument({ tags: ['Cardiology ', 'cardiology', 'rare  one'] });
    await seedDocument({ tags: ['cardiology'] });
    const list = await tags();
    expect(list.find(t => t.name === 'cardiology')?.document_count).toBe(2);
    expect(list.find(t => t.name === 'rare one')?.document_count).toBe(1);
    expect(list.filter(t => t.name.trim().toLowerCase() === 'cardiology')).toHaveLength(1);
    // The starting vocabulary is there with nothing on it.
    expect(list.find(t => t.name === 'allergy')?.document_count).toBe(0);
  });

  it('are renamed, and a link that shares by the tag follows', async () => {
    const d = await seedDocument({ tags: ['old-name'] });
    const created = await call('POST', '/api/share-links', cookie, { scope: 'tag', scope_value: 'old-name', expires_days: 7 });
    expect(created.statusCode).toBe(201);
    const res = await call('PATCH', `/api/tags/${await tagId('old-name')}`, cookie, { name: '  New Name ' });
    expect(res.json()).toEqual({ result: 'ok' });
    expect(await getStore().tags.namesForDocument(OWNER_ID, d.id)).toEqual(['new name']);
    const links = await getStore().shareLinks.listFor(OWNER_ID);
    expect(links.find(l => l.scope === 'tag' && l.scope_value === JSON.stringify('new name'))).toBeDefined();
  });

  it('become one when renamed to a name another has, with no document twice', async () => {
    const both = await seedDocument({ tags: ['alpha-x', 'beta-x'] });
    const onlyAlpha = await seedDocument({ tags: ['alpha-x'] });
    const res = await call('PATCH', `/api/tags/${await tagId('alpha-x')}`, cookie, { name: 'beta-x' });
    expect(res.json()).toEqual({ result: 'merged' });
    expect(await getStore().tags.namesForDocument(OWNER_ID, both.id)).toEqual(['beta-x']);
    expect(await getStore().tags.namesForDocument(OWNER_ID, onlyAlpha.id)).toEqual(['beta-x']);
    expect((await tags()).find(t => t.name === 'alpha-x')).toBeUndefined();
    expect((await tags()).find(t => t.name === 'beta-x')?.document_count).toBe(2);
  });

  it('are merged by id, removed with their links, and refuse nonsense', async () => {
    await seedDocument({ tags: ['m-from', 'm-into'] });
    const from = await tagId('m-from'); const into = await tagId('m-into');
    expect((await call('POST', `/api/tags/${from}/merge`, cookie, { into: from })).statusCode).toBe(400);
    expect((await call('POST', `/api/tags/${from}/merge`, cookie, { into: 999999 })).statusCode).toBe(404);
    expect((await call('POST', `/api/tags/${from}/merge`, cookie, { into })).json()).toEqual({ result: 'ok' });
    expect((await call('DELETE', `/api/tags/${into}`)).json()).toEqual({ removed: true });
    expect((await call('DELETE', `/api/tags/${into}`)).statusCode).toBe(404);
    expect((await call('PATCH', `/api/tags/${await tagId('lab')}`, cookie, { name: '   ' })).statusCode).toBe(400);
    expect((await call('PATCH', '/api/tags/abc', cookie, { name: 'x' })).statusCode).toBe(404);
  });

  it('cannot be read, renamed, merged or removed by another user', async () => {
    await seedDocument({ tags: ['private-tag'] });
    const id = await tagId('private-tag');
    expect((await tags(otherCookie)).find(t => t.name === 'private-tag')).toBeUndefined();
    expect((await call('PATCH', `/api/tags/${id}`, otherCookie, { name: 'taken' })).statusCode).toBe(404);
    expect((await call('DELETE', `/api/tags/${id}`, otherCookie)).statusCode).toBe(404);
    const mine = (await tags(otherCookie))[0].id;
    expect((await call('POST', `/api/tags/${mine}/merge`, otherCookie, { into: id })).statusCode).toBe(404);
    expect((await call('POST', `/api/tags/${id}/merge`, otherCookie, { into: mine })).statusCode).toBe(404);
    expect((await tags()).find(t => t.name === 'private-tag')).toBeDefined();
  });
});

describe('providers', () => {
  it('are listed with counts, renamed into one, and cleared', async () => {
    await seedDocument({ provider: 'Clinica Alfa' });
    await seedDocument({ provider: 'CLINICA ALFA' });
    await seedDocument({ provider: 'CLINICA ALFA' });
    const list = (await call('GET', '/api/providers')).json() as Array<{ name: string; document_count: number }>;
    expect(list.find(p => p.name === 'CLINICA ALFA')?.document_count).toBe(2);

    expect((await call('POST', '/api/providers/rename', cookie, { from: 'CLINICA ALFA', to: ' Clinica   Alfa ' })).json()).toEqual({ changed: 2 });
    const after = (await call('GET', '/api/providers')).json() as Array<{ name: string; document_count: number }>;
    expect(after.find(p => p.name === 'Clinica Alfa')?.document_count).toBe(3);
    expect(after.find(p => p.name === 'CLINICA ALFA')).toBeUndefined();

    expect((await call('POST', '/api/providers/rename', cookie, { from: 'Clinica Alfa', to: '' })).json()).toEqual({ changed: 3 });
    expect((await call('POST', '/api/providers/rename', cookie, { from: 'Clinica Alfa', to: 'x' })).statusCode).toBe(404);
    expect((await call('POST', '/api/providers/rename', cookie, { from: '', to: 'x' })).statusCode).toBe(400);
    expect((await call('POST', '/api/providers/rename', cookie, { from: 'a', to: 'x'.repeat(201) })).statusCode).toBe(400);
  });

  it('are the user\'s own: another user renaming the same name changes nothing of ours', async () => {
    await seedDocument({ provider: 'Shared Name Clinic' });
    expect((await call('POST', '/api/providers/rename', otherCookie, { from: 'Shared Name Clinic', to: 'Hijacked' })).statusCode).toBe(404);
    expect(((await call('GET', '/api/providers', otherCookie)).json() as unknown[])).toEqual([]);
    expect(((await call('GET', '/api/providers')).json() as Array<{ name: string }>).some(p => p.name === 'Shared Name Clinic')).toBe(true);
  });
});

describe('tests', () => {
  async function value(canonical: string, name: string, userId = OWNER_ID) {
    const d = await seedDocument({ userId });
    const page = (await getStore().pages.listForSourceFile(userId, d.sourceFileId))[0].id;
    await getStore().measurements.create(userId, { id: uuidv4(), documentId: d.id, pageId: page, name, canonical, valueText: '5', valueNum: 5, unit: 'x', refLow: null, refHigh: null, flag: null, takenOn: '2026-01-01', sourceSnippet: null, bbox: null, confidence: 1 });
    return d;
  }
  const names = async (who = cookie) => (await call('GET', '/api/measurements', who)).json() as Array<{ canonical: string; name: string; count: number }>;

  it('are renamed everywhere, and later documents that use the old name are filed under the new', async () => {
    await value('hb', 'Hb'); await value('hb', 'Hb');
    const res = await call('POST', '/api/measurements/rename', cookie, { from: 'HB', to: 'Hemoglobin' });
    expect(res.json()).toEqual({ result: 'ok', canonical: 'hemoglobin' });
    const list = await names();
    expect(list.find(n => n.canonical === 'hemoglobin')).toMatchObject({ name: 'Hemoglobin', count: 2 });
    expect(list.find(n => n.canonical === 'hb')).toBeUndefined();
    expect(await getStore().measurements.resolveCanonical(OWNER_ID, 'hb')).toBe('hemoglobin');
  });

  it('become one when renamed to another test, and say when there is nothing to do', async () => {
    await value('ldl chol', 'LDL'); await value('ldl cholesterol', 'LDL cholesterol');
    expect((await call('POST', '/api/measurements/rename', cookie, { from: 'ldl chol', to: 'LDL cholesterol' })).json()).toMatchObject({ result: 'merged' });
    expect((await names()).find(n => n.canonical === 'ldl cholesterol')?.count).toBe(2);
    expect((await call('POST', '/api/measurements/rename', cookie, { from: 'nope', to: 'x' })).statusCode).toBe(404);
    expect((await call('POST', '/api/measurements/rename', cookie, { from: 'ldl cholesterol', to: 'LDL Cholesterol' })).statusCode).toBe(400);
    expect((await call('POST', '/api/measurements/rename', cookie, { from: 'ldl cholesterol', to: '  ' })).statusCode).toBe(400);
  });

  it('are removed with their values, leaving the documents', async () => {
    const d = await value('to-remove', 'To remove');
    expect((await call('DELETE', '/api/measurements?name=To-Remove')).json()).toEqual({ removed: 1 });
    expect((await names()).find(n => n.canonical === 'to-remove')).toBeUndefined();
    expect(await getStore().documents.findFor(OWNER_ID, d.id)).not.toBeNull();
    expect((await call('DELETE', '/api/measurements?name=to-remove')).statusCode).toBe(404);
    expect((await call('DELETE', '/api/measurements')).statusCode).toBe(400);
  });

  it('cannot be renamed or removed by another user', async () => {
    await value('mine-only', 'Mine only');
    expect((await call('POST', '/api/measurements/rename', otherCookie, { from: 'mine-only', to: 'stolen' })).statusCode).toBe(404);
    expect((await call('DELETE', '/api/measurements?name=mine-only', otherCookie)).statusCode).toBe(404);
    expect((await names()).find(n => n.canonical === 'mine-only')).toBeDefined();
    void otherId;
  });
});
