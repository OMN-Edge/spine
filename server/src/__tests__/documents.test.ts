import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, loginSession } from './helpers/app.js';
import { seedDocument, seedPage, seedSourceFile, seedShareLink, OWNER_ID } from './helpers/seed.js';
import { getStore } from '../store/index.js';
import { hashShareToken } from '../share-token.js';
import { v4 as uuidv4 } from 'uuid';

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
let sourceFileId: string;
let docId: string;

beforeAll(async () => {
  app = await buildTestApp();
  cookie = await loginSession(app);
  const seed = await seedDocument();
  sourceFileId = seed.sourceFileId;
  docId = seed.id;
});
afterAll(async () => { await app.close(); });

describe('GET /api/documents', () => {
  it('returns a list of documents', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/documents', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
    expect(res.json().length).toBeGreaterThan(0);
  });

  it('filters by doc_type', async () => {
    await seedDocument({ docType: 'vaccination' });
    const res = await app.inject({ method: 'GET', url: '/api/documents?doc_type=vaccination', headers: { cookie } });
    const docs = res.json() as any[];
    expect(docs.every((d: any) => d.doc_type === 'vaccination')).toBe(true);
  });

  it('filters by reviewed=false', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/documents?reviewed=false', headers: { cookie } });
    const docs = res.json() as any[];
    expect(docs.every((d: any) => d.reviewed === 0)).toBe(true);
  });

  it('returns 401 without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/documents' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/documents/:id', () => {
  it('returns document with fields, tags, and pages', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/documents/${docId}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.id).toBe(docId);
    expect(Array.isArray(body.fields)).toBe(true);
    expect(Array.isArray(body.tags)).toBe(true);
    expect(Array.isArray(body.pages)).toBe(true);
  });

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/documents/nonexistent', headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /api/documents/:id', () => {
  it('updates doc fields', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/documents/${docId}`,
      headers: { cookie },
      payload: { provider: 'Updated Clinic', user_notes: 'Follow up needed' },
    });
    expect(res.statusCode).toBe(200);

    const check = await app.inject({ method: 'GET', url: `/api/documents/${docId}`, headers: { cookie } });
    const body = check.json() as any;
    expect(body.provider).toBe('Updated Clinic');
    expect(body.user_notes).toBe('Follow up needed');
  });

  it('marks document as reviewed', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/documents/${docId}`,
      headers: { cookie },
      payload: { reviewed: true },
    });
    expect(res.statusCode).toBe(200);

    const check = await app.inject({ method: 'GET', url: `/api/documents/${docId}`, headers: { cookie } });
    expect((check.json() as any).reviewed).toBe(1);
  });

  it('updates tags', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/documents/${docId}`,
      headers: { cookie },
      payload: { tags: ['allergy', 'chronic'] },
    });
    expect(res.statusCode).toBe(200);

    const check = await app.inject({ method: 'GET', url: `/api/documents/${docId}`, headers: { cookie } });
    const tags = (check.json() as any).tags as string[];
    expect(tags).toContain('allergy');
    expect(tags).toContain('chronic');
  });
});

describe('POST /api/documents/:id/boundary — split', () => {
  it('splits a multi-page document at a given page', async () => {
    const store = getStore();
    const sfId = await seedSourceFile({ status: 'done' });
    for (let p = 1; p <= 4; p++) await seedPage(sfId, { pageNumber: p });
    const dId = uuidv4();
    await store.documents.create(OWNER_ID, {
      id: dId, sourceFileId: sfId, pageStart: 1, pageEnd: 4,
    });

    const res = await app.inject({
      method: 'POST', url: `/api/documents/${dId}/boundary`,
      headers: { cookie },
      payload: { action: 'split', at_page: 3 },
    });
    expect(res.statusCode).toBe(200);
    const { split_into } = res.json() as any;
    expect(split_into).toHaveLength(2);

    const docs = (await store.documents.listFor(OWNER_ID, { limit: 100, offset: 0 }))
      .filter(d => d.source_file_id === sfId)
      .sort((a, b) => a.page_start - b.page_start);
    expect(docs[0].page_end).toBe(2);
    expect(docs[1].page_start).toBe(3);
    expect(docs[1].page_end).toBe(4);
  });

  it('rejects split at_page out of range', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/documents/${docId}/boundary`,
      headers: { cookie },
      payload: { action: 'split', at_page: 99 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/documents/:id/boundary — merge', () => {
  it('merges two adjacent documents', async () => {
    const store = getStore();
    const sfId = await seedSourceFile({ status: 'done' });
    const d1 = uuidv4();
    const d2 = uuidv4();
    await store.documents.create(OWNER_ID, { id: d1, sourceFileId: sfId, pageStart: 1, pageEnd: 2 });
    await store.documents.create(OWNER_ID, { id: d2, sourceFileId: sfId, pageStart: 3, pageEnd: 4 });

    const res = await app.inject({
      method: 'POST', url: `/api/documents/${d1}/boundary`,
      headers: { cookie },
      payload: { action: 'merge', with_document_id: d2 },
    });
    expect(res.statusCode).toBe(200);

    const merged = await store.documents.findFor(OWNER_ID, d1);
    expect(merged?.page_end).toBe(4);
    expect(await store.documents.findFor(OWNER_ID, d2)).toBeNull();
  });
});

