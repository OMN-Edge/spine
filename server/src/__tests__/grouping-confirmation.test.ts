import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { buildTestApp, loginAs, loginSession } from './helpers/app.js';
import { OWNER_ID, createTestUser, seedDocument, seedShareLink } from './helpers/seed.js';
import { getStore } from '../store/index.js';
import { hashShareToken } from '../share-token.js';
import { resetChatLlm, type ChatLlm } from '../llm/index.js';
import type { LinkCard } from '../llm/types.js';
import { settleLinking } from '../linking/index.js';
import { findLinks } from '../linking/index.js';

/**
 * An upload's grouping is checked by the owner before its documents appear anywhere: out of the timeline, search, shares
 * and trends, not reviewable and not linked, until they confirm. Uploads made before this (and restores) count as confirmed.
 */
let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
let otherCookie: string;
const calls: LinkCard[][] = [];
const fakeLlm = { link: async (_t: LinkCard, candidates: LinkCard[]) => { calls.push(candidates); return candidates.map(c => ({ candidate: c.id, relation: 'candidate_requested_target' as const, reason: 'Asked for these tests.' })); } } as unknown as ChatLlm;

beforeAll(async () => {
  app = await buildTestApp();
  cookie = await loginSession(app);
  const other = await createTestUser('other@spine.test');
  otherCookie = await loginAs(app, other.email, other.password);
});
afterAll(async () => { await app.close(); });
beforeEach(async () => {
  calls.length = 0; resetChatLlm(fakeLlm);
  for (const f of await getStore().sourceFiles.listFor(OWNER_ID)) await getStore().sourceFiles.delete(OWNER_ID, f.id);
});
afterEach(() => resetChatLlm());

const get = (url: string, who = cookie) => app.inject({ method: 'GET', url, headers: { cookie: who } });
const send = (method: 'POST' | 'PATCH', url: string, payload: unknown, who = cookie) => app.inject({ method, url, payload: payload as object, headers: { cookie: who } });

/** An upload as the pipeline leaves it: done, with a document, waiting for the grouping to be confirmed. */
async function waitingUpload(title = 'Blood count') {
  const d = await seedDocument({ docType: 'lab_result', docDate: '2026-04-06', provider: null, aiSummary: `${title} summary` });
  await getStore().documents.update(OWNER_ID, d.id, { title });
  await getStore().sourceFiles.setGroupingConfirmed(OWNER_ID, d.sourceFileId, false);
  return d;
}
const timeline = async () => ((await get('/api/documents?limit=100')).json() as Array<{ id: string }>).map(d => d.id);

describe('before the grouping is confirmed', () => {
  it('keeps the documents out of the timeline, search, the review queue and shares, but shows them on the upload', async () => {
    const d = await waitingUpload('Blood count');
    await seedShareLink({ tokenHash: hashShareToken('tok-1'), scope: 'all' });

    expect(await timeline()).not.toContain(d.id);
    expect((await get('/api/documents?q=Blood&limit=20')).json()).toEqual([]);
    expect((await get('/api/documents?reviewed=false&limit=20')).json()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/share/tok-1/documents' })).json()).toEqual([]);

    const uploads = (await get('/api/source-files')).json() as Array<{ id: string; grouping_confirmed: boolean; documents: Array<{ id: string }> }>;
    const upload = uploads.find(u => u.id === d.sourceFileId)!;
    expect(upload.grouping_confirmed).toBe(false);
    expect(upload.documents.map(x => x.id)).toEqual([d.id]);
    const layout = (await get(`/api/source-files/${d.sourceFileId}`)).json();
    expect(layout.grouping_confirmed).toBe(false);
    expect(layout.documents.map((x: { id: string }) => x.id)).toEqual([d.id]);
  });

  it('cannot be marked reviewed, and no links are looked for', async () => {
    const d = await waitingUpload('Blood count');
    expect((await send('PATCH', `/api/documents/${d.id}`, { reviewed: true })).statusCode).toBe(409);
    expect((await get(`/api/documents/${d.id}`)).json().grouping_confirmed).toBe(false);
    const other = await seedDocument({ docType: 'consultation_note', docDate: '2026-04-01', provider: null });
    expect(await findLinks(OWNER_ID, d.id)).toBe(0);
    expect(await findLinks(OWNER_ID, other.id)).toBe(0); // the waiting lab is not a candidate for it either
    expect(calls).toHaveLength(0);
  });
});

describe('confirming', () => {
  it('shows the documents, makes them reviewable and looks for their links', async () => {
    const lab = await waitingUpload('Blood count');
    const consult = await seedDocument({ docType: 'consultation_note', docDate: '2026-03-02', provider: null });
    await getStore().documents.update(OWNER_ID, consult.id, { title: 'Cardiology visit' });

    const res = await send('POST', `/api/source-files/${lab.sourceFileId}/grouping/confirm`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ confirmed: true });
    expect(await timeline()).toContain(lab.id);
    expect((await get(`/api/documents/${lab.id}`)).json().grouping_confirmed).toBe(true);
    expect((await send('PATCH', `/api/documents/${lab.id}`, { reviewed: true })).statusCode).toBe(200);

    await settleLinking(OWNER_ID);
    expect((await getStore().links.forDocument(OWNER_ID, lab.id)).length).toBeGreaterThan(0);
  });

  it('is repeatable, and refused for an upload that is not the caller’s or not finished', async () => {
    const d = await waitingUpload();
    expect((await send('POST', `/api/source-files/${d.sourceFileId}/grouping/confirm`, {})).statusCode).toBe(200);
    expect((await send('POST', `/api/source-files/${d.sourceFileId}/grouping/confirm`, {})).statusCode).toBe(200);
    expect((await send('POST', `/api/source-files/${d.sourceFileId}/grouping/confirm`, {}, otherCookie)).statusCode).toBe(404);

    const busy = await waitingUpload('Busy');
    await getStore().sourceFiles.setStatus(OWNER_ID, busy.sourceFileId, 'processing');
    expect((await send('POST', `/api/source-files/${busy.sourceFileId}/grouping/confirm`, {})).statusCode).toBe(409);
    expect((await get(`/api/documents/${busy.id}`)).json().grouping_confirmed).toBe(false);
  });

  it('counts an upload made before this existed as confirmed', async () => {
    const d = await seedDocument({ docType: 'lab_result', provider: null });
    expect((await getStore().sourceFiles.findFor(OWNER_ID, d.sourceFileId))!.grouping_confirmed).toBe(true);
    expect(await timeline()).toContain(d.id);
  });
});
