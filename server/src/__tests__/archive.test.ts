import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { ZipFile } from 'yazl';
import { buildTestApp, loginAs, loginSession } from './helpers/app.js';
import { createTestUser, OWNER_ID, seedSourceFile } from './helpers/seed.js';
import { getStore } from '../store/index.js';
import { ZipReader } from '../archive/zip-read.js';
import { documentFingerprint, manifestSchema, type Manifest } from '../archive/manifest.js';
import { getJobStatus } from '../ingestion/jobs.js';

// A plain zip hands its PDFs to the ordinary upload path, which would read them with a model.
const mockStartJob = vi.hoisted(() => vi.fn());
vi.mock('../ingestion/pipeline.js', () => ({ startIngestionJob: mockStartJob, getJobStatus: vi.fn().mockReturnValue(null) }));

const hasPoppler = (() => {
  try { execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' }); execFileSync('pdfseparate', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

/** A small valid PDF with one line of text on each page. */
function makePdf(lines: string[]): Buffer {
  const objects: string[] = [];
  const kids = lines.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${lines.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  lines.forEach((line, i) => {
    const content = `BT /F1 14 Tf 72 700 Td (${line}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function zipOf(entries: Array<{ name: string; data: Buffer }>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new ZipFile();
    for (const e of entries) zip.addBuffer(e.data, e.name);
    zip.end();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', c => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
  });
}

function multipart(filename: string, content: Buffer) {
  const boundary = 'ArchiveBoundary777';
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  return { boundary, payload: Buffer.concat([Buffer.from(head), content, Buffer.from(`\r\n--${boundary}--`)]) };
}

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
let otherCookie: string;
let otherId: string;
const dir = mkdtempSync(path.join(tmpdir(), 'spine-archive-'));

beforeAll(async () => {
  process.env.DATA_DIR = dir;
  app = await buildTestApp();
  cookie = await loginSession(app);
  const other = await createTestUser('other@spine.test');
  otherId = other.id;
  otherCookie = await loginAs(app, other.email, other.password);
});
afterAll(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

const upload = (who: string, filename: string, content: Buffer) => {
  const { boundary, payload } = multipart(filename, content);
  return app.inject({ method: 'POST', url: '/api/source-files/upload', headers: { cookie: who, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
};

/** An upload of three pages, read as two documents: pages 1-2, then page 3. The first has everything a document can hold. */
async function archive(userId = OWNER_ID) {
  const store = getStore();
  const file = path.join(dir, `${uuidv4()}.pdf`);
  const pdf = makePdf(['First page of the lab report from the clinic', 'Second page continues the lab report results', 'Third page is a different prescription document']);
  writeFileSync(file, pdf);
  const sf = await seedSourceFile({ userId, status: 'done', filePath: file });
  await store.sourceFiles.setPageCount(userId, sf, 3);

  const ids: string[] = [];
  for (const [i, text] of ['First page of the lab report from the clinic', 'Second page continues the lab report results', 'Third page is a different prescription document'].entries()) {
    const id = uuidv4(); ids.push(id);
    await store.pages.create(userId, { id, sourceFileId: sf, pageNumber: i + 1, imagePath: '/tmp/none.png', imageWidth: 800, imageHeight: 1100, rawText: text, elements: [], extractionSource: 'native_text', isContinuation: null, continuationConfidence: null, continuationReasoning: null });
  }
  const a = uuidv4(); const b = uuidv4();
  await store.documents.create(userId, { id: a, sourceFileId: sf, pageStart: 1, pageEnd: 2, title: 'Lab report', docDate: '2026-03-01', provider: 'Clinic', docType: 'lab_result', aiSummary: 'Blood tests', language: 'en' });
  await store.documents.update(userId, a, { user_notes: 'My note', reviewed: true });
  await store.documents.create(userId, { id: b, sourceFileId: sf, pageStart: 3, pageEnd: 3, title: 'Prescription', docType: 'prescription', language: 'en' });
  await store.tags.setForDocument(userId, a, ['blood']);
  await store.fields.create(userId, { id: uuidv4(), documentId: a, pageId: ids[1], label: 'diagnosis', value: 'Anaemia', groupNo: null, sourceSnippet: 'Anaemia', bbox: { x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.2 }, confidence: 0.9 });
  await store.measurements.create(userId, { id: uuidv4(), documentId: a, pageId: ids[0], name: 'Hemoglobin', canonical: 'hemoglobin', valueText: '13.5', valueNum: 13.5, unit: 'g/dL', refLow: 12, refHigh: 16, flag: null, takenOn: '2026-03-01', sourceSnippet: null, bbox: null, confidence: 1 });
  const doctor = (await store.doctors.upsert(userId, { name: 'Ion Popescu', specialty: 'hematology' }, '2026-03-01'))!;
  await store.doctors.link(userId, a, doctor, 'author');
  return { sf, a, b, pageIds: ids };
}

async function unzip(body: Buffer): Promise<{ manifest: Manifest; reader: ZipReader; names: string[]; file: string }> {
  const file = path.join(dir, `${uuidv4()}.zip`);
  writeFileSync(file, body);
  const reader = await ZipReader.open(file);
  const manifest = manifestSchema.parse(JSON.parse((await reader.readBuffer('manifest.json', 50_000_000)).toString()));
  return { manifest, reader, names: reader.entries.map(e => e.name), file };
}

async function untilDone(userId: string, id: string) {
  for (let i = 0; i < 100; i++) {
    const row = await getStore().sourceFiles.findFor(userId, id);
    if (row && row.status !== 'processing' && row.status !== 'pending') return row;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('the restore did not finish');
}

describe('export', () => {
  it('needs a session, and another user\'s document is not found', async () => {
    const d = await archive();
    expect((await app.inject({ method: 'GET', url: `/api/documents/${d.a}/export` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/export' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/documents/${d.a}/export`, headers: { cookie: otherCookie } })).statusCode).toBe(404);
  });

  it('says there is nothing to export when there is nothing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/export', headers: { cookie: otherCookie } });
    expect(res.statusCode).toBe(404);
  });

  it.skipIf(!hasPoppler)('gives one document as its own pages with what was read from it', async () => {
    const d = await archive();
    const res = await app.inject({ method: 'GET', url: `/api/documents/${d.b}/export`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="spine-prescription-\d{4}-\d{2}-\d{2}\.zip"$/);

    const { manifest, reader, names } = await unzip(res.rawPayload);
    expect(names.sort()).toEqual(['files/1.pdf', 'manifest.json']);
    expect(manifest.kind).toBe('document');
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0].page_count).toBe(1);
    expect(manifest.files[0].documents[0]).toMatchObject({ title: 'Prescription', page_start: 1, page_end: 1, doc_type: 'prescription' });
    // Only its own page: the other document's text is nowhere in the zip.
    const pdf = path.join(dir, 'trimmed.pdf');
    await reader.extractTo('files/1.pdf', pdf, 10_000_000);
    expect(execFileSync('pdfinfo', [pdf]).toString()).toMatch(/Pages:\s+1/);
    expect(execFileSync('pdftotext', [pdf, '-']).toString()).toContain('Third page');
    expect(execFileSync('pdftotext', [pdf, '-']).toString()).not.toContain('First page');
    expect(JSON.stringify(manifest)).not.toContain('Blood tests');
    reader.close();
  });

  it.skipIf(!hasPoppler)('gives the whole archive with every upload as it is, and no ids, paths or share links', async () => {
    await archive();
    const res = await app.inject({ method: 'GET', url: '/api/export', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const { manifest, reader } = await unzip(res.rawPayload);
    expect(manifest.kind).toBe('archive');
    const file = manifest.files.find(f => f.documents.length === 2)!;
    expect(file.pages).toHaveLength(3);
    const lab = file.documents.find(d => d.title === 'Lab report')!;
    expect(lab).toMatchObject({ user_notes: 'My note', reviewed: true, tags: ['blood'], page_start: 1, page_end: 2 });
    expect(lab.fields[0]).toMatchObject({ label: 'diagnosis', value: 'Anaemia', page: 2, bbox: { x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.2 } });
    expect(lab.measurements[0]).toMatchObject({ canonical: 'hemoglobin', value_num: 13.5, page: 1 });
    expect(lab.doctors[0]).toMatchObject({ name: 'Ion Popescu', specialty: 'hematology', role: 'author' });
    const text = JSON.stringify(manifest);
    expect(text).not.toContain(OWNER_ID);
    expect(text).not.toContain(dir);
    reader.close();
  });
});

