import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, loginSession, APP_SHELL_MARKER } from './helpers/app.js';
import { seedDocument, seedShareLink, OWNER_ID } from './helpers/seed.js';
import { getStore } from 'spine-core/store/index.js';
import { hashShareToken } from 'spine-core/share-token.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * P10: every link here is created through POST /api/share-links, so the test
 * drives the same encoding the owner's browser does. The previous version
 * seeded rows directly and asserted `d.id === tagged || true`, which could not
 * fail — and the double-encoded tag meant it was asserting over an empty array
 * anyway (S-6, S-7).
 *
 * Returned id sets are compared exactly: "contains what I expect" would pass
 * for a link that also returned the rest of the archive, which is S-1.
 */

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;

async function seedDoc(overrides: { doc_date?: string; tags?: string[] } = {}) {
  const { id, sourceFileId } = await seedDocument({
    docDate: overrides.doc_date ?? '2026-01-01',
    tags: overrides.tags,
  });
  return { sfId: sourceFileId, dId: id };
}

/** Create a link the way the owner's browser does, through the real endpoint. */
async function createShareLink(scope: string, scopeValue?: unknown) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/share-links',
    headers: { cookie },
    payload: { scope, scope_value: scopeValue, expires_days: 7 },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { token: string }).token;
}

/**
 * A link row the creation endpoint would now refuse to write, so the read path
 * can be shown to fail closed on it. Stores the digest, as the real endpoint
 * does (P6), and returns the raw token a recipient would present.
 */
async function seedRawShareLink(scope: string, scopeValue: string | null) {
  const token = uuidv4();
  await seedShareLink({ tokenHash: hashShareToken(token), scope, scopeValue });
  return token;
}

async function documentsFor(token: string) {
  const res = await app.inject({ method: 'GET', url: `/api/share/${token}/documents` });
  return res;
}

beforeAll(async () => {
  app = await buildTestApp();
  cookie = await loginSession(app);
});
afterAll(async () => { await app.close(); });

describe('GET /api/share/:token/documents — scoped queries', () => {
  it('scope=tag returns exactly the documents carrying that tag', async () => {
    const { dId: tagged } = await seedDoc({ tags: ['cardiology'] });
    const { dId: alsoTagged } = await seedDoc({ tags: ['cardiology', 'lab'] });
    await seedDoc({ tags: ['lab'] });
    await seedDoc();

    const token = await createShareLink('tag', 'cardiology');
    const res = await documentsFor(token);

    expect(res.statusCode).toBe(200);
    const ids = (res.json() as Array<{ id: string }>).map(d => d.id);
    expect(ids.sort()).toEqual([tagged, alsoTagged].sort());
  });

  it('scope=tag returns nothing for a tag no document carries', async () => {
    await seedDoc({ tags: ['oncology'] });

    const token = await createShareLink('tag', 'no-such-tag');
    const res = await documentsFor(token);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('scope=document_ids returns exactly the listed documents', async () => {
    const { dId: d1 } = await seedDoc();
    const { dId: d2 } = await seedDoc();
    await seedDoc(); // not included

    const token = await createShareLink('document_ids', [d1, d2]);
    const res = await documentsFor(token);

    expect(res.statusCode).toBe(200);
    const ids = (res.json() as Array<{ id: string }>).map(d => d.id);
    expect(ids.sort()).toEqual([d1, d2].sort());
  });

  it('scope=date_range returns exactly the documents inside the range', async () => {
    await seedDoc({ doc_date: '2025-06-01' }); // before
    const { dId: inRange1 } = await seedDoc({ doc_date: '2025-08-15' });
    const { dId: inRange2 } = await seedDoc({ doc_date: '2025-09-30' });
    await seedDoc({ doc_date: '2025-11-01' }); // after

    const token = await createShareLink('date_range', { from: '2025-08-01', to: '2025-10-01' });
    const res = await documentsFor(token);

    expect(res.statusCode).toBe(200);
    const ids = (res.json() as Array<{ id: string }>).map(d => d.id);
    expect(ids.sort()).toEqual([inRange1, inRange2].sort());
  });

  it('scope=all returns every document', async () => {
    const token = await createShareLink('all');
    const res = await documentsFor(token);

    expect(res.statusCode).toBe(200);
    const total = (
      await getStore().documents.listFor(OWNER_ID, { limit: 1000, offset: 0 })
    ).length;
    expect((res.json() as unknown[]).length).toBe(total);
    expect(total).toBeGreaterThan(0);
  });

  it('logs access on each request', async () => {
    const token = await createShareLink('all');
    await documentsFor(token);
    await documentsFor(token);

    const store = getStore();
    const link = await store.shareLinks.findLiveByTokenHash(hashShareToken(token));
    const summary = (await store.shareLinks.listFor(OWNER_ID)).find(l => l.id === link!.id);
    expect(summary?.view_count).toBe(2);
    expect(summary?.last_accessed_at).not.toBeNull();

    const logs = await store.shareLinks.accessLogFor(OWNER_ID, link!.id);
    expect(logs).toHaveLength(2);
  });
});

describe('GET /api/share/:token/documents — scoping fails closed (P2, S-1)', () => {
  it('serves nothing for a tag-scoped row with no scope_value', async () => {
    await seedDoc({ tags: ['cardiology'] });
    const token = await seedRawShareLink('tag', null);

    const res = await documentsFor(token);

    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ error: expect.any(String) });
  });

  it('serves nothing for a document_ids row with no scope_value', async () => {
    const token = await seedRawShareLink('document_ids', null);
    expect((await documentsFor(token)).statusCode).toBe(410);
  });

  it('serves nothing for a date_range row with no scope_value', async () => {
    const token = await seedRawShareLink('date_range', null);
    expect((await documentsFor(token)).statusCode).toBe(410);
  });

  it('serves nothing for an unrecognised scope', async () => {
    const token = await seedRawShareLink('everything', null);
    expect((await documentsFor(token)).statusCode).toBe(410);
  });

  it('serves nothing when scope_value is not valid JSON', async () => {
    const token = await seedRawShareLink('tag', 'cardiology'); // bare, not JSON-quoted
    expect((await documentsFor(token)).statusCode).toBe(410);
  });

  it('serves nothing for a date_range row missing one bound', async () => {
    const token = await seedRawShareLink('date_range', JSON.stringify({ from: '2025-01-01' }));
    expect((await documentsFor(token)).statusCode).toBe(410);
  });

  it('still logs the access when the scope cannot be resolved', async () => {
    const token = await seedRawShareLink('tag', null);
    await documentsFor(token);

    const store = getStore();
    const link = await store.shareLinks.findLiveByTokenHash(hashShareToken(token));
    const logs = await store.shareLinks.accessLogFor(OWNER_ID, link!.id);
    expect(logs).toHaveLength(1);

    // Counted as a view even though nothing was served: P7 logs before anything
    // is returned, which is deliberately ahead of resolving the scope.
    const summary = (await store.shareLinks.listFor(OWNER_ID)).find(l => l.id === link!.id);
    expect(summary?.view_count).toBe(1);
  });
});

