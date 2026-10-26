import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, loginSession } from './helpers/app.js';
import { seedDocument, seedShareLink, OWNER_ID } from './helpers/seed.js';
import { getStore } from 'spine-core/store/index.js';
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
  return (res.json() as { id: string }).id;
}

/**
 * A link row the creation endpoint would now refuse to write, so the read path
 * can be shown to fail closed on it.
 */
async function seedRawShareLink(scope: string, scopeValue: string | null) {
  const shareId = uuidv4();
  await seedShareLink({ id: shareId, scope, scopeValue });
  return shareId;
}

async function documentsFor(shareId: string) {
  const res = await app.inject({ method: 'GET', url: `/api/share/${shareId}/documents` });
  return res;
}

beforeAll(async () => {
  app = await buildTestApp();
  cookie = await loginSession(app);
});
afterAll(async () => { await app.close(); });

describe('GET /api/share/:shareId/documents — scoped queries', () => {
  it('scope=tag returns exactly the documents carrying that tag', async () => {
    const { dId: tagged } = await seedDoc({ tags: ['cardiology'] });
    const { dId: alsoTagged } = await seedDoc({ tags: ['cardiology', 'lab'] });
    await seedDoc({ tags: ['lab'] });
    await seedDoc();

    const shareId = await createShareLink('tag', 'cardiology');
    const res = await documentsFor(shareId);

    expect(res.statusCode).toBe(200);
    const ids = (res.json() as Array<{ id: string }>).map(d => d.id);
    expect(ids.sort()).toEqual([tagged, alsoTagged].sort());
  });

  it('scope=tag returns nothing for a tag no document carries', async () => {
    await seedDoc({ tags: ['oncology'] });

    const shareId = await createShareLink('tag', 'no-such-tag');
    const res = await documentsFor(shareId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('scope=document_ids returns exactly the listed documents', async () => {
    const { dId: d1 } = await seedDoc();
    const { dId: d2 } = await seedDoc();
    await seedDoc(); // not included

    const shareId = await createShareLink('document_ids', [d1, d2]);
    const res = await documentsFor(shareId);

    expect(res.statusCode).toBe(200);
    const ids = (res.json() as Array<{ id: string }>).map(d => d.id);
    expect(ids.sort()).toEqual([d1, d2].sort());
  });

  it('scope=date_range returns exactly the documents inside the range', async () => {
    await seedDoc({ doc_date: '2025-06-01' }); // before
    const { dId: inRange1 } = await seedDoc({ doc_date: '2025-08-15' });
    const { dId: inRange2 } = await seedDoc({ doc_date: '2025-09-30' });
    await seedDoc({ doc_date: '2025-11-01' }); // after

    const shareId = await createShareLink('date_range', { from: '2025-08-01', to: '2025-10-01' });
    const res = await documentsFor(shareId);

    expect(res.statusCode).toBe(200);
    const ids = (res.json() as Array<{ id: string }>).map(d => d.id);
    expect(ids.sort()).toEqual([inRange1, inRange2].sort());
  });

  it('scope=all returns every document', async () => {
    const shareId = await createShareLink('all');
    const res = await documentsFor(shareId);

    expect(res.statusCode).toBe(200);
    const total = (
      await getStore().documents.listFor(OWNER_ID, { limit: 1000, offset: 0 })
    ).length;
    expect((res.json() as unknown[]).length).toBe(total);
    expect(total).toBeGreaterThan(0);
  });

  it('serves nothing for a tag-scoped row with no scope_value', async () => {
    await seedDoc({ tags: ['cardiology'] });
    const shareId = await seedRawShareLink('tag', null);

    const res = await documentsFor(shareId);

    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ error: expect.any(String) });
  });

  it('serves nothing for a document_ids row with no scope_value', async () => {
    const shareId = await seedRawShareLink('document_ids', null);
    expect((await documentsFor(shareId)).statusCode).toBe(410);
  });

  it('serves nothing for a date_range row with no scope_value', async () => {
    const shareId = await seedRawShareLink('date_range', null);
    expect((await documentsFor(shareId)).statusCode).toBe(410);
  });

  it('serves nothing for an unrecognised scope', async () => {
    const shareId = await seedRawShareLink('everything', null);
    expect((await documentsFor(shareId)).statusCode).toBe(410);
  });

  it('serves nothing when scope_value is not valid JSON', async () => {
    const shareId = await seedRawShareLink('tag', 'cardiology'); // bare, not JSON-quoted
    expect((await documentsFor(shareId)).statusCode).toBe(410);
  });

  it('serves nothing for a date_range row missing one bound', async () => {
    const shareId = await seedRawShareLink('date_range', JSON.stringify({ from: '2025-01-01' }));
    expect((await documentsFor(shareId)).statusCode).toBe(410);
  });
});