describe.skipIf(!hasPoppler)('import of a Spine export', () => {
  it('restores a document into another account without a model, and a second time it is a duplicate', async () => {
    const d = await archive();
    const exported = (await app.inject({ method: 'GET', url: `/api/documents/${d.a}/export`, headers: { cookie } })).rawPayload;

    const first = await upload(otherCookie, 'spine-lab-report.zip', exported);
    const results = first.json() as Array<Record<string, any>>;
    expect(results[0].zip).toMatchObject({ kind: 'spine', files: 1, documents: 1, restored: 1, duplicates: 0 });
    const restored = results[1];
    expect(restored).toMatchObject({ status: 'processing', restored: true });
    expect(mockStartJob).not.toHaveBeenCalled(); // nothing was read by a model

    const row = await untilDone(otherId, restored.id);
    expect(row.status).toBe('done');
    const store = getStore();
    const docs = await store.documents.listFor(otherId, { sourceFileId: restored.id, limit: 10, offset: 0 });
    expect(docs).toHaveLength(1);
    const doc = docs[0];
    expect(doc).toMatchObject({ title: 'Lab report', doc_date: '2026-03-01', user_notes: 'My note', language: 'en' });
    expect(!!doc.reviewed).toBe(true);
    expect(doc.id).not.toBe(d.a); // ids are made again
    expect(await store.tags.namesForDocument(otherId, doc.id)).toEqual(['blood']);
    const fields = await store.fields.listForDocument(otherId, doc.id);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ label: 'diagnosis', value: 'Anaemia', bbox_x0: 0.1 });
    expect((await store.measurements.listForDocument(otherId, doc.id))[0]).toMatchObject({ canonical: 'hemoglobin', value_num: 13.5 });
    expect((await store.doctors.forDocument(otherId, doc.id))[0]).toMatchObject({ name: 'Ion Popescu', role: 'author' });
    const pages = await store.pages.listForSourceFile(otherId, restored.id);
    expect(pages.map(p => p.raw_text)).toEqual(['First page of the lab report from the clinic', 'Second page continues the lab report results']);
    expect(await store.pages.findImagePathFor(otherId, pages[0].id)).toMatch(/page-1\.png$/);
    // It is the other account's alone.
    expect(await store.documents.findFor(OWNER_ID, doc.id)).toBeNull();

    const again = (await upload(otherCookie, 'spine-lab-report.zip', exported)).json() as Array<Record<string, any>>;
    expect(again[0].zip).toMatchObject({ documents: 1, restored: 0, duplicates: 1 });
    expect(again[1]).toMatchObject({ skipped: true, reason: 'duplicate', existing_id: restored.id });
  });

  it('recognises a document that is already there by its words, though its file is a new, smaller one', async () => {
    const d = await archive();
    const exported = (await app.inject({ method: 'GET', url: `/api/documents/${d.a}/export`, headers: { cookie } })).rawPayload;
    const before = (await getStore().sourceFiles.listFor(OWNER_ID)).length;
    const results = (await upload(cookie, 'mine-again.zip', exported)).json() as Array<Record<string, any>>;
    expect(results[0].zip).toMatchObject({ restored: 0, duplicates: 1 });
    expect(results[1]).toMatchObject({ skipped: true, reason: 'duplicate' });
    expect((await getStore().sourceFiles.listFor(OWNER_ID)).map(u => u.id)).toContain(results[1].existing_id);
    expect((await getStore().sourceFiles.listFor(OWNER_ID)).length).toBe(before); // nothing was added
    void d;
  });

  it('restores the whole archive with its grouping, and sets aside only the documents that were already there', async () => {
    const d = await archive();
    await getStore().pages.setHidden(OWNER_ID, d.pageIds[2], true); // a hidden page stays hidden
    const exported = (await app.inject({ method: 'GET', url: '/api/export', headers: { cookie } })).rawPayload;
    const third = await createTestUser('third@spine.test');
    const thirdCookie = await loginAs(app, third.email, third.password);
    const results = (await upload(thirdCookie, 'everything.zip', exported)).json() as Array<Record<string, any>>;
    const made = results.filter(r => r.restored);
    expect(made.length).toBeGreaterThan(0);
    for (const r of made) await untilDone(third.id, r.id);
    const store = getStore();
    const withThree = (await Promise.all(made.map(async r => ({ r, pages: await store.pages.listForSourceFile(third.id, r.id) })))).find(x => x.pages.length === 3)!;
    expect(withThree.pages.map(p => !!p.hidden)).toEqual([false, false, true]);
    expect(await store.documents.listFor(third.id, { sourceFileId: withThree.r.id, limit: 10, offset: 0, includeHidden: true })).toHaveLength(2);

    // Into an account that already holds one of the documents, that one is kept out of sight and the other is not.
    const again = (await upload(otherCookie, 'everything.zip', exported)).json() as Array<Record<string, any>>;
    expect(again[0].zip.duplicates).toBeGreaterThan(0);
  });

  it('refuses a manifest that is not valid, or from a newer version, and a file it names that is not there', async () => {
    const bad = await zipOf([{ name: 'manifest.json', data: Buffer.from(JSON.stringify({ format: 'spine-export', version: 1, files: 'no' })) }]);
    expect((await upload(cookie, 'bad.zip', bad)).json()).toEqual([{ skipped: true, reason: 'export_invalid', filename: 'bad.zip' }]);
    const newer = await zipOf([{ name: 'manifest.json', data: Buffer.from(JSON.stringify({ format: 'spine-export', version: 99 })) }]);
    expect((await upload(cookie, 'newer.zip', newer)).json()).toEqual([{ skipped: true, reason: 'export_version', filename: 'newer.zip' }]);

    const d = await archive();
    const { manifest } = await unzip((await app.inject({ method: 'GET', url: `/api/documents/${d.a}/export`, headers: { cookie } })).rawPayload);
    manifest.files[0].path = '../../../etc/passwd';
    const slip = await zipOf([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }]);
    const results = (await upload(cookie, 'slip.zip', slip)).json() as Array<Record<string, any>>;
    expect(results.at(-1)).toMatchObject({ skipped: true, reason: 'export_file_missing' });
  });

  it('keeps nothing when the manifest does not fit its file', async () => {
    const d = await archive();
    const exported = (await app.inject({ method: 'GET', url: `/api/documents/${d.b}/export`, headers: { cookie } })).rawPayload;
    const { manifest, reader } = await unzip(exported);
    const pdf = path.join(dir, 'one-page.pdf');
    await reader.extractTo('files/1.pdf', pdf, 10_000_000);
    reader.close();
    manifest.files[0].page_count = 2; // claims a page the file does not have
    manifest.files[0].pages.push({ ...manifest.files[0].pages[0], number: 2, source_page: 2 });
    manifest.files[0].documents[0].title = 'Never restored';
    const zip = await zipOf([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }, { name: 'files/1.pdf', data: readFileSync(pdf) }]);
    const results = (await upload(otherCookie, 'wrong.zip', zip)).json() as Array<Record<string, any>>;
    const row = await untilDone(otherId, results.at(-1)!.id);
    expect(row.status).toBe('error');
    expect(await getStore().documents.listFor(otherId, { sourceFileId: row.id, limit: 10, offset: 0 })).toEqual([]);
    expect(getJobStatus(row.id)?.status).toBe('error');
  });
});

