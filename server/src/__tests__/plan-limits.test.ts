import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getStore } from 'spine-core/store/index.js';
import { PLANS } from 'spine-core/billing/plans.js';
import { PlanLimitError, requireDocumentRoom, usePlanLimits } from 'spine-core/plan-limits.js';
import { buildTestApp, loginSession } from './helpers/app.js';
import { OWNER_ID, seedDocument } from './helpers/seed.js';

/** The limit on documents is held to by the app, which alone can count them: `core/src/plan-limits.ts`, docs/scenarios.md 13.1. */
describe('the limit on documents', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let cookie: string;
  const dir = mkdtempSync(path.join(tmpdir(), 'spine-limits-'));

  beforeAll(async () => {
    process.env.DATA_DIR = dir;
    app = await buildTestApp();
    cookie = await loginSession(app);
  });
  afterAll(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  afterEach(() => usePlanLimits({ documents: null }));

  const upload = () => {
    const boundary = '----limit';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      Buffer.from('%PDF-1.4 not a real file'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.inject({ method: 'POST', url: '/api/source-files/upload', headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
  };

  it('is the free plan’s fifty, and no other plan has one', () => {
    expect(PLANS.free.documents).toBe(50);
    for (const plan of ['trial', 'premium', 'family'] as const) expect(PLANS[plan].documents, plan).toBeNull();
  });

  it('holds nothing back where there is no limit', async () => {
    await seedDocument();
    await expect(requireDocumentRoom(OWNER_ID, 1000)).resolves.toBeUndefined();
  });

  it('refuses what would pass the limit, with the plan’s refusal, and only what would', async () => {
    const before = await getStore().documents.count(OWNER_ID);
    usePlanLimits({ documents: before + 2 });
    await expect(requireDocumentRoom(OWNER_ID, 1)).resolves.toBeUndefined();
    await expect(requireDocumentRoom(OWNER_ID, 2)).resolves.toBeUndefined();
    const refused = await requireDocumentRoom(OWNER_ID, 3).catch(e => e);
    expect(refused).toBeInstanceOf(PlanLimitError);
    expect(refused).toMatchObject({ statusCode: 402, code: 'plan_required' });
    expect(refused.message).toMatch(/another document is not part of the account.s plan/);
    // Taking documents away is never held back.
    await expect(requireDocumentRoom(OWNER_ID, -3)).resolves.toBeUndefined();
  });

  it('counts the documents a person keeps, however they are shown', async () => {
    const before = await getStore().documents.count(OWNER_ID);
    await seedDocument();
    await seedDocument();
    expect(await getStore().documents.count(OWNER_ID)).toBe(before + 2);
  });

  it('stops an upload before the file is kept or anything is spent on it', async () => {
    usePlanLimits({ documents: await getStore().documents.count(OWNER_ID) });
    const sources = (await getStore().sourceFiles.listFor(OWNER_ID)).length;
    const res = await upload();
    expect(res.statusCode).toBe(402);
    expect(res.json().message ?? res.json().error).toMatch(/another document is not part of the account.s plan/);
    expect((await getStore().sourceFiles.listFor(OWNER_ID)).length).toBe(sources);
  });
});
