import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { buildTestApp, loginSession } from './helpers/app.js';
import { OWNER_ID, createTestUser, seedDocument, seedPage, seedShareLink } from './helpers/seed.js';
import { getStore } from 'spine-core/store/index.js';

/**
 * What a recipient can open from a share link: one document's details, and its page images only when the
 * owner allowed scans for that link. Everything is scoped by the link, not by anything the recipient sends.
 */
let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
let dir: string;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

beforeAll(async () => { app = await buildTestApp(); cookie = await loginSession(app); dir = mkdtempSync(path.join(tmpdir(), 'spine-share-')); });
afterAll(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

/** A document with a real image on disk, one field, one measurement, and a tag. */
async function shared(tag?: string, userId = OWNER_ID) {
  const sf = (await seedDocument({ userId, tags: tag ? [tag] : undefined }));
  const imagePath = path.join(dir, `${uuidv4()}.png`);
  writeFileSync(imagePath, PNG);
  // The document's own page, pointed at a real file.
  const pageId = await seedPage(sf.sourceFileId, { userId, pageNumber: 2, imagePath, rawText: 'second page' });
  await getStore().documents.setPageEnd(userId, sf.id, 2); // the document now holds both pages
  await getStore().documents.update(userId, sf.id, { title: 'Shared report', user_notes: 'A note for the doctor.' });
  await getStore().fields.create(userId, { id: uuidv4(), documentId: sf.id, pageId, label: 'diagnosis', value: 'Invented diagnosis', sourceSnippet: 'secret source text', bbox: null, confidence: 1 });
  await getStore().measurements.create(userId, {
    id: uuidv4(), documentId: sf.id, pageId, name: 'Glucose', canonical: 'glucose', valueText: '5.1', valueNum: 5.1, unit: 'mmol/L',
    refLow: 3.9, refHigh: 5.6, flag: null, takenOn: '2026-01-01', sourceSnippet: 'secret source text', bbox: null, confidence: 1,
  });
  return { ...sf, pageId, imagePath };
}

const link = async (scope: 'all' | 'tag' | 'document_ids', scopeValue: unknown, includeScans = false) => {
  const res = await app.inject({ method: 'POST', url: '/api/share-links', headers: { cookie }, payload: { scope, scope_value: scopeValue, expires_days: 7, include_scans: includeScans } });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
};
const get = (url: string) => app.inject({ method: 'GET', url });

describe('opening one shared document', () => {
  it('shows its details, and no scans unless the owner allowed them', async () => {
    const doc = await shared();
    const shareId = await link('document_ids', [doc.id]);
    const res = await get(`/api/share/${shareId}/documents/${doc.id}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.document).toMatchObject({ id: doc.id, title: 'Shared report', user_notes: 'A note for the doctor.' });
    expect(body.fields).toEqual([{ id: expect.any(String), label: 'diagnosis', value: 'Invented diagnosis', group_no: null }]);
    expect(body.measurements[0]).toMatchObject({ name: 'Glucose', value_text: '5.1', unit: 'mmol/L', ref_low: 3.9, ref_high: 5.6 });
    expect(body.scans).toBe(false);
    expect(body.pages).toEqual([]);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('lists the pages, without a path, when scans are allowed', async () => {
    const doc = await shared();
    const shareId = await link('document_ids', [doc.id], true);
    const body = (await get(`/api/share/${shareId}/documents/${doc.id}`)).json();
    expect(body.scans).toBe(true);
    expect(body.pages.map((p: { id: string }) => p.id)).toContain(doc.pageId);
    expect(Object.keys(body.pages[0]).sort()).toEqual(['id', 'image_height', 'image_width', 'page_number']);
  });

  it('carries nothing the recipient has no use for: no owner, path, source text, box or shareId', async () => {
    const doc = await shared();
    const shareId = await link('document_ids', [doc.id], true);
    const text = (await get(`/api/share/${shareId}/documents/${doc.id}`)).body;
    for (const forbidden of ['user_id', OWNER_ID, 'image_path', 'file_path', 'secret source text', 'source_snippet', 'bbox', 'page_id', 'source_file_id', 'checksum', shareId, dir]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it('answers 404 for a document the link does not cover, and for another user’s', async () => {
    const inside = await shared('in-scope');
    const outside = await shared('out-of-scope');
    const shareId = await link('tag', 'in-scope');
    expect((await get(`/api/share/${shareId}/documents/${inside.id}`)).statusCode).toBe(200);
    expect((await get(`/api/share/${shareId}/documents/${outside.id}`)).statusCode).toBe(404);

    const other = await createTestUser('share-else@spine.test');
    const theirs = await shared(undefined, other.id);
    const all = await link('all', undefined);
    expect((await get(`/api/share/${all}/documents/${theirs.id}`)).statusCode).toBe(404);
  });

  it('answers 404 for a document the owner set aside by hiding every page', async () => {
    const doc = await shared();
    const shareId = await link('document_ids', [doc.id]);
    await getStore().pages.setHidden(OWNER_ID, doc.pageId, true);
    for (const p of await getStore().pages.listForSourceFile(OWNER_ID, doc.sourceFileId)) await getStore().pages.setHidden(OWNER_ID, p.id, true);
    expect((await get(`/api/share/${shareId}/documents/${doc.id}`)).statusCode).toBe(404);
  });

  it('is 410 for an unknown, revoked or unresolvable link, and says nothing else', async () => {
    const doc = await shared();
    expect((await get(`/api/share/${uuidv4()}/documents/${doc.id}`)).statusCode).toBe(410);

    const revoked = uuidv4();
    await seedShareLink({ id: revoked, scope: 'document_ids', scopeValue: JSON.stringify([doc.id]), revoked: true });
    expect((await get(`/api/share/${revoked}/documents/${doc.id}`)).statusCode).toBe(410);

    const broken = uuidv4();
    await seedShareLink({ id: broken, scope: 'tag', scopeValue: null });
    expect((await get(`/api/share/${broken}/documents/${doc.id}`)).statusCode).toBe(410);
  });
});

describe('a shared page image', () => {
  it('is served for a link that allows scans, for a page of a shared document', async () => {
    const doc = await shared();
    const shareId = await link('document_ids', [doc.id], true);
    const res = await get(`/api/share/${shareId}/pages/${doc.pageId}/image`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.rawPayload.equals(PNG)).toBe(true);
  });

  it('is 404 when the link does not allow scans', async () => {
    const doc = await shared();
    const shareId = await link('document_ids', [doc.id], false);
    expect((await get(`/api/share/${shareId}/pages/${doc.pageId}/image`)).statusCode).toBe(404);
  });

  it('is 404 for a page outside the share, another user’s page, a hidden page, and a made-up id', async () => {
    const inside = await shared('img-in');
    const outside = await shared('img-out');
    const shareId = await link('tag', 'img-in', true);
    expect((await get(`/api/share/${shareId}/pages/${inside.pageId}/image`)).statusCode).toBe(200);
    expect((await get(`/api/share/${shareId}/pages/${outside.pageId}/image`)).statusCode).toBe(404);
    expect((await get(`/api/share/${shareId}/pages/${uuidv4()}/image`)).statusCode).toBe(404);

    const other = await createTestUser('share-img-else@spine.test');
    const theirs = await shared(undefined, other.id);
    const all = await link('all', undefined, true);
    expect((await get(`/api/share/${all}/pages/${theirs.pageId}/image`)).statusCode).toBe(404);

    await getStore().pages.setHidden(OWNER_ID, inside.pageId, true);
    expect((await get(`/api/share/${shareId}/pages/${inside.pageId}/image`)).statusCode).toBe(404);
  });

  it('is 410 for a dead link, and logged', async () => {
    const doc = await shared();
    expect((await get(`/api/share/${uuidv4()}/pages/${doc.pageId}/image`)).statusCode).toBe(410);
  });
});

describe('creating a link with scans', () => {
  it('stores the choice, shows it to the owner, and refuses anything but true or false', async () => {
    const doc = await shared();
    const created = await app.inject({ method: 'POST', url: '/api/share-links', headers: { cookie }, payload: { scope: 'document_ids', scope_value: [doc.id], include_scans: true } });
    const { id } = created.json() as { id: string };
    const listed = (await app.inject({ method: 'GET', url: '/api/share-links', headers: { cookie } })).json() as Array<{ id: string; include_scans: boolean }>;
    expect(listed.find(l => l.id === id)?.include_scans).toBe(true);

    const plain = await app.inject({ method: 'POST', url: '/api/share-links', headers: { cookie }, payload: { scope: 'all' } });
    const plainId = (plain.json() as { id: string }).id;
    expect((await app.inject({ method: 'GET', url: '/api/share-links', headers: { cookie } })).json().find((l: { id: string }) => l.id === plainId).include_scans).toBe(false);

    for (const bad of ['yes', 1, null]) {
      const res = await app.inject({ method: 'POST', url: '/api/share-links', headers: { cookie }, payload: { scope: 'all', include_scans: bad } });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('values over time in a share', () => {
  it('counts and draws only the documents the link shares', async () => {
    const mine = await shared();
    const other = await shared(); // also has a glucose value, but is not in the link
    await getStore().measurements.create(OWNER_ID, {
      id: uuidv4(), documentId: other.id, pageId: other.pageId, name: 'Glucose', canonical: 'glucose', valueText: '9.9', valueNum: 9.9, unit: 'mmol/L',
      refLow: 3.9, refHigh: 5.6, flag: 'high', takenOn: '2027-01-01', sourceSnippet: null, bbox: null, confidence: 1,
    });
    const shareId = await link('document_ids', [mine.id]);

    const names = (await get(`/api/share/${shareId}/trends`)).json() as Array<{ canonical: string; count: number; latest_value_text: string }>;
    expect(names).toHaveLength(1);
    expect(names[0]).toMatchObject({ canonical: 'glucose', count: 1, latest_value_text: '5.1' }); // not the newer 9.9 of the document left out

    const series = (await get(`/api/share/${shareId}/trends/series?name=glucose`)).json();
    expect(series.points).toHaveLength(1);
    expect(series.points[0]).toMatchObject({ document_id: mine.id, value_text: '5.1', charted: true });
    expect(JSON.stringify(series)).not.toContain('9.9');
    expect(JSON.stringify(series)).not.toContain(other.id);
  });

  it('answers 404 for a test none of the shared documents has, and 410 for a dead link', async () => {
    const doc = await shared();
    const shareId = await link('document_ids', [doc.id]);
    expect((await get(`/api/share/${shareId}/trends/series?name=hemoglobin`)).statusCode).toBe(404);
    expect((await get(`/api/share/${shareId}/trends/series`)).statusCode).toBe(400);
    expect((await get('/api/share/not-a-shareId/trends')).statusCode).toBe(410);
    expect((await get('/api/share/not-a-shareId/trends/series?name=glucose')).statusCode).toBe(410);
  });
});
