import { describe, it, expect, beforeAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { openDatabase } from 'spine-core/store/sqlite/connection.js';
import { openNative } from 'spine-core/store/sqlite/driver-native.js';
import { createSqliteStoreWith } from 'spine-core/store/sqlite/store.js';
import { copySlice } from 'spine-core/store/sqlite/slice.js';
import type { Database } from 'spine-core/store/sqlite/driver.js';
import { resetStore, getStore } from 'spine-core/store/index.js';
import { buildTestApp } from './helpers/app.js';
import { OWNER_ID, seedDocument, seedPage, seedSourceFile } from './helpers/seed.js';
import { hashShareToken } from 'spine-core/share-token.js';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * The copy a share is made of must hold what the recipient may read and nothing else, because the browser that opens it holds the
 * whole file. This builds one from an owner's records that include things that must stay out, and looks at every table of the result.
 */
const SCHEMA = ['schema-accounts.sql', 'schema-records.sql'].map(f => readFileSync(path.join(__dirname, '../../../core/src/store/sqlite', f), 'utf8')).join('\n');
const LOCAL = hashShareToken('local');

describe('the copy a share is made of', () => {
  let source: Database;
  let shared: string[];
  let outside: string;
  let sourceStore: ReturnType<typeof createSqliteStoreWith>;

  async function seed() {
    const upload = await seedSourceFile({ status: 'done', filePath: '/home/owner/data/originals/jane-example-labs.pdf' });
    const p1 = await seedPage(upload, { pageNumber: 1, imagePath: '/home/owner/data/pages/p1.png', rawText: 'Hemoglobin 13.5 g/dL for Jane Example' });
    const p2 = await seedPage(upload, { pageNumber: 2, imagePath: '/home/owner/data/pages/p2.png', rawText: 'second page text' });
    const a = await seedDocument({ sourceFileId: upload, withPage: false, aiSummary: 'a lab report', tags: ['labs', 'private'] });
    const b = await seedDocument({ withPage: true, aiSummary: 'unrelated visit', tags: ['visit'] });
    const store = getStore();
    await store.documents.setPageEnd(OWNER_ID, a.id, 2);
    await store.fields.create(OWNER_ID, { id: uuidv4(), documentId: a.id, pageId: p1, label: 'Finding', value: 'normal', sourceSnippet: 'Hemoglobin 13.5 g/dL for Jane Example', bbox: { x0: 1, y0: 2, x1: 3, y1: 4 }, confidence: 0.9 });
    await store.measurements.create(OWNER_ID, { id: uuidv4(), documentId: a.id, pageId: p1, name: 'Hemoglobin', canonical: 'hemoglobin', valueText: '13.5', valueNum: 13.5, unit: 'g/dL', refLow: 12, refHigh: 16, flag: 'normal', takenOn: '2026-01-15', sourceSnippet: 'Hemoglobin 13.5', bbox: null, confidence: 0.9 });
    await store.measurements.create(OWNER_ID, { id: uuidv4(), documentId: b.id, pageId: b.pageId!, name: 'Glucose', canonical: 'glucose', valueText: '5.1', valueNum: 5.1, unit: 'mmol/L', refLow: null, refHigh: null, flag: null, takenOn: '2026-02-01', sourceSnippet: null, bbox: null, confidence: 0.9 });
    const doctor = (await store.doctors.upsert(OWNER_ID, { name: 'Dr. Ioana Example', specialty: 'cardiology', licenseCode: 'X12345' }, new Date().toISOString()))!;
    await store.doctors.link(OWNER_ID, a.id, doctor, 'author', 'text', 'X12345');
    await store.doctors.link(OWNER_ID, b.id, doctor, 'author');
    await store.links.add(OWNER_ID, { from_document_id: a.id, to_document_id: b.id, kind: 'follow_up', source: 'owner', state: 'confirmed', reason: '{"tests":["secret"]}' }, new Date().toISOString());
    return { a: a.id, b: b.id, p2 };
  }

  beforeAll(async () => {
    await buildTestApp();
    source = openDatabase(':memory:', openNative, undefined, 'full');
    sourceStore = createSqliteStoreWith({ adapter: 'sqlite', location: ':memory:' }, () => source, SCHEMA);
    resetStore(sourceStore);
    await sourceStore.users.create({ id: OWNER_ID, email: 'owner@spine.test', passwordHash: 'h', createdAt: new Date().toISOString(), verifiedAt: new Date().toISOString() });
    const s = await seed();
    shared = [s.a];
    outside = s.b;
  });

  const slice = (options: { includeText: boolean; includeScans: boolean; allowChat?: boolean }) => {
    const dest = openDatabase(':memory:', openNative, undefined, 'full');
    const result = copySlice(source, dest, {
      userId: OWNER_ID, documentIds: shared, includeText: options.includeText, includeScans: options.includeScans, tokenHash: LOCAL,
      link: { id: 'link-1', label: 'for the cardiologist', createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-10-08T00:00:00.000Z', language: 'en', allowChat: options.allowChat ?? false },
      imagePathOf: id => `/share/pages/${id}.png`,
    });
    const all = (sql: string) => dest.prepare(sql).all() as Array<Record<string, unknown>>;
    const everything = () => JSON.stringify((all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%fts%' AND name NOT LIKE 'sqlite_%'")).flatMap(t => all(`SELECT * FROM ${t.name as string}`)));
    return { dest, result, all, everything };
  };

  it('holds the shared document with its results, doctors, tags and pages, and nothing of the others', () => {
    const { all } = slice({ includeText: false, includeScans: false });
    expect(all('SELECT id FROM documents').map(r => r.id)).toEqual(shared);
    expect(all('SELECT name FROM measurements').map(r => r.name)).toEqual(['Hemoglobin']);
    expect(all('SELECT name FROM tags ORDER BY name').map(r => r.name)).toEqual(['labs', 'private']);
    expect(all('SELECT name, specialty FROM doctors')).toEqual([{ name: 'Ioana Example', specialty: 'cardiology' }]);
    expect(all('SELECT page_number FROM pages ORDER BY page_number').map(r => r.page_number)).toEqual([1, 2]);
    expect(all('SELECT id FROM source_files')).toHaveLength(1);
    expect(all('SELECT COUNT(*) AS n FROM documents WHERE id = ?'.replace('?', `'${outside}'`))[0].n).toBe(0);
  });

  it('leaves out what the recipient is not meant to have', () => {
    const { everything, all } = slice({ includeText: false, includeScans: false });
    const text = everything();
    for (const word of ['owner@spine.test', 'jane-example-labs', '/home/owner', 'X12345', 'Jane Example', 'secret', 'unrelated visit', 'Glucose', '"x0"']) expect(text).not.toContain(word);
    expect(all('SELECT raw_text, elements, image_path FROM pages')).toEqual([{ raw_text: '', elements: '[]', image_path: '' }, { raw_text: '', elements: '[]', image_path: '' }]);
    expect(all('SELECT file_path, original_filename, checksum FROM source_files')).toEqual([{ file_path: '', original_filename: 'shared', checksum: null }]);
    expect(all('SELECT license_code FROM doctors')).toEqual([{ license_code: null }]);
    expect(all('SELECT source_snippet, bbox_x0 FROM extracted_fields')).toEqual([{ source_snippet: null, bbox_x0: null }]);
    expect(all('SELECT email FROM users')).toEqual([{ email: 'shared@invalid.example' }]);
  });

  it('carries page text only when the recipient may ask questions, and images only when scans are allowed', () => {
    const text = slice({ includeText: true, includeScans: false, allowChat: true });
    expect(text.all('SELECT raw_text FROM pages WHERE page_number = 1')[0].raw_text).toContain('Hemoglobin 13.5');
    expect(text.result.images).toEqual([]);
    const scans = slice({ includeText: false, includeScans: true });
    expect(scans.result.images.map(i => i.from).sort()).toEqual(['/home/owner/data/pages/p1.png', '/home/owner/data/pages/p2.png']);
    expect(scans.all('SELECT image_path FROM pages').map(r => r.image_path).sort()).toEqual(scans.result.images.map(i => i.to).sort());
    expect(scans.everything()).not.toContain('/home/owner');
  });

  it('names the link as the recipient’s core knows it', () => {
    const { all } = slice({ includeText: false, includeScans: false });
    expect(all('SELECT id, scope, scope_value, require_approval, include_scans, allow_chat, token FROM share_links')).toEqual([
      { id: 'link-1', scope: 'document_ids', scope_value: JSON.stringify(shared), require_approval: 0, include_scans: 0, allow_chat: 0, token: LOCAL },
    ]);
  });

  it('keeps only links between documents that are both shared', () => {
    shared = [shared[0], outside];
    const both = slice({ includeText: false, includeScans: false });
    expect(both.all('SELECT kind FROM document_links')).toEqual([{ kind: 'follow_up' }]);
    expect(both.all('SELECT reason FROM document_links')).toEqual([{ reason: null }]);
    shared = [shared[0]];
    expect(slice({ includeText: false, includeScans: false }).all('SELECT * FROM document_links')).toEqual([]);
  });
});
