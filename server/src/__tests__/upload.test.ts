import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildTestApp, loginSession } from './helpers/app.js';
import { OWNER_ID } from './helpers/seed.js';
import { getStore } from '../store/index.js';

const mockStartJob = vi.hoisted(() => vi.fn());
vi.mock('../ingestion/pipeline.js', () => ({
  startIngestionJob: mockStartJob,
  getJobStatus: vi.fn().mockReturnValue(null),
}));

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
const testDataDir = join(tmpdir(), `spine-test-${Date.now()}`);

beforeAll(async () => {
  mkdirSync(testDataDir, { recursive: true });
  process.env.DATA_DIR = testDataDir;
  app = await buildTestApp();
  cookie = await loginSession(app);
});

afterAll(async () => {
  await app.close();
  rmSync(testDataDir, { recursive: true, force: true });
});

function makeMultipartBody(boundary: string, filename: string, content: Buffer, contentType = 'application/pdf') {
  const header = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="files"; filename="${filename}"`,
    `Content-Type: ${contentType}`,
    '',
    '',
  ].join('\r\n');
  const footer = `\r\n--${boundary}--`;
  return Buffer.concat([Buffer.from(header), content, Buffer.from(footer)]);
}

describe('POST /api/source-files/upload', () => {
  it('accepts a file and queues it for processing', async () => {
    const boundary = 'TestBoundary12345';
    const content = Buffer.from('%PDF-1.4 fake pdf content for testing');
    const body = makeMultipartBody(boundary, 'test.pdf', content);

    const res = await app.inject({
      method: 'POST',
      url: '/api/source-files/upload',
      headers: {
        cookie,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const results = res.json() as any[];
    expect(results).toHaveLength(1);
    expect(results[0].id).toBeDefined();
    expect(results[0].status).toBe('processing');
    expect(mockStartJob).toHaveBeenCalledWith(results[0].id, OWNER_ID);

    // M-9: the original lands under the owner's directory, so a filesystem
    // mistake cannot cross users as easily as a query mistake.
    const stored = await getStore().sourceFiles.findFor(OWNER_ID, results[0].id);
    expect(stored?.file_path).toContain(join('originals', OWNER_ID) + '/');
    expect(existsSync(stored!.file_path)).toBe(true);
  });

  it('skips a duplicate file (same checksum)', async () => {
    const boundary = 'TestBoundary99999';
    const content = Buffer.from('%PDF-1.4 identical content for duplicate test');
    const body = makeMultipartBody(boundary, 'dupe.pdf', content);

    // Upload once
    await app.inject({
      method: 'POST',
      url: '/api/source-files/upload',
      headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    // Upload same content again
    const res = await app.inject({
      method: 'POST',
      url: '/api/source-files/upload',
      headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    const results = res.json() as any[];
    expect(results[0].skipped).toBe(true);
    expect(results[0].reason).toBe('duplicate');
    expect(results[0].existing_id).toBeDefined();
  });

  // Every original the app is holding for this user, whatever year it is filed under.
  const heldFiles = () => {
    const dir = join(testDataDir, 'originals', OWNER_ID);
    return existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).length : 0;
  };
  const upload = (filename: string, content: Buffer, contentType?: string) => {
    const boundary = 'Boundary' + Math.random().toString(36).slice(2);
    return app.inject({
      method: 'POST', url: '/api/source-files/upload',
      headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: makeMultipartBody(boundary, filename, content, contentType),
    });
  };

  it.each([
    ['a Word document', 'report.docx', Buffer.from('PK\u0003\u0004 not a pdf'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['a JPEG photo', 'photo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]), 'image/jpeg'],
    ['a PNG', 'scan.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png'],
    ['plain text', 'notes.txt', Buffer.from('just some notes'), 'text/plain'],
    ['an empty file', 'empty.pdf', Buffer.alloc(0), 'application/pdf'],
    ['a photo named .pdf, claiming to be one', 'looks-like.pdf', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'application/pdf'],
    ['a PDF signature past the first kilobyte', 'late.pdf', Buffer.concat([Buffer.alloc(2000, 0x20), Buffer.from('%PDF-1.4')]), 'application/pdf'],
  ])('refuses %s, keeps nothing, and starts no reading', async (_name, filename, content, contentType) => {
    const before = heldFiles();
    mockStartJob.mockClear();
    const sourceFilesBefore = (await getStore().sourceFiles.listFor(OWNER_ID)).length;

    const res = await upload(filename, content, contentType);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ skipped: true, reason: 'not_pdf', filename }]);
    expect(heldFiles()).toBe(before);                                                 // nothing left on disk
    expect((await getStore().sourceFiles.listFor(OWNER_ID)).length).toBe(sourceFilesBefore); // nothing recorded
    expect(mockStartJob).not.toHaveBeenCalled();
  });

  it('goes by what is in the file, not its name or the type the browser gave', async () => {
    const res = await upload('scan.jpg', Buffer.from('%PDF-1.7 content with a misleading name ' + Math.random()), 'image/jpeg');
    expect((res.json() as Array<{ status?: string }>)[0].status).toBe('processing');
  });

  it('accepts a PDF that has a few bytes before its signature', async () => {
    const res = await upload('odd.pdf', Buffer.concat([Buffer.from('\r\n\r\n'), Buffer.from('%PDF-1.5 body ' + Math.random())]));
    expect((res.json() as Array<{ status?: string }>)[0].status).toBe('processing');
  });

  it('keeps only one copy when the same file is uploaded again', async () => {
    const content = Buffer.from('%PDF-1.4 a file to upload twice ' + Math.random());
    await upload('once.pdf', content);
    const afterFirst = heldFiles();
    const second = await upload('twice.pdf', content);
    expect((second.json() as Array<{ reason?: string }>)[0].reason).toBe('duplicate');
    expect(heldFiles()).toBe(afterFirst);
  });

  it('refuses one file and takes another in the same request', async () => {
    const boundary = 'Mixed' + Math.random().toString(36).slice(2);
    const part = (filename: string, type: string, body: string) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n${body}\r\n`;
    const res = await app.inject({
      method: 'POST', url: '/api/source-files/upload',
      headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: part('notes.txt', 'text/plain', 'words') + part('good.pdf', 'application/pdf', '%PDF-1.4 good ' + Math.random()) + `--${boundary}--\r\n`,
    });
    const results = res.json() as Array<{ reason?: string; status?: string }>;
    expect(results.map(r => r.reason ?? r.status)).toEqual(['not_pdf', 'processing']);
  });

  it('returns 401 without auth', async () => {
    const boundary = 'TestBoundary00000';
    const body = makeMultipartBody(boundary, 'x.pdf', Buffer.from('x'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/source-files/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });
});
