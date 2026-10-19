import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { buildTestApp, loginSession } from './helpers/app.js';
import { OWNER_ID, seedDocument } from './helpers/seed.js';
import { getStore } from '../store/index.js';

/**
 * What a share recipient sees around a shared document (SECURITY.md M-16, M-28): the owner's confirmed links and the documents
 * that read alike, each only if the link shares it too, and nothing else about them.
 */
let app: Awaited<ReturnType<typeof buildTestApp>>;
let owner: string;

beforeAll(async () => { app = await buildTestApp(); owner = await loginSession(app); });
afterAll(async () => { await app.close(); });
beforeEach(async () => {
  for (const f of await getStore().sourceFiles.listFor(OWNER_ID)) await getStore().sourceFiles.delete(OWNER_ID, f.id);
});

async function doc(title: string, date: string, test?: string) {
  const d = await seedDocument({ docType: 'lab_result', docDate: date, provider: null, aiSummary: title });
  await getStore().documents.update(OWNER_ID, d.id, { title });
  if (test) {
    await getStore().measurements.create(OWNER_ID, { id: uuidv4(), documentId: d.id, pageId: d.pageId!, name: test, canonical: test.toLowerCase(), valueText: '5', valueNum: 5, unit: 'u', refLow: null, refHigh: null, flag: null, takenOn: date, sourceSnippet: null, bbox: null, confidence: 1 });
  }
  return d;
}
const connect = (from: string, to: string, state: 'proposed' | 'confirmed' | 'dismissed', kind: 'requests' | 'follow_up' | 'same_episode' = 'requests') =>
  getStore().links.add(OWNER_ID, { from_document_id: from, to_document_id: to, kind, source: state === 'confirmed' ? 'owner' : 'auto', state, reason: 'a private model sentence' }, new Date().toISOString());
async function share(ids: string[], extra: Record<string, unknown> = {}) {
  const res = await app.inject({ method: 'POST', url: '/api/share-links', headers: { cookie: owner }, payload: { scope: 'document_ids', scope_value: ids, ...extra } });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; token: string };
}
const connections = (token: string, id: string) => app.inject({ method: 'GET', url: `/api/share/${token}/documents/${id}/connections` });

describe('the chain a recipient sees', () => {
  it('shows confirmed links between shared documents, and nothing about the ones that are not shared', async () => {
    const consult = await doc('Cardiology consultation', '2026-01-10');
    const scan = await doc('Heart ultrasound', '2026-01-20');
    const secret = await doc('Private psychiatric letter', '2026-01-25');
    await connect(consult.id, scan.id, 'confirmed');
    await connect(scan.id, secret.id, 'confirmed', 'follow_up'); // the other end is not shared
    const { token } = await share([consult.id, scan.id]);

    const res = await connections(token, consult.id);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.chain.nodes.map((n: { id: string }) => n.id)).toEqual([consult.id, scan.id]);
    expect(body.chain.edges).toEqual([{ from: consult.id, to: scan.id, kind: 'requests' }]);
    expect(res.body).not.toContain(secret.id);
    expect(res.body).not.toContain('Private psychiatric');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('does not show a suggestion or a dismissed link, and carries no reason, source or state', async () => {
    const a = await doc('Visit', '2026-02-01');
    const b = await doc('Follow-up visit', '2026-03-01');
    const c = await doc('Lab', '2026-02-02');
    await connect(a.id, b.id, 'proposed', 'follow_up');
    await connect(a.id, c.id, 'dismissed');
    const { token } = await share([a.id, b.id, c.id]);
    expect((await connections(token, a.id)).json().chain).toBeNull();

    await getStore().links.setState(OWNER_ID, a.id, b.id, 'follow_up', 'confirmed');
    const res = await connections(token, a.id);
    expect(res.json().chain.edges).toEqual([{ from: a.id, to: b.id, kind: 'follow_up' }]);
    expect(res.body).not.toMatch(/reason|private model|source|state|proposed|dismissed|confidence|user_id/i);
  });

  it('does not follow a chain through a document that is not shared', async () => {
    const a = await doc('A', '2026-04-01');
    const hidden = await doc('Hidden middle', '2026-04-05');
    const c = await doc('C', '2026-04-10');
    await connect(a.id, hidden.id, 'confirmed');
    await connect(hidden.id, c.id, 'confirmed');
    const { token } = await share([a.id, c.id]);
    expect((await connections(token, a.id)).json().chain).toBeNull();
  });
});

describe('the similar documents a recipient sees', () => {
  it('lists shared documents with a test in common, and never one that is not shared', async () => {
    const a = await doc('Blood count 2025', '2025-05-01', 'Hemoglobin');
    const b = await doc('Blood count 2026', '2026-05-01', 'Hemoglobin');
    const notShared = await doc('Blood count at another clinic', '2026-06-01', 'Hemoglobin');
    const { token } = await share([a.id, b.id]);

    const res = await connections(token, a.id);
    expect(res.json().related.map((r: { id: string }) => r.id)).toEqual([b.id]);
    expect(res.json().related[0].reasons).toEqual([{ kind: 'tests', names: ['Hemoglobin'] }]);
    expect(res.body).not.toContain(notShared.id);
    expect(res.body).not.toContain('another clinic');
    expect(res.body).not.toMatch(/score|user_id/);
  });
});

describe('who may ask', () => {
  it('answers 404 for a document the link does not share, whatever else exists', async () => {
    const a = await doc('Shared', '2026-07-01');
    const other = await doc('Not shared', '2026-07-02');
    const { token } = await share([a.id]);
    expect((await connections(token, other.id)).statusCode).toBe(404);
    expect((await connections(token, 'no-such-id')).statusCode).toBe(404);
    expect((await connections('not-a-token', a.id)).statusCode).toBe(410);
  });

  it('is refused for a revoked link, and until the browser is approved when the link needs approval', async () => {
    const a = await doc('Shared', '2026-08-01');
    const live = await share([a.id]);
    await app.inject({ method: 'DELETE', url: `/api/share-links/${live.id}`, headers: { cookie: owner } });
    expect((await connections(live.token, a.id)).statusCode).toBe(410);

    const gated = await share([a.id], { require_approval: true });
    const res = await connections(gated.token, a.id);
    expect(res.statusCode).toBe(403);
    expect(res.json().approval).toBeDefined();
  });

  it('changes nothing of the owner’s', async () => {
    const a = await doc('A', '2026-09-01', 'Ferritin');
    const b = await doc('B', '2026-09-02', 'Ferritin');
    await connect(a.id, b.id, 'proposed');
    const { token } = await share([a.id, b.id]);
    const before = JSON.stringify(await getStore().links.forDocument(OWNER_ID, a.id));
    await connections(token, a.id);
    expect(JSON.stringify(await getStore().links.forDocument(OWNER_ID, a.id))).toBe(before);
  });
});
