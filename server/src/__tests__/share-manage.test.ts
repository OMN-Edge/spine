import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, loginSession } from './helpers/app.js';
import { getStore } from 'spine-core/store/index.js';
import { createTestUser, seedDocument, TEST_PASSWORD } from './helpers/seed.js';

/** Inspecting a link after it was made, and changing it: what it allows now, what it allowed, who read it. */
let app: Awaited<ReturnType<typeof buildTestApp>>;
let owner: string;
let docA: string;
let docB: string;

beforeAll(async () => {
  app = await buildTestApp();
  owner = await loginSession(app);
  docA = (await seedDocument({})).id;
  docB = (await seedDocument({})).id;
});
afterAll(async () => { await app.close(); });

const make = async (payload: Record<string, unknown> = {}) => {
  const res = await app.inject({ method: 'POST', url: '/api/share-links', headers: { cookie: owner }, payload: { scope: 'document_ids', scope_value: [docA], label: 'For Dr. Invented', ...payload } });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
};
const detail = async (id: string, cookie = owner) => app.inject({ method: 'GET', url: `/api/share-links/${id}`, headers: { cookie } });
const patch = (id: string, payload: unknown, cookie = owner) => app.inject({ method: 'PATCH', url: `/api/share-links/${id}`, headers: { cookie }, payload: payload as object });

