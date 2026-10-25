import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { createSqliteStoreWith } from '../store/sqlite/store.js';
import { openNative } from '../store/sqlite/driver-native.js';
import { REPLICATED } from '../store/sync.js';
import { v4 as uuid } from 'uuid';
import type { Change, Store } from '../store/types.js';

/** Two devices as two stores over separate databases. Every test moves changes between them the way the vault will. */
const USER = 'user-owner';
let a: Store;
let b: Store;
const open = () => createSqliteStoreWith({ adapter: 'sqlite', location: ':memory:' }, openNative);

/** A source file, a page and a document in `store`, through its repositories. */
async function seedDocument(store: Store, o: { sourceFileId?: string; docDate?: string; aiSummary?: string; tags?: string[] } = {}) {
  const sourceFileId = o.sourceFileId ?? uuid();
  if (!o.sourceFileId) {
    await store.sourceFiles.create(USER, { id: sourceFileId, uploadedAt: new Date().toISOString(), originalFilename: 'scan.pdf', filePath: '/tmp/x.pdf', mimeType: 'application/pdf', checksum: uuid() });
    await store.sourceFiles.setStatus(USER, sourceFileId, 'done');
  }
  const pageId = uuid();
  await store.pages.create(USER, { id: pageId, sourceFileId, pageNumber: 1, imagePath: '/tmp/p.png', imageWidth: 800, imageHeight: 1100, rawText: 'page text', elements: [], extractionSource: 'native_text', isContinuation: null, continuationConfidence: null, continuationReasoning: null });
  const id = uuid();
  await store.documents.create(USER, { id, sourceFileId, pageStart: 1, pageEnd: 1, docDate: o.docDate ?? '2026-01-15', provider: 'Example Clinic', docType: 'lab_result', aiSummary: o.aiSummary ?? 'A lab result.' });
  if (o.tags?.length) await store.tags.setForDocument(USER, id, o.tags);
  return { id, sourceFileId, pageId };
}
const account = (store: Store) => store.users.create({ id: USER, email: 'owner@spine.test', passwordHash: 'x', createdAt: 'now', verifiedAt: 'now', consent: undefined });

/** Sends what each has written to the other. */
async function exchange(...stores: Store[]): Promise<void> {
  const sent = await Promise.all(stores.map(s => s.changes.drain()));
  for (let i = 0; i < stores.length; i++) for (let j = 0; j < stores.length; j++) if (i !== j) await stores[j].changes.apply(sent[i]);
}

/** What a store holds, in a form two stores can be compared by. */
const held = async (s: Store) => {
  await s.changes.drain();
  return (await s.changes.dump()).filter(c => c.r !== null).map(c => ({ t: c.t, k: c.k, r: c.r })).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
};

beforeEach(async () => {
  a = open(); b = open();
  await account(a); await account(b);
  await a.changes.drain(); await b.changes.drain();
});

describe('the list of synced tables', () => {
  it('is every table of the records schema, except the search index', () => {
    const sql = readFileSync(path.join(__dirname, '../store/sqlite/schema-records.sql'), 'utf8');
    const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(m => m[1]).sort();
    expect([...REPLICATED].sort()).toEqual(tables);
  });
});

