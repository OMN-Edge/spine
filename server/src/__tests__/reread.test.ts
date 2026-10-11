import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { buildTestApp, loginAs } from './helpers/app.js';
import { OWNER_ID, createTestUser, seedSourceFile } from './helpers/seed.js';

const mockStartJob = vi.hoisted(() => vi.fn());
const mockGetJobStatus = vi.hoisted(() => vi.fn().mockReturnValue(null));
vi.mock('../ingestion/pipeline.js', () => ({
  startIngestionJob: mockStartJob,
  getJobStatus: mockGetJobStatus,
  reconcileStalledJobs: vi.fn().mockResolvedValue(0),
}));

/**
 * The "Read with AI" endpoint. It sends page images to the model provider, so it needs
 * the operator's switch as well as the user's click, and it must only ever act on the
 * caller's own uploads.
 */

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
const saved = process.env.SPINE_MULTIMODAL_ENABLED;

beforeAll(async () => {
  app = await buildTestApp();
  cookie = await loginAs(app);
});
afterAll(async () => { await app.close(); });

beforeEach(() => { mockStartJob.mockClear(); mockGetJobStatus.mockReturnValue(null); });
afterEach(() => {
  if (saved === undefined) delete process.env.SPINE_MULTIMODAL_ENABLED;
  else process.env.SPINE_MULTIMODAL_ENABLED = saved;
});

const reread = (id: string, c = cookie) =>
  app.inject({ method: 'POST', url: `/api/source-files/${id}/reread`, headers: { cookie: c } });

describe('GET /api/capabilities', () => {
  it('says AI reading is off unless the operator allowed it', async () => {
    delete process.env.SPINE_MULTIMODAL_ENABLED;
    const res = await app.inject({ method: 'GET', url: '/api/capabilities', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ aiReading: { enabled: false } });
  });

  it('says where the images would go when it is on', async () => {
    process.env.SPINE_MULTIMODAL_ENABLED = 'true';
    const body = (await app.inject({ method: 'GET', url: '/api/capabilities', headers: { cookie } })).json();
    expect(body.aiReading).toMatchObject({ enabled: true, provider: 'anthropic', endpoint: 'api.anthropic.com' });
  });

  it('needs a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/capabilities' })).statusCode).toBe(401);
  });
});

describe('POST /api/source-files/:id/reread', () => {
  it('is refused, and starts nothing, when the operator has not allowed AI reading', async () => {
    delete process.env.SPINE_MULTIMODAL_ENABLED;
    const id = await seedSourceFile({ status: 'done' });

    const res = await reread(id);

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/not enabled/);
    expect(mockStartJob).not.toHaveBeenCalled();
  });

  it('starts a re-read of the caller’s own finished upload', async () => {
    process.env.SPINE_MULTIMODAL_ENABLED = 'true';
    const id = await seedSourceFile({ status: 'done' });

    const res = await reread(id);

    expect(res.statusCode).toBe(202);
    expect(mockStartJob).toHaveBeenCalledWith(id, OWNER_ID, { reread: true });
  });

  it('can redo an upload that ended in an error', async () => {
    process.env.SPINE_MULTIMODAL_ENABLED = 'true';
    const id = await seedSourceFile({ status: 'error' });
    expect((await reread(id)).statusCode).toBe(202);
  });

  it('will not start while the file is still being processed', async () => {
    process.env.SPINE_MULTIMODAL_ENABLED = 'true';
    const processing = await seedSourceFile({ status: 'processing' });
    const pending = await seedSourceFile({ status: 'pending' });
    const running = await seedSourceFile({ status: 'done' });
    mockGetJobStatus.mockImplementation((id: string) => (id === running ? { status: 'processing' } : null));

    for (const id of [processing, pending, running]) expect((await reread(id)).statusCode).toBe(409);
    expect(mockStartJob).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown upload', async () => {
    process.env.SPINE_MULTIMODAL_ENABLED = 'true';
    expect((await reread('does-not-exist')).statusCode).toBe(404);
  });

  it('answers 404, and starts nothing, for another user’s upload', async () => {
    process.env.SPINE_MULTIMODAL_ENABLED = 'true';
    const other = await createTestUser('someone-else@spine.test');
    const theirs = await seedSourceFile({ userId: other.id, status: 'done' });

    const res = await reread(theirs);

    expect(res.statusCode).toBe(404);
    expect(mockStartJob).not.toHaveBeenCalled();
  });

  it('needs a session', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/source-files/x/reread' });
    expect(res.statusCode).toBe(401);
  });
});