describe('import of an ordinary zip', () => {
  it('hands each PDF to the ordinary upload, skips what is not one, and says what the zip was', async () => {
    mockStartJob.mockClear();
    const one = makePdf(['one']); const two = makePdf(['two']);
    const zip = await zipOf([
      { name: 'folder/one.pdf', data: one }, { name: 'two.pdf', data: two },
      { name: 'notes.txt', data: Buffer.from('not a pdf') }, { name: '__MACOSX/._one.pdf', data: Buffer.from('junk') },
    ]);
    const results = (await upload(cookie, 'scans.zip', zip)).json() as Array<Record<string, any>>;
    expect(results[0].zip).toMatchObject({ kind: 'plain', files: 3, accepted: 2, refused: 1 });
    expect(results.filter(r => r.status === 'processing')).toHaveLength(2);
    expect(results).toContainEqual({ skipped: true, reason: 'not_pdf', filename: 'notes.txt' });
    expect(mockStartJob).toHaveBeenCalledTimes(2);

    // The same zip again: both are duplicates now.
    const again = (await upload(cookie, 'scans.zip', zip)).json() as Array<Record<string, any>>;
    expect(again[0].zip).toMatchObject({ kind: 'plain', accepted: 0, duplicates: 2 });
  });

  it('treats a manifest.json that is not an export as an ordinary file, and an empty zip as empty', async () => {
    const odd = await zipOf([{ name: 'manifest.json', data: Buffer.from('{"name":"a web app"}') }, { name: 'x.pdf', data: makePdf(['x']) }]);
    const results = (await upload(cookie, 'app.zip', odd)).json() as Array<Record<string, any>>;
    expect(results[0].zip).toMatchObject({ kind: 'plain' });
    const empty = await zipOf([{ name: '.DS_Store', data: Buffer.from('junk') }]);
    expect((await upload(cookie, 'empty.zip', empty)).json()).toEqual([{ skipped: true, reason: 'zip_empty', filename: 'empty.zip' }]);
  });

  it('does not take a Word document for a folder of files, or a broken zip for anything', async () => {
    const docx = await zipOf([{ name: '[Content_Types].xml', data: Buffer.from('<x/>') }, { name: 'word/document.xml', data: Buffer.from('<x/>') }]);
    expect((await upload(cookie, 'report.docx', docx)).json()).toEqual([{ skipped: true, reason: 'not_pdf', filename: 'report.docx' }]);
    expect((await upload(cookie, 'broken.zip', Buffer.from('PK\u0003\u0004 truncated'))).json()).toEqual([{ skipped: true, reason: 'zip_unreadable', filename: 'broken.zip' }]);
  });
});

describe('document fingerprint', () => {
  it('ignores spacing and case, and says nothing about too little text', () => {
    expect(documentFingerprint(['Hello   World of  medicine and more text here', 'x'])).toBe(documentFingerprint(['hello world of medicine and more text here', ' x ']));
    expect(documentFingerprint(['short'])).toBeNull();
    expect(documentFingerprint([null, null])).toBeNull();
  });
});