/**
 * `GET /share/:token` is what a recipient's browser actually opens. It had no
 * test, and it was returning JSON: the SPA fallback in index.ts excludes
 * `/share/`, so this route is the only thing that answers that URL, and a
 * doctor following a link saw `{"ok":true,...}` instead of the share view.
 */
describe('GET /share/:token — the recipient entry point', () => {
  it('serves the app shell as HTML for a live link', async () => {
    const token = await createShareLink('all');

    const res = await app.inject({ method: 'GET', url: `/share/${token}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain(APP_SHELL_MARKER);
    expect(res.body).not.toContain('"ok":true');
  });

  it('serves a plain HTML page, not the app, for a dead link', async () => {
    const token = uuidv4();
    await seedShareLink({
      tokenHash: hashShareToken(token),
      expiresAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    });

    const res = await app.inject({ method: 'GET', url: `/share/${token}` });

    expect(res.statusCode).toBe(410);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('no longer active');
    expect(res.body).not.toContain(APP_SHELL_MARKER);
  });

  it('logs the visit but does not count it as a document view', async () => {
    const token = await createShareLink('all');
    await app.inject({ method: 'GET', url: `/share/${token}` });

    const store = getStore();
    const link = await store.shareLinks.findLiveByTokenHash(hashShareToken(token));

    // P7: the visit is on record.
    const logs = await store.shareLinks.accessLogFor(OWNER_ID, link!.id);
    expect(logs).toHaveLength(1);

    // But view_count means "documents were read", which has not happened yet.
    const before = (await store.shareLinks.listFor(OWNER_ID)).find(l => l.id === link!.id);
    expect(before?.view_count).toBe(0);

    await app.inject({ method: 'GET', url: `/api/share/${token}/documents` });
    const after = (await store.shareLinks.listFor(OWNER_ID)).find(l => l.id === link!.id);
    expect(after?.view_count).toBe(1);
  });

  it('does not reveal the token is valid once revoked', async () => {
    const token = await createShareLink('all');
    const store = getStore();
    const link = await store.shareLinks.findLiveByTokenHash(hashShareToken(token));
    await store.shareLinks.revoke(OWNER_ID, link!.id);

    const res = await app.inject({ method: 'GET', url: `/share/${token}` });
    expect(res.statusCode).toBe(410);
  });
});

describe('GET /share/:token — missing web build', () => {
  it('does not fall back to leaking JSON when the shell is absent', async () => {
    const noBuild = await buildTestApp({ appShellPath: null });
    try {
      const cookie2 = await loginSession(noBuild);
      const create = await noBuild.inject({
        method: 'POST', url: '/api/share-links',
        headers: { cookie: cookie2 },
        payload: { scope: 'all', expires_days: 7 },
      });
      const { token } = create.json() as { token: string };

      const res = await noBuild.inject({ method: 'GET', url: `/share/${token}` });
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('"ok":true');
    } finally {
      await noBuild.close();
    }
  });
});
