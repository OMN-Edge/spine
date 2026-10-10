import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
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

function makeMultipartBody(boundary: string, filename: string, content: Buffer) {
  const header = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="files"; filename="${filename}"`,
    `Content-Type: application/pdf`,
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
    const content = Buffer.from('identical content for duplicate test');
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
