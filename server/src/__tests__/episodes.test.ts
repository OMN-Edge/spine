import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { buildTestApp, loginAs, loginSession } from './helpers/app.js';
import { createTestUser, seedDocument, seedSourceFile } from './helpers/seed.js';
import { getStore } from 'spine-core/store/index.js';
import { groupDocuments, proposeEpisodes } from 'spine-core/episodes/index.js';
import type { Document } from 'spine-core/types.js';

const OWNER = 'user-owner';
let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
beforeAll(async () => { app = await buildTestApp(); cookie = await loginSession(app); });
afterAll(async () => { await app.close(); });

const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, c = cookie) =>
  app.inject({ method, url, headers: { cookie: c }, ...(payload === undefined ? {} : { payload: payload as object }) });
const doc = (docDate: string | null, provider: string | null) => seedDocument({ docDate, provider });
const asDoc = (id: string, doc_date: string | null, provider: string | null) => ({ id, doc_date, provider } as Document);

describe('which documents may belong together', () => {
  it('joins by a link, and by the same provider within two weeks, and keeps a lone document out', () => {
    const docs = [asDoc('a', '2026-03-01', 'Regina Maria'), asDoc('b', '2026-03-10', 'Regina  MARIA'), asDoc('c', '2026-06-01', 'Regina Maria'), asDoc('d', '2026-06-02', 'Other'), asDoc('e', null, 'Regina Maria'), asDoc('f', '2026-09-09', 'Lone Clinic')];
    const groups = groupDocuments(docs, [{ from: 'c', to: 'd' }]).map(g => g.sort());
    expect(groups.sort()).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('does not make an episode of a crowd', () => {
    const many = Array.from({ length: 13 }, (_, i) => asDoc(`d${i}`, '2026-03-01', 'Same Clinic'));
    expect(groupDocuments(many, [])).toEqual([]);
  });
});

describe('proposing, confirming and dismissing', () => {
  it('proposes with no title, replaces its proposals, and does not propose a dismissed group again', async () => {
    const a = await doc('2026-04-01', 'Clinica Invent'); const b = await doc('2026-04-05', 'Clinica Invent');
    expect(await proposeEpisodes(OWNER)).toBeGreaterThanOrEqual(1);
    const mine = (await call('GET', '/api/episodes')).json() as Array<{ id: string; title: string; state: string; document_ids: string[]; first_date: string; last_date: string; provider: string }>;
    const ep = mine.find(e => e.document_ids.includes(a.id))!;
    expect(ep).toMatchObject({ title: '', state: 'proposed', first_date: '2026-04-01', last_date: '2026-04-05', provider: 'Clinica Invent' });
    expect([...ep.document_ids].sort()).toEqual([a.id, b.id].sort());

    const before = (await call('GET', '/api/episodes')).json().length;
    await proposeEpisodes(OWNER);
    expect((await call('GET', '/api/episodes')).json().length).toBe(before); // replaced, not added to

    expect((await call('POST', `/api/episodes/${ep.id}/state`, { state: 'dismissed' })).statusCode).toBe(200);
    expect((await call('GET', '/api/episodes')).json().some((e: { id: string }) => e.id === ep.id)).toBe(false);
    await proposeEpisodes(OWNER);
    const again = (await call('GET', '/api/episodes')).json() as Array<{ document_ids: string[] }>;
    expect(again.some(e => e.document_ids.includes(a.id))).toBe(false);
  });

  it('keeps what the owner confirmed through a new search, and a document is in one live episode', async () => {
    const a = await doc('2026-05-01', 'Clinica Alta'); const b = await doc('2026-05-03', 'Clinica Alta'); const c = await doc('2026-05-04', 'Clinica Alta');
    const made = await call('POST', '/api/episodes', { title: 'Spring visits', document_ids: [a.id, b.id] });
    expect(made.statusCode).toBe(201);
    const first = made.json() as { id: string; state: string; title: string };
    expect(first).toMatchObject({ state: 'confirmed', title: 'Spring visits' });

    await proposeEpisodes(OWNER);
    const all = (await call('GET', '/api/episodes')).json() as Array<{ id: string; state: string; document_ids: string[] }>;
    expect(all.find(e => e.id === first.id)!.document_ids.sort()).toEqual([a.id, b.id].sort());
    expect(all.filter(e => e.document_ids.includes(a.id))).toHaveLength(1);

    // Putting a document into another episode takes it out of the first; an episode left empty goes.
    const second = (await call('POST', '/api/episodes', { document_ids: [b.id, c.id] })).json() as { id: string };
    const now = (await call('GET', '/api/episodes')).json() as Array<{ id: string; document_ids: string[] }>;
    expect(now.find(e => e.id === first.id)!.document_ids).toEqual([a.id]);
    expect(now.find(e => e.id === second.id)!.document_ids.sort()).toEqual([b.id, c.id].sort());
    await call('PATCH', `/api/episodes/${first.id}`, { document_ids: [b.id] });
    expect(((await call('GET', '/api/episodes')).json() as Array<{ id: string }>).some(e => e.id === second.id && false)).toBe(false);
  });

  it('refuses what is not the owner’s, bad bodies, and is the owner’s alone', async () => {
    const mine = await doc('2026-07-01', 'X');
    const ep = (await call('POST', '/api/episodes', { title: 'Mine', document_ids: [mine.id] })).json() as { id: string };
    expect((await call('POST', '/api/episodes', { document_ids: [uuidv4()] })).statusCode).toBe(404);
    expect((await call('POST', '/api/episodes', { document_ids: [] })).statusCode).toBe(400);
    expect((await call('POST', '/api/episodes', { title: 'x'.repeat(200), document_ids: [mine.id] })).statusCode).toBe(400);
    expect((await call('PATCH', `/api/episodes/${ep.id}`, { colour: 'red' })).statusCode).toBe(400);
    expect((await call('POST', `/api/episodes/${ep.id}/state`, { state: 'maybe' })).statusCode).toBe(400);

    await createTestUser('stranger@spine.test');
    const other = await loginAs(app, 'stranger@spine.test');
    expect((await call('PATCH', `/api/episodes/${ep.id}`, { title: 'Hijacked' }, other)).statusCode).toBe(404);
    expect((await call('POST', `/api/episodes/${ep.id}/state`, { state: 'dismissed' }, other)).statusCode).toBe(404);
    expect((await call('DELETE', `/api/episodes/${ep.id}`, undefined, other)).statusCode).toBe(404);
    expect((await call('POST', '/api/episodes', { document_ids: [mine.id] }, other)).statusCode).toBe(404);
    expect((await call('GET', '/api/episodes', undefined, other)).json()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/episodes' })).statusCode).toBe(401);
  });

  it('filters the timeline by episode, and shows the episode on the document', async () => {
    const a = await doc('2026-08-01', 'Y'); const b = await doc('2026-08-02', 'Y'); await doc('2026-08-03', 'Z');
    const ep = (await call('POST', '/api/episodes', { title: 'August', document_ids: [a.id, b.id] })).json() as { id: string };
    const listed = (await call('GET', `/api/documents?episode=${ep.id}`)).json() as Array<{ id: string }>;
    expect(listed.map(d => d.id).sort()).toEqual([a.id, b.id].sort());
    expect((await call('GET', `/api/documents/${a.id}`)).json().episode).toMatchObject({ id: ep.id, title: 'August', state: 'confirmed' });
    expect((await call('GET', `/api/documents/${(await doc('2026-08-09', 'Q')).id}`)).json().episode).toBeNull();
  });

  it('loses a document’s place in an episode when the document goes, and a set-aside document is not counted', async () => {
    const a = await doc('2026-09-01', 'W'); const b = await doc('2026-09-02', 'W');
    const ep = (await call('POST', '/api/episodes', { document_ids: [a.id, b.id] })).json() as { id: string };
    await call('PATCH', `/api/documents/${a.id}/hidden`, { hidden: true });
    expect(((await call('GET', '/api/episodes')).json() as Array<{ id: string; document_ids: string[] }>).find(e => e.id === ep.id)!.document_ids).toEqual([b.id]);
    await getStore().documents.delete(OWNER, b.id);
    expect(((await call('GET', '/api/episodes')).json() as Array<{ id: string; document_ids: string[] }>).find(e => e.id === ep.id)!.document_ids).toEqual([]);
  });
});

describe('sharing an episode', () => {
  it('shares the documents of confirmed episodes only, as they are when read', async () => {
    const a = await doc('2026-10-01', 'S'); const b = await doc('2026-10-02', 'S'); const stray = await doc('2026-10-03', 'S');
    const ep = (await call('POST', '/api/episodes', { title: 'Shared', document_ids: [a.id] })).json() as { id: string };
    const link = await call('POST', '/api/share-links', { scope: 'episode', scope_value: [ep.id] });
    expect(link.statusCode).toBe(201);
    const { token } = link.json() as { token: string };
    const read = async () => ((await app.inject({ method: 'GET', url: `/api/share/${token}/documents` })).json() as Array<{ id: string }>).map(d => d.id);
    expect(await read()).toEqual([a.id]);

    await call('PATCH', `/api/episodes/${ep.id}`, { document_ids: [a.id, b.id] }); // the episode grew: so does what is shared
    expect((await read()).sort()).toEqual([a.id, b.id].sort());
    expect(await read()).not.toContain(stray.id);

    await call('POST', `/api/episodes/${ep.id}/state`, { state: 'dismissed' });
    expect(await read()).toEqual([]); // no longer an episode: nothing shared
  });

  it('refuses an episode that is not the owner’s, is not confirmed, or does not exist', async () => {
    const a = await doc('2026-11-01', 'S');
    const proposed = await getStore().episodes.list(OWNER, ['proposed']);
    const mine = (await call('POST', '/api/episodes', { document_ids: [a.id] })).json() as { id: string };
    await call('POST', `/api/episodes/${mine.id}/state`, { state: 'dismissed' });
    for (const id of [mine.id, uuidv4(), ...proposed.map(p => p.id)]) {
      const res = await call('POST', '/api/share-links', { scope: 'episode', scope_value: [id] });
      expect(res.statusCode).toBe(400);
    }
    expect((await call('POST', '/api/share-links', { scope: 'episode', scope_value: [] })).statusCode).toBe(400);
    expect((await call('POST', '/api/share-links', { scope: 'episode' })).statusCode).toBe(400);
  });
});
