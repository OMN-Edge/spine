import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { buildTestApp, loginAs } from './helpers/app.js';

/**
 * What the pages need to know before offering anything that sends a page image to the model:
 * whether the operator allowed it at all, and where the images would go.
 */

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
const saved = process.env.SPINE_MULTIMODAL_ENABLED;

beforeAll(async () => {
  app = await buildTestApp();
  cookie = await loginAs(app);
});
afterAll(async () => { await app.close(); });
afterEach(() => {
  if (saved === undefined) delete process.env.SPINE_MULTIMODAL_ENABLED;
  else process.env.SPINE_MULTIMODAL_ENABLED = saved;
});

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

  it('says how an upload is read here, so the page can say what reading a whole document does', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/capabilities', headers: { cookie } });
    expect(res.json().reading).toMatchObject({ mode: 'text', ocr: true, images: false });
  });

  it('needs a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/capabilities' })).statusCode).toBe(401);
  });
});
