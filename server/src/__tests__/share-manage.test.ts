import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
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

describe('the documents a scope picks, for the file export', () => {
  const pick = (payload: unknown, cookie = owner) => app.inject({ method: 'POST', url: '/api/share-links/scope-documents', headers: { cookie }, payload: payload as object });

  it('are the ones a link of that scope would share, with nothing made', async () => {
    const before = (await app.inject({ method: 'GET', url: '/api/share-links', headers: { cookie: owner } })).json().length;
    const res = await pick({ scope: 'document_ids', scope_value: [docA, docB] });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Array<{ id: string }>).map(d => d.id).sort()).toEqual([docA, docB].sort());
    expect((res.json() as Array<Record<string, unknown>>)[0]).toHaveProperty('page_start');
    expect((await app.inject({ method: 'GET', url: '/api/share-links', headers: { cookie: owner } })).json().length).toBe(before);
  });

  it('are refused as a link would refuse them: a document that is not the owner’s, or a scope that is not one', async () => {
    expect((await pick({ scope: 'document_ids', scope_value: [uuidv4()] })).statusCode).toBe(400);
    expect((await pick({ scope: 'everything-else' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/share-links/scope-documents', payload: { scope: 'all' } })).statusCode).toBe(401);
  });
});

describe('what the owner tells the doctor', () => {
  const overview = { by: 'Ana Exemplu', note: 'For a new endocrinologist', now: { medications: ['Levothyroxine 50 µg, once a day'], allergies: ['penicillin'], conditions: [], written_on: '2026-11-17' }, summary: false };

  it('is kept with the link and given to the page the recipient opens, with when it was made and when it ends, and the owner’s own label stays theirs', async () => {
    const { id } = await make({ overview });
    const meta = (await app.inject({ method: 'GET', url: `/api/share/${id}/meta` })).json();
    expect(meta.overview).toEqual({ ...overview, now: { ...overview.now, blood_type: '', notes: '' } });
    expect(new Date(meta.expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(typeof meta.created_at).toBe('string');
    expect(JSON.stringify(meta)).not.toContain('For Dr. Invented');
  });

  it('keeps a request for the health summary and no lists of its own, so the copy reads them from the profile when it is made', async () => {
    const { id } = await make({ overview: { by: 'Ana Exemplu', note: null, now: { medications: ['Should not be kept'], allergies: [], conditions: [], blood_type: 'A+', notes: '', written_on: '2026-11-17' }, summary: true } });
    const meta = (await app.inject({ method: 'GET', url: `/api/share/${id}/meta` })).json();
    expect(meta.overview).toMatchObject({ by: 'Ana Exemplu', now: null, summary: true });
    expect(JSON.stringify(meta)).not.toContain('Should not be kept');
  });

  it('is nothing for a link made without it, and for one whose owner left every part empty', async () => {
    const { id } = await make();
    expect((await app.inject({ method: 'GET', url: `/api/share/${id}/meta` })).json().overview).toBeNull();
    const blank = await make({ overview: { by: '', note: '', now: { medications: [], allergies: [], conditions: [], written_on: '' } } });
    expect((await app.inject({ method: 'GET', url: `/api/share/${blank.id}/meta` })).json().overview).toBeNull();
  });

  it('is refused when it is not what it should be, instead of being kept', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/share-links', headers: { cookie: owner }, payload: { scope: 'document_ids', scope_value: [docA], overview: { by: 'x'.repeat(500) } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('overview');
  });

  it('can be changed or taken away later, and the history says that it changed but never what it said', async () => {
    const { id } = await make({ overview });
    expect((await patch(id, { overview: { by: null, note: 'Changed note' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/share/${id}/meta` })).json().overview).toEqual({ by: null, note: 'Changed note', now: null, summary: false });
    expect((await patch(id, { overview: null })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/share/${id}/meta` })).json().overview).toBeNull();
    const events = (await detail(id)).json().events as Array<{ kind: string; detail: string }>;
    expect(events.some(e => e.kind === 'changed' && JSON.parse(e.detail).changes.some((c: { field: string }) => c.field === 'overview'))).toBe(true);
    expect(JSON.stringify(events)).not.toContain('Changed note');
    expect(JSON.stringify(events)).not.toContain('Levothyroxine');
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
