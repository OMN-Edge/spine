import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildTestApp, loginAs, loginSession } from './helpers/app.js';
import { createTestUser, OWNER_ID } from './helpers/seed.js';
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
    ['a GIF', 'anim.gif', Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00]), 'image/gif'],
    ['an empty file', 'empty.pdf', Buffer.alloc(0), 'application/pdf'],
    ['a two-byte stub of a JPEG', 'stub.jpg', Buffer.from([0xff, 0xd8]), 'image/jpeg'],
    ['a PDF signature past the first kilobyte', 'late.pdf', Buffer.concat([Buffer.alloc(2000, 0x20), Buffer.from('%PDF-1.4'), Buffer.from([0, 1, 2])]), 'application/pdf'],
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

  describe('photos', () => {
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]);
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const unique = (b: Buffer) => Buffer.concat([b, Buffer.from(String(Math.random()))]);

    it.each([['a JPEG', 'photo.jpg', JPEG, 'image/jpeg'], ['a PNG', 'scan.png', PNG, 'image/png'], ['a JPEG named .pdf', 'sneaky.pdf', JPEG, 'application/pdf']])(
      'refuses %s while image reading is off, saying why, and keeps nothing', async (_n, filename, content, type) => {
        vi.stubEnv('SPINE_MULTIMODAL_ENABLED', 'false');
        const before = heldFiles();
        mockStartJob.mockClear();
        const res = await upload(filename, unique(content), type);
        expect(res.json()).toEqual([{ skipped: true, reason: 'photo_needs_ai', filename }]);
        expect(heldFiles()).toBe(before);
        expect(mockStartJob).not.toHaveBeenCalled();
        vi.unstubAllEnvs();
      });

    it.each([['a JPEG', 'photo.jpg', JPEG, 'image/jpeg', 'image/jpeg'], ['a PNG', 'scan.png', PNG, 'image/png', 'image/png'], ['a JPEG named .pdf', 'x.pdf', JPEG, 'application/pdf', 'image/jpeg']])(
      'takes %s when image reading is on, and records what it is, not what it was called', async (_n, filename, content, claimed, actual) => {
        vi.stubEnv('SPINE_MULTIMODAL_ENABLED', 'true');
        mockStartJob.mockClear();
        const res = await upload(filename, unique(content), claimed);
        const [result] = res.json() as Array<{ id: string; status: string }>;
        expect(result.status).toBe('processing');
        expect(mockStartJob).toHaveBeenCalledWith(result.id, OWNER_ID);
        expect((await getStore().sourceFiles.findFor(OWNER_ID, result.id))!.mime_type).toBe(actual);
        vi.unstubAllEnvs();
      });

    it('records a PDF as a PDF whatever the browser called it', async () => {
      const res = await upload('scan.jpg', Buffer.from('%PDF-1.7 ' + Math.random()), 'image/jpeg');
      const [result] = res.json() as Array<{ id: string }>;
      expect((await getStore().sourceFiles.findFor(OWNER_ID, result.id))!.mime_type).toBe('application/pdf');
    });

    it('keeps one copy of the same photo uploaded twice', async () => {
      vi.stubEnv('SPINE_MULTIMODAL_ENABLED', 'true');
      const photo = unique(JPEG);
      await upload('p.jpg', photo, 'image/jpeg');
      const held = heldFiles();
      expect(((await upload('again.jpg', photo, 'image/jpeg')).json() as Array<{ reason?: string }>)[0].reason).toBe('duplicate');
      expect(heldFiles()).toBe(held);
      vi.unstubAllEnvs();
    });
  });

  it('makes a text file a PDF with its words as text, and keeps that as the original', async () => {
    mockStartJob.mockClear();
    const res = await upload('notes.txt', Buffer.from('Control în 3 luni, fără alergii cunoscute. ' + Math.random()), 'text/plain');
    const [result] = res.json() as Array<{ id: string; status: string }>;
    expect(result.status).toBe('processing');
    expect(mockStartJob).toHaveBeenCalledWith(result.id, OWNER_ID);
    expect(await getStore().sourceFiles.findFor(OWNER_ID, result.id)).toMatchObject({ mime_type: 'application/pdf', original_filename: 'notes.txt' });
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
      payload: part('notes.bin', 'application/octet-stream', '\u0000\u0001words') + part('good.pdf', 'application/pdf', '%PDF-1.4 good ' + Math.random()) + `--${boundary}--\r\n`,
    });
    const results = res.json() as Array<{ reason?: string; status?: string }>;
    expect(results.map(r => r.reason ?? r.status)).toEqual(['not_pdf', 'processing']);
  });

  describe('uploading a file whose earlier attempt failed', () => {
    const pdf = () => Buffer.from('%PDF-1.4 a file that failed once ' + Math.random());
    async function failed() {
      const content = pdf();
      const first = (await upload('flaky.pdf', content)).json() as Array<{ id: string }>;
      await getStore().sourceFiles.setStatus(OWNER_ID, first[0].id, 'error', 'provider unavailable');
      mockStartJob.mockClear();
      return { content, id: first[0].id };
    }

    it('is a retry of that upload, not a duplicate of it: no second record and no second copy', async () => {
      const { content, id } = await failed();
      const files = heldFiles(); const records = (await getStore().sourceFiles.listFor(OWNER_ID)).length;

      const res = await upload('again.pdf', content);
      expect(res.json()).toEqual([{ id, status: 'processing', retried: true }]);
      expect(mockStartJob).toHaveBeenCalledWith(id, OWNER_ID, { retry: true });
      expect(heldFiles()).toBe(files);
      expect((await getStore().sourceFiles.listFor(OWNER_ID)).length).toBe(records);
    });

    it.each(['done', 'processing', 'pending'] as const)('is still a duplicate while the earlier upload is %s', async status => {
      const content = pdf();
      const first = (await upload('x.pdf', content)).json() as Array<{ id: string }>;
      if (status !== 'pending') await getStore().sourceFiles.setStatus(OWNER_ID, first[0].id, status);
      mockStartJob.mockClear();
      const res = (await upload('y.pdf', content)).json() as Array<{ reason?: string; existing_id?: string }>;
      expect(res[0]).toMatchObject({ reason: 'duplicate', existing_id: first[0].id });
      expect(mockStartJob).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/source-files/:id/retry', () => {
    const post = (id: string, c = cookie) => app.inject({ method: 'POST', url: `/api/source-files/${id}/retry`, headers: { cookie: c } });
    async function upl(status: 'error' | 'done' | 'processing' | 'pending') {
      const res = (await upload('r.pdf', Buffer.from('%PDF-1.4 retry route ' + Math.random()))).json() as Array<{ id: string }>;
      if (status !== 'pending') await getStore().sourceFiles.setStatus(OWNER_ID, res[0].id, status, status === 'error' ? 'boom' : undefined);
      mockStartJob.mockClear();
      return res[0].id;
    }

    it('runs a failed upload again and answers 202', async () => {
      const id = await upl('error');
      const res = await post(id);
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ id, status: 'processing' });
      expect(mockStartJob).toHaveBeenCalledWith(id, OWNER_ID, { retry: true });
    });

    it.each(['done', 'processing', 'pending'] as const)('refuses an upload that is %s: nothing failed', async status => {
      const id = await upl(status);
      const res = await post(id);
      expect(res.statusCode).toBe(409);
      expect(mockStartJob).not.toHaveBeenCalled();
    });

    it('answers not found for an upload that does not exist, or is another user’s, and starts nothing', async () => {
      const other = await createTestUser(`retry-${Math.random().toString(36).slice(2)}@spine.test`);
      const id = await upl('error');
      const theirs = await loginAs(app, other.email);
      expect((await post(id, theirs)).statusCode).toBe(404);
      expect((await post('no-such-upload')).statusCode).toBe(404);
      expect(mockStartJob).not.toHaveBeenCalled();
    });

    it('needs a session', async () => {
      const id = await upl('error');
      expect((await app.inject({ method: 'POST', url: `/api/source-files/${id}/retry` })).statusCode).toBe(401);
    });
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
