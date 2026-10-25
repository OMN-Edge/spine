import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { buildTestApp, loginSession } from './helpers/app.js';
import { seedDocument } from './helpers/seed.js';
import { getStore } from 'spine-core/store/index.js';

const OWNER = 'user-owner';
let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
beforeAll(async () => { app = await buildTestApp(); cookie = await loginSession(app); });
afterAll(async () => { await app.close(); });

const field = (documentId: string, pageId: string, confidence: number | null, ownerEdited = false) =>
  getStore().fields.create(OWNER, { id: uuidv4(), documentId, pageId, label: 'diagnosis', value: 'x', sourceSnippet: null, bbox: null, confidence, ownerEdited });

describe('values to check (FR-EXT-04)', () => {
  it('counts what was read with low confidence and not confirmed, in fields and results', async () => {
    const { id, pageId } = await seedDocument({});
    await field(id, pageId!, 0.4);          // checks
    await field(id, pageId!, 0.69);         // checks
    await field(id, pageId!, 0.7);          // sure enough
    await field(id, pageId!, 0.2, true);    // the owner has edited it: no longer in question
    await field(id, pageId!, null);         // no score: not flagged
    await getStore().measurements.create(OWNER, {
      id: uuidv4(), documentId: id, pageId: pageId!, name: 'Hemoglobina', canonical: 'hemoglobin', valueText: '13,5', valueNum: 13.5, unit: 'g/dl',
      refLow: null, refHigh: null, flag: null, takenOn: null, sourceSnippet: null, bbox: null, confidence: 0.5,
    });

    const list = (await app.inject({ method: 'GET', url: '/api/documents', headers: { cookie } })).json() as Array<{ id: string; to_check: number }>;
    expect(list.find(d => d.id === id)!.to_check).toBe(3);
    const one = (await app.inject({ method: 'GET', url: `/api/documents/${id}`, headers: { cookie } })).json() as { to_check: number };
    expect(one.to_check).toBe(3);

    // Each row says so too, and a document the owner has reviewed has nothing left to check.
    const rows = (await getStore().fields.listForDocument(OWNER, id)).map(f => [f.confidence, !!f.needs_check]);
    expect(rows).toEqual([[0.4, true], [0.69, true], [0.7, false], [0.2, false], [null, false]]);
    expect((await getStore().measurements.listForDocument(OWNER, id))[0].needs_check).toBeTruthy();
    await getStore().documents.update(OWNER, id, { reviewed: true });
    expect(((await app.inject({ method: 'GET', url: `/api/documents/${id}`, headers: { cookie } })).json() as { to_check: number }).to_check).toBe(0);
  });

  it('is nothing for a document with nothing read', async () => {
    const { id } = await seedDocument({});
    const list = (await app.inject({ method: 'GET', url: '/api/documents', headers: { cookie } })).json() as Array<{ id: string; to_check: number }>;
    expect(list.find(d => d.id === id)!.to_check).toBe(0);
  });
});