/**
 * The PATCH handler interpolates column names into the UPDATE statement.
 * `Body` is a compile-time type only, so the keys must be checked against a
 * whitelist at runtime: a crafted key previously closed the assignment and
 * appended SQL of its own while keeping the bound-parameter count valid.
 */
describe('PATCH /api/documents/:id — column whitelist', () => {
  it('rejects a key that is not an updatable column', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/documents/${docId}`,
      headers: { cookie },
      payload: { not_a_column: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a key carrying SQL and leaves the row untouched', async () => {
    // A row holding something recognisable, so an injected SELECT that copied
    // it into a document field would be visible.
    await seedShareLink({ tokenHash: hashShareToken('injection-probe-token') });

    const res = await app.inject({
      method: 'PATCH', url: `/api/documents/${docId}`,
      headers: { cookie },
      payload: {
        "user_notes = (SELECT token FROM share_links WHERE id = 'inj-link'), provider": 'x',
      },
    });

    expect(res.statusCode).toBe(400);
    const doc = await getStore().documents.findFor(OWNER_ID, docId);
    expect(doc?.user_notes).not.toBe('injection-probe-token');
    expect(doc?.user_notes).not.toContain(hashShareToken('injection-probe-token'));
  });

  it('still writes the columns it is meant to', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/documents/${docId}`,
      headers: { cookie },
      payload: { provider: 'Synevo', user_notes: 'checked', reviewed: true },
    });
    expect(res.statusCode).toBe(200);

    const doc = await getStore().documents.findFor(OWNER_ID, docId);
    expect(doc).toMatchObject({ provider: 'Synevo', user_notes: 'checked', reviewed: 1 });
  });
});

describe('GET /api/documents/:id — response columns (S-8)', () => {
  it('does not send absolute server filesystem paths', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/documents/${docId}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { pages: Array<Record<string, unknown>> };
    expect(body.pages.length).toBeGreaterThan(0);
    for (const page of body.pages) {
      expect(page).not.toHaveProperty('image_path');
      expect(page).toHaveProperty('page_number');
    }
    expect(JSON.stringify(body)).not.toContain('/tmp/p.png');
  });
});

describe('document titles', () => {
  it('are returned, editable, and searchable', async () => {
    const { id } = await seedDocument({ aiSummary: 'nothing about it here' });
    expect((await app.inject({ method: 'GET', url: `/api/documents/${id}`, headers: { cookie } })).json()).toHaveProperty('title', null);

    const patch = await app.inject({
      method: 'PATCH', url: `/api/documents/${id}`, headers: { cookie },
      payload: { title: 'Bilet de externare Colentina' },
    });
    expect(patch.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/documents/${id}`, headers: { cookie } })).json().title)
      .toBe('Bilet de externare Colentina');

    // The full-text index covers the title, through the update trigger.
    const found = await app.inject({ method: 'GET', url: '/api/documents?q=externare', headers: { cookie } });
    expect((found.json() as Array<{ id: string }>).map(d => d.id)).toContain(id);
  });
});
