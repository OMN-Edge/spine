import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { buildTestApp, loginSession } from './helpers/app.js';
import { seedSourceFile, OWNER_ID } from './helpers/seed.js';
import { getStore } from '../store/index.js';
import { v4 as uuidv4 } from 'uuid';

const mockStartJob = vi.hoisted(() => vi.fn());
vi.mock('../ingestion/pipeline.js', () => ({
  startIngestionJob: mockStartJob,
  getJobStatus: vi.fn().mockReturnValue(null),
}));

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;

beforeAll(async () => {
  app = await buildTestApp();
  cookie = await loginSession(app);
});
afterAll(async () => { await app.close(); });

describe('GET /api/source-files', () => {
  it('returns list of uploaded files', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/source-files', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('returns 401 without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/source-files' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/source-files/:id/status', () => {
  it('returns status for an existing file', async () => {
    const id = await seedSourceFile({ status: 'done' });

    const res = await app.inject({ method: 'GET', url: `/api/source-files/${id}/status`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.status).toBe('done');
    expect(body.progress).toBe(100);
  });

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/source-files/nonexistent/status', headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });

  it('returns in-progress state from job registry', async () => {
    const { getJobStatus } = await import('../ingestion/pipeline.js');
    vi.mocked(getJobStatus).mockReturnValueOnce({
      source_file_id: 'x',
      status: 'processing',
      progress: 42,
      step: 'parsing',
    });

    const id = await seedSourceFile({ status: 'processing' });

    const res = await app.inject({ method: 'GET', url: `/api/source-files/${id}/status`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.progress).toBe(42);
    expect(body.step).toBe('parsing');
  });
});

describe('POST /api/source-files/upload — duplicate detection', () => {
  it('duplicate-check query returns the existing row when checksum matches', async () => {
    const checksum = uuidv4(); // unique per run — no collision risk
    const existingId = await seedSourceFile({ status: 'done', checksum });

    // The same lookup the upload route uses to reject a duplicate.
    const found = await getStore().sourceFiles.findByChecksumFor(OWNER_ID, checksum);
    expect(found?.id).toBe(existingId);
  });
});
