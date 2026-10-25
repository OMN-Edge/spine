import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, loginSession } from './helpers/app.js';
import { seedShareLink, OWNER_ID } from './helpers/seed.js';
import { getStore } from 'spine-core/store/index.js';
import { hashShareToken } from 'spine-core/share-token.js';

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;

beforeAll(async () => {
  app = await buildTestApp();
  cookie = await loginSession(app);
});
afterAll(async () => { await app.close(); });

describe('POST /api/share-links', () => {
  it('creates a link with scope=all', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/share-links',
      headers: { cookie },
      payload: { label: 'Dr. Test', scope: 'all', expires_days: 7 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.token).toBeDefined();
    expect(body.url).toContain('/share/');
    expect(body.expires_at).toBeDefined();
  });

  it('creates a link scoped to a tag', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/share-links',
      headers: { cookie },
      payload: { scope: 'tag', scope_value: 'cardiology', expires_days: 3 },
    });
    expect(res.statusCode).toBe(201);
  });

  it('rejects expires_days over 30', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/share-links',
      headers: { cookie },
      payload: { scope: 'all', expires_days: 31 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lives for the hours asked, from one hour to thirty days', async () => {
    const make = (payload: object) => app.inject({ method: 'POST', url: '/api/share-links', headers: { cookie }, payload: { scope: 'all', ...payload } });
    const hour = await make({ expires_hours: 1 });
    expect(hour.statusCode).toBe(201);
    const ms = new Date(hour.json().expires_at).getTime() - Date.now();
    expect(ms).toBeGreaterThan(59 * 60_000);
    expect(ms).toBeLessThanOrEqual(60 * 60_000);
    expect((await make({ expires_hours: 720 })).statusCode).toBe(201);
    for (const bad of [0, 721, 1.5, '3']) expect((await make({ expires_hours: bad })).statusCode).toBe(400);
    expect((await make({ expires_hours: 2, expires_days: 2 })).statusCode).toBe(400);
  });

  it('returns 401 without auth', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/share-links',
      payload: { scope: 'all' },
    });
    expect(res.statusCode).toBe(401);
  });
});

/**
 * P2: a link whose scope cannot be fully resolved must never be stored, because
 * the read path would have nothing to narrow by. S-1 was exactly this — a
 * `tag` scope with no scope_value was accepted, then read as the whole archive.
 */
describe('POST /api/share-links — scope validation (P2, S-1)', () => {
  const rejected: Array<[string, Record<string, unknown>]> = [
    ['tag with no scope_value', { scope: 'tag' }],
    ['tag with an empty scope_value', { scope: 'tag', scope_value: '  ' }],
    ['tag with a non-string scope_value', { scope: 'tag', scope_value: ['cardiology'] }],
    ['document_ids with no scope_value', { scope: 'document_ids' }],
    ['document_ids with an empty array', { scope: 'document_ids', scope_value: [] }],
    ['document_ids with a non-string id', { scope: 'document_ids', scope_value: [1, 2] }],
    ['date_range with no scope_value', { scope: 'date_range' }],
    ['date_range missing a bound', { scope: 'date_range', scope_value: { from: '2025-01-01' } }],
    ['date_range with a malformed date', { scope: 'date_range', scope_value: { from: '01-01-2025', to: '2025-02-01' } }],
    ['date_range with an impossible date', { scope: 'date_range', scope_value: { from: '2025-02-30', to: '2025-03-01' } }],
    ['date_range with from after to', { scope: 'date_range', scope_value: { from: '2025-05-01', to: '2025-04-01' } }],
    ['an unrecognised scope', { scope: 'everything' }],
    ['all with a scope_value', { scope: 'all', scope_value: 'cardiology' }],
  ];

  for (const [name, payload] of rejected) {
    it(`rejects ${name}`, async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/share-links',
        headers: { cookie },
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: expect.any(String) });
    });
  }

  it('stores no row for a rejected scope', async () => {
    const before = (await getStore().shareLinks.listFor(OWNER_ID)).length;

    await app.inject({
      method: 'POST', url: '/api/share-links',
      headers: { cookie },
      payload: { scope: 'tag' },
    });

    const after = (await getStore().shareLinks.listFor(OWNER_ID)).length;
    expect(after).toBe(before);
  });

  it('stores a tag scope the read path can resolve (S-6)', async () => {
    const create = await app.inject({
      method: 'POST', url: '/api/share-links',
      headers: { cookie },
      payload: { scope: 'tag', scope_value: 'cardiology' },
    });
    expect(create.statusCode).toBe(201);
    const { token } = create.json() as { token: string };

    // The whole of S-6: creation JSON-encoded the tag and the read path
    // compared the encoded form to tags.name, so this returned 0 of 8 matches.
    const read = await app.inject({ method: 'GET', url: `/api/share/${token}/documents` });
    expect(read.statusCode).toBe(200);
  });
});

describe('GET /api/share-links', () => {
  it('lists created links', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/share-links', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('does not return the raw tokens (S-8)', async () => {
    const create = await app.inject({
      method: 'POST', url: '/api/share-links',
      headers: { cookie },
      payload: { scope: 'all', expires_days: 7 },
    });
    const { token } = create.json() as { token: string };

    const res = await app.inject({ method: 'GET', url: '/api/share-links', headers: { cookie } });
    const links = res.json() as Array<Record<string, unknown>>;
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link).not.toHaveProperty('token');
    expect(res.body).not.toContain(token);
  });
});

describe('DELETE /api/share-links/:id', () => {
  it('revokes a link', async () => {
    const create = await app.inject({
      method: 'POST', url: '/api/share-links',
      headers: { cookie },
      payload: { scope: 'all', expires_days: 1 },
    });
    const { id } = create.json();

    const del = await app.inject({ method: 'DELETE', url: `/api/share-links/${id}`, headers: { cookie } });
    expect(del.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/api/share-links', headers: { cookie } });
    const links = list.json() as Array<{ id: string; revoked: boolean }>;
    expect(links.find(l => l.id === id)?.revoked).toBe(1);
  });
});

describe('GET /api/share/:token/documents', () => {
  it('returns 410 for an expired token', async () => {
    await seedShareLink({
      tokenHash: hashShareToken('expired-token'),
      expiresAt: '2020-01-02T00:00:00.000Z',
    });

    const res = await app.inject({ method: 'GET', url: '/api/share/expired-token/documents' });
    expect(res.statusCode).toBe(410);
  });

  it('returns 410 for a revoked token', async () => {
    await seedShareLink({ tokenHash: hashShareToken('revoked-token'), revoked: true });

    const res = await app.inject({ method: 'GET', url: '/api/share/revoked-token/documents' });
    expect(res.statusCode).toBe(410);
  });

  it('returns documents for a valid token', async () => {
    await seedShareLink({ tokenHash: hashShareToken('valid-token') });

    const res = await app.inject({ method: 'GET', url: '/api/share/valid-token/documents' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });
});
