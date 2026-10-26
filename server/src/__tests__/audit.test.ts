import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { Readable } from 'stream';
import { v4 as uuidv4 } from 'uuid';
import { buildTestApp, loginSession } from './helpers/app.js';
import { OWNER_ID, seedDocument } from './helpers/seed.js';
import { getStore } from 'spine-core/store/index.js';
import { saveStream } from 'spine-core/ingestion/accept-upload.js';
import { runQueued } from 'spine-core/ingestion/jobs.js';
import { manifestSchema } from 'spine-core/archive/manifest.js';
import { resetChatLlm } from 'spine-core/llm/index.js';
import type { ChatLlm, TranslationBundle } from 'spine-core/llm/types.js';

/**
 * Checks from the security review of export, import, translation, sharing and the library (SECURITY.md, "Review of
 * the features added with translation"). Each is a way the feature could be made to do more than it should.
 */
let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
const dir = mkdtempSync(path.join(tmpdir(), 'spine-audit-'));
beforeAll(async () => { app = await buildTestApp(); cookie = await loginSession(app); });
afterAll(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
afterEach(() => resetChatLlm());

describe('an upload cannot make the server write more than it will keep', () => {
  const stream = (head: Buffer, total: number) => Readable.from((function* () { yield head; let sent = head.length; while (sent < total) { const n = Math.min(64 * 1024, total - sent); yield Buffer.alloc(n, 0x41); sent += n; } })());

  it('cuts something that is not a zip at the single-file limit, and lets a zip run to its own', async () => {
    const limits = { zip: 400_000, other: 100_000 };
    const plain = path.join(dir, 'plain');
    const a = await saveStream(stream(Buffer.from('%PDF-1.4 '), 350_000), plain, limits);
    expect(a).toMatchObject({ truncated: true, zip: false });
    expect(statSync(plain).size).toBeLessThanOrEqual(100_000 + 64 * 1024); // stopped near the limit, not at the end

    const zipped = path.join(dir, 'zipped');
    const b = await saveStream(stream(Buffer.from([0x50, 0x4b, 3, 4]), 350_000), zipped, limits);
    expect(b).toMatchObject({ truncated: false, zip: true, bytes: 350_000 });
    const tooBig = await saveStream(stream(Buffer.from([0x50, 0x4b, 3, 4]), 500_000), path.join(dir, 'zip2'), limits);
    expect(tooBig.truncated).toBe(true);
  });
});

describe('a zip full of files does not start them all at once', () => {
  it('works on a few at a time and the rest wait', async () => {
    let running = 0; let peak = 0;
    const work = () => runQueued(async () => { running += 1; peak = Math.max(peak, running); await new Promise(r => setTimeout(r, 15)); running -= 1; });
    await Promise.all(Array.from({ length: 12 }, work));
    expect(peak).toBeLessThanOrEqual(2);
    expect(running).toBe(0);
  });
});

describe('a manifest is data we were given', () => {
  const base = (over: Record<string, unknown> = {}, doc: Record<string, unknown> = {}) => ({
    format: 'spine-export', version: 1, exported_at: 'now', kind: 'document',
    files: [{
      path: 'files/1.pdf', original_filename: null, sha256: 'a'.repeat(64), page_count: 1,
      pages: [{ number: 1, source_page: 1, hidden: false, extraction_source: 'native_text', raw_text: 'x', elements: [] }],
      documents: [{
        page_start: 1, page_end: 1, title: 'T', doc_date: '2026-01-01', provider: null, doc_type: 'other', ai_summary: null, user_notes: null,
        language: 'en', reviewed: false, tags: [], doctors: [], fields: [],
        measurements: [{ name: 'Hb', canonical: '  HB ', value_text: '1', value_num: 1, unit: null, ref_low: null, ref_high: null, flag: null, taken_on: '2026-01', page: 1, source_snippet: null, bbox: null, confidence: 1 }],
        ...doc,
      }],
    }],
    ...over,
  });

  it('accepts a well-formed one and files a test under its lower-case name', () => {
    const parsed = manifestSchema.parse(base());
    expect(parsed.files[0].documents[0].measurements[0].canonical).toBe('hb');
  });

  it.each([
    ['a date that is not a date', { doc_date: '1 March' }],
    ['text where a month or day belongs', { measurements: [{ ...base().files[0].documents[0].measurements[0], taken_on: '<script>' }] }],
    ['too many tags on a document', { tags: Array.from({ length: 51 }, (_, i) => `t${i}`) }],
    ['a box outside the page', { fields: [{ label: 'a', value: 'b', group_no: null, page: 1, source_snippet: null, bbox: { x0: 0, y0: 0, x1: 9, y1: 1 }, confidence: 1 }] }],
    ['an unknown document type', { doc_type: 'prescription; DROP TABLE' }],
  ])('refuses %s', (_name, doc) => {
    expect(manifestSchema.safeParse(base({}, doc)).success).toBe(false);
  });

  it('refuses another format or version, and an export that claims more than any archive holds', () => {
    expect(manifestSchema.safeParse(base({ format: 'something-else' })).success).toBe(false);
    expect(manifestSchema.safeParse(base({ version: 4 })).success).toBe(false);
    const file = base().files[0];
    const many = { ...file, documents: Array.from({ length: 20_001 }, () => file.documents[0]) };
    expect(manifestSchema.safeParse(base({ files: [many] })).success).toBe(false);
  });
});

describe('a share recipient\'s read does not change the owner\'s records', () => {
  it('does not record a language the model found, and a later owner visit does', async () => {
    const doc = await seedDocument();
    await getStore().documents.update(OWNER_ID, doc.id, { title: 'Buletin', language: null });
    const llm = { translate: async (b: TranslationBundle) => ({
      title: b.title && `EN ${b.title}`, summary: b.summary && `EN ${b.summary}`, notes: null, source_language: 'ro',
      fields: b.fields.map(f => ({ ...f, value: `EN ${f.value}` })), measurements: [], doctors: [],
    }) } as unknown as ChatLlm;
    resetChatLlm(llm);

    const created = await app.inject({ method: 'POST', url: '/api/share-links', headers: { cookie }, payload: { scope: 'document_ids', scope_value: [doc.id], expires_days: 7 } });
    const { id: shareId } = created.json() as { id: string };
    const res = await app.inject({ method: 'GET', url: `/api/share/${shareId}/documents/${doc.id}/translation?lang=en` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ title: 'EN Buletin' });
    expect((await getStore().documents.findFor(OWNER_ID, doc.id))?.language).toBeNull(); // untouched

    await app.inject({ method: 'GET', url: `/api/documents/${doc.id}/translation?lang=en`, headers: { cookie } });
    expect((await getStore().documents.findFor(OWNER_ID, doc.id))?.language).toBe('ro');
  });
});

describe('removing a tag a link uses narrows the link, never widens it', () => {
  it('shares nothing once the tag is gone', async () => {
    const doc = await seedDocument({ tags: ['shared-tag'] });
    const { id: shareId } = (await app.inject({ method: 'POST', url: '/api/share-links', headers: { cookie }, payload: { scope: 'tag', scope_value: 'shared-tag', expires_days: 7 } })).json() as { id: string };
    expect(((await app.inject({ method: 'GET', url: `/api/share/${shareId}/documents` })).json() as unknown[]).length).toBe(1);

    const id = ((await app.inject({ method: 'GET', url: '/api/tags', headers: { cookie } })).json() as Array<{ id: number; name: string }>).find(t => t.name === 'shared-tag')!.id;
    expect((await app.inject({ method: 'DELETE', url: `/api/tags/${id}`, headers: { cookie } })).statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: `/api/share/${shareId}/documents` });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toEqual([]);
    expect(await getStore().documents.findFor(OWNER_ID, doc.id)).not.toBeNull(); // the document is untouched
    void uuidv4;
  });
});