describe('devices that write and then exchange changes', () => {
  it('a new device given a dump holds the same records', async () => {
    const seeded = await seedDocument(a, { tags: ['cardio'] });
    await a.fields.create(USER, { id: uuid(), documentId: seeded.id, pageId: seeded.pageId, label: 'Impression', value: 'no change', groupNo: null, sourceSnippet: null, bbox: null, confidence: 0.9 });
    await a.changes.drain();
    const snapshot = await a.changes.dump();
    expect(snapshot.length).toBeGreaterThan(3);
    await b.changes.apply(snapshot);
    expect(await held(b)).toEqual(await held(a));
    expect((await b.documents.findFor(USER, seeded.id))?.id).toBe(seeded.id);
  });

  it('edits to different rows on both devices are both kept', async () => {
    const one = await seedDocument(a, { docDate: '2026-01-01' });
    await exchange(a, b);
    const two = await seedDocument(b, { docDate: '2026-02-02' });
    await a.documents.update(USER, one.id, { title: 'from a' });
    await b.documents.update(USER, two.id, { title: 'from b' } as never);
    await exchange(a, b);
    for (const s of [a, b]) {
      expect((await s.documents.findFor(USER, one.id))?.title).toBe('from a');
      expect((await s.documents.findFor(USER, two.id))?.title).toBe('from b');
    }
    expect(await held(a)).toEqual(await held(b));
  });

  it('two edits to one row agree on the later one, whichever order they arrive in', async () => {
    const doc = await seedDocument(a);
    await exchange(a, b);
    await a.documents.update(USER, doc.id, { title: 'first' } as never);
    await new Promise(r => setTimeout(r, 5));
    await b.documents.update(USER, doc.id, { title: 'second' } as never);
    await exchange(a, b);
    expect((await a.documents.findFor(USER, doc.id))?.title).toBe('second');
    expect((await b.documents.findFor(USER, doc.id))?.title).toBe('second');
  });

  it('a deletion on one device is a change, and an older edit does not bring the row back', async () => {
    const doc = await seedDocument(a);
    await exchange(a, b);
    await b.documents.update(USER, doc.id, { title: 'edited' } as never);
    const edit = await b.changes.drain();
    await new Promise(r => setTimeout(r, 5));
    await a.documents.delete(USER, doc.id);
    const gone = await a.changes.drain();
    await b.changes.apply(gone);
    await a.changes.apply(edit);
    expect(await a.documents.findFor(USER, doc.id)).toBeNull();
    expect(await b.documents.findFor(USER, doc.id)).toBeNull();
  });

  it('the same tag made on two devices is one tag, and the documents keep it on both', async () => {
    const x = await seedDocument(a);
    await exchange(a, b);
    const y = await seedDocument(b, { sourceFileId: undefined });
    await a.tags.setForDocument(USER, x.id, ['cardiology']);
    await b.tags.setForDocument(USER, y.id, ['cardiology']);
    await exchange(a, b);
    await exchange(a, b);
    for (const s of [a, b]) {
      const names = (await s.tags.listFor(USER)).map(t => t.name);
      expect(names.filter(n => n === 'cardiology')).toHaveLength(1);
      expect(new Set(names).size).toBe(names.length);
      expect(await s.tags.namesForDocument(USER, x.id)).toEqual(['cardiology']);
      expect(await s.tags.namesForDocument(USER, y.id)).toEqual(['cardiology']);
    }
  });

  it('a tag that is not a starter, made on two devices under two keys, is one tag: the other device’s key means the one already held', async () => {
    const x = await seedDocument(a);
    await exchange(a, b);
    const y = await seedDocument(b, { sourceFileId: undefined });
    await a.tags.setForDocument(USER, x.id, ['allergy clinic']);
    await b.tags.setForDocument(USER, y.id, ['allergy clinic']);
    const [forA, forB] = [await a.tags.listFor(USER), await b.tags.listFor(USER)];
    expect(forA.find(t => t.name === 'allergy clinic')!.id).not.toBe(forB.find(t => t.name === 'allergy clinic')!.id);
    await exchange(a, b);
    await exchange(a, b);
    for (const s of [a, b]) {
      expect((await s.tags.listFor(USER)).filter(t => t.name === 'allergy clinic')).toHaveLength(1);
      expect(await s.tags.namesForDocument(USER, x.id)).toEqual(['allergy clinic']);
      expect(await s.tags.namesForDocument(USER, y.id)).toEqual(['allergy clinic']);
    }
  });

  it('two pages added at the same place of one file on two devices leave one page there, the same on both', async () => {
    const file = await seedDocument(a);
    await exchange(a, b);
    const add = (s: Store, id: string) => s.pages.create(USER, { id, sourceFileId: file.sourceFileId, pageNumber: 2, imagePath: '/tmp/q.png', imageWidth: 800, imageHeight: 1100, rawText: id, elements: [], extractionSource: 'native_text', isContinuation: null, continuationConfidence: null, continuationReasoning: null });
    await add(a, uuid());
    await new Promise(r => setTimeout(r, 5));
    await add(b, uuid());
    await exchange(a, b);
    await exchange(a, b);
    expect(await held(a)).toEqual(await held(b));
    const pages = (await held(a)).filter(c => c.t === 'pages' && (c.r as { page_number: number }).page_number === 2);
    expect(pages).toHaveLength(1);
  });

  it('a failed apply leaves nothing half done', async () => {
    await seedDocument(a);
    const changes = await a.changes.drain();
    const broken = changes.map(c => (c.t === 'documents' && c.r ? { ...c, r: { ...c.r, source_file_id: null } } : c));
    const before = await held(b);
    await expect(b.changes.apply(broken)).rejects.toThrow();
    expect(await held(b)).toEqual(before);
    expect(await b.changes.apply(changes)).toBeGreaterThan(0);
  });

  it('search finds what arrived from the other device', async () => {
    const doc = await seedDocument(a, { aiSummary: 'unique-word-amlodipine' });
    await exchange(a, b);
    const hits = await b.documents.listFor(USER, { q: 'amlodipine', limit: 10, offset: 0 } as never);
    expect(hits.map(h => h.id)).toContain(doc.id);
  });

  it('applying refuses while local changes wait to be drained', async () => {
    await seedDocument(a);
    await expect(a.changes.apply([])).resolves.toBe(0);
    await expect(a.changes.apply([{ t: 'tags', k: { id: 1 }, r: null, h: '00000000000001.00000.aaaaaaaa' }])).rejects.toThrow(/drain/);
  });

  it('applying the same changes twice changes nothing', async () => {
    await seedDocument(a, { tags: ['x'] });
    const first = await a.changes.drain();
    expect(await b.changes.apply(first)).toBeGreaterThan(0);
    expect(await b.changes.apply(first)).toBe(0);
  });
});

describe('a dump', () => {
  it('keeps a deletion as a change, so a device that is given it later does not bring the row back', async () => {
    const doc = await seedDocument(a);
    await exchange(a, b);
    await a.documents.delete(USER, doc.id);
    await a.changes.drain();
    const dump = await a.changes.dump();
    expect(dump.some(c => c.t === 'documents' && c.r === null)).toBe(true);
    const late = open();
    await account(late);
    await late.changes.drain();
    await late.changes.apply(dump);
    expect(await late.documents.findFor(USER, doc.id)).toBeNull();
  });
});

describe('a change', () => {
  it('survives being sealed as JSON, blobs and all', async () => {
    const doc = await seedDocument(a);
    await a.embeddings.put(USER, { documentId: doc.id, model: 'm', dims: 4, textHash: 'h', vector: Buffer.from([1, 2, 3, 250]) }, 'now');
    const sent = JSON.parse(JSON.stringify([...(await a.changes.drain()), ...[] as Change[]])) as Change[];
    await b.changes.apply(sent);
    expect(await held(b)).toEqual(await held(a));
  });
});