describe('inspecting a link', () => {
  it('shows its settings, what it shares now, who read it and its history', async () => {
    const { id } = await make({ include_scans: true, expires_days: 10 });
    const now = new Date().toISOString();
    await getStore().shareLinks.logAccess(id, now, '203.0.113.7', true);
    await getStore().shareLinks.logAccess(id, now, '203.0.113.7', true);
    await getStore().shareLinks.logAccess(id, now, '198.51.100.2', true);

    const res = await detail(id);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.link).toMatchObject({ id, label: 'For Dr. Invented', scope: 'document_ids', include_scans: true, require_approval: false, allow_chat: false, view_count: 3 });
    expect(body.documents.map((d: { id: string }) => d.id)).toEqual([docA]);
    expect(body.scope_ok).toBe(true);
    expect(body.access.total).toBe(3);
    expect(body.access.addresses[0]).toMatchObject({ ip_address: '203.0.113.7', count: 2 });
    expect(body.access.recent).toHaveLength(3);
    expect(body.events.map((e: { kind: string }) => e.kind)).toEqual(['created']);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('shows the country of each read and the document it opened', async () => {
    const { id } = await make();
    const now = new Date().toISOString();
    await getStore().shareLinks.logAccess(id, now, '81.196.1.1', true, { country: 'RO', documentId: docA });
    await getStore().shareLinks.logAccess(id, now, '8.8.8.8', true, { country: 'US' });

    const recent = (await detail(id)).json().access.recent as Array<{ ip_address: string; country: string | null; document_id: string | null }>;
    expect(recent.find(r => r.ip_address === '81.196.1.1')).toMatchObject({ country: 'RO', document_id: docA });
    expect(recent.find(r => r.ip_address === '8.8.8.8')).toMatchObject({ country: 'US', document_id: null });
  });

  it('is the owner’s alone', async () => {
    const { id } = await make();
    await createTestUser('looker@spine.test');
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'looker@spine.test', password: TEST_PASSWORD } });
    const other = login.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    expect((await detail(id, other)).statusCode).toBe(404);
    expect((await patch(id, { label: 'mine now' }, other)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/share-links/${id}` })).statusCode).toBe(401);
  });
});

describe('changing a link', () => {
  it('changes its options and name, keeps what it was in the history, and applies at once', async () => {
    const { id } = await make();
    expect((await patch(id, { label: 'Renamed', include_scans: true, allow_chat: true, expires_days: 20, language: 'ro' })).statusCode).toBe(200);
    const body = (await detail(id)).json();
    expect(body.link).toMatchObject({ label: 'Renamed', include_scans: true, allow_chat: true, language: 'ro' });
    expect(new Date(body.link.expires_at).getTime()).toBeGreaterThan(Date.now() + 19 * 86_400_000);
    const changed = body.events.find((e: { kind: string }) => e.kind === 'changed');
    const fields = JSON.parse(changed.detail).changes.map((c: { field: string }) => c.field).sort();
    expect(fields).toEqual(['allow_chat', 'expires_at', 'include_scans', 'label', 'language']);
    expect((await app.inject({ method: 'GET', url: `/api/share/${id}/meta` })).json()).toMatchObject({ chat: true, language: 'ro' });
  });

  it('writes nothing to the history when nothing changed', async () => {
    const { id } = await make();
    await patch(id, { label: 'For Dr. Invented', include_scans: false });
    expect((await detail(id)).json().events.map((e: { kind: string }) => e.kind)).toEqual(['created']);
  });

  it('changes what is shared, checked as when it was made', async () => {
    const { id } = await make();
    expect((await patch(id, { scope: 'document_ids', scope_value: [docA, docB] })).statusCode).toBe(200);
    expect((await detail(id)).json().documents).toHaveLength(2);
    expect((await app.inject({ method: 'GET', url: `/api/share/${id}/documents` })).json()).toHaveLength(2);
    const change = JSON.parse((await detail(id)).json().events[0].detail).changes[0];
    expect(change).toEqual({ field: 'scope', from: '1 documents', to: '2 documents' });

    // P2 and M-5 still hold: a scope that cannot be resolved, a document that is not theirs, a value with no scope.
    expect((await patch(id, { scope: 'tag' })).statusCode).toBe(400);
    expect((await patch(id, { scope: 'document_ids', scope_value: ['not-a-document'] })).statusCode).toBe(400);
    expect((await patch(id, { scope_value: [docA] })).statusCode).toBe(400);
    expect((await detail(id)).json().documents).toHaveLength(2);
  });

  it('refuses what it should: unknown keys, bad values, a revoked link', async () => {
    const { id } = await make();
    expect((await patch(id, { token: 'x' })).statusCode).toBe(400);
    expect((await patch(id, { expires_days: 99 })).statusCode).toBe(400);
    expect((await patch(id, { include_scans: 'yes' })).statusCode).toBe(400);
    expect((await patch(id, { language: 'xx' })).statusCode).toBe(400);
    expect((await patch(id, { label: 'x'.repeat(81) })).statusCode).toBe(400);
    await app.inject({ method: 'DELETE', url: `/api/share-links/${id}`, headers: { cookie: owner } });
    expect((await patch(id, { label: 'again' })).statusCode).toBe(409);
    const events = (await detail(id)).json().events.map((e: { kind: string }) => e.kind);
    expect(events).toEqual(['revoked', 'created']);
  });

  const askOnBehalfOfVisitor = (linkId: string, visitorKey: string, note: string | null = null) =>
    getStore().shareLinks.createRequest(linkId, { id: `req-${visitorKey}`, visitorHash: visitorKey, note, ipAddress: null, userAgent: null, requestedAt: new Date().toISOString() }, 5);

  it('asks everyone again when approval is switched on after it was off', async () => {
    const { id } = await make({ require_approval: true });
    await askOnBehalfOfVisitor(id, 'visitor-1');
    await app.inject({ method: 'POST', url: `/api/share-requests/req-visitor-1/decision`, headers: { cookie: owner }, payload: { decision: 'approve' } });
    expect((await detail(id)).json().requests).toHaveLength(1);

    // Approval off, then back on: the earlier approval is gone, and the history says so.
    await patch(id, { require_approval: false });
    await patch(id, { require_approval: true });
    const body = (await detail(id)).json();
    expect(body.requests).toEqual([]);
    expect(body.events.map((e: { kind: string }) => e.kind)).toEqual(['changed', 'changed', 'approved', 'created']);
  });

  it('lists the requests of one link, and records the owner’s decisions', async () => {
    const { id } = await make({ require_approval: true });
    await askOnBehalfOfVisitor(id, 'visitor-2', 'Dr. Invented');
    const body = (await detail(id)).json();
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]).toMatchObject({ status: 'pending', note: 'Dr. Invented' });
    await app.inject({ method: 'POST', url: `/api/share-requests/${body.requests[0].id}/decision`, headers: { cookie: owner }, payload: { decision: 'deny' } });
    const after = (await detail(id)).json();
    expect(after.events[0].kind).toBe('denied');
    expect(JSON.stringify(after.events)).not.toMatch(/Invented/);
  });
});
