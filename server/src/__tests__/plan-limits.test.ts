import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getStore } from 'spine-core/store/index.js';
import { PLANS } from 'spine-core/billing/plans.js';
import { PlanLimitError, requirePageRoom, usePlanLimits } from 'spine-core/plan-limits.js';
import { buildTestApp, loginSession } from './helpers/app.js';
import { v4 as uuidv4 } from 'uuid';
import { OWNER_ID, seedDocument, seedPage, seedSourceFile } from './helpers/seed.js';

/** The limit on pages kept is held to by the app, which alone can count them: `core/src/plan-limits.ts`, docs/scenarios.md 13.1. */
describe('the limit on pages kept', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let cookie: string;
  const dir = mkdtempSync(path.join(tmpdir(), 'spine-limits-'));

  beforeAll(async () => {
    process.env.DATA_DIR = dir;
    app = await buildTestApp();
    cookie = await loginSession(app);
  });
  afterAll(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  afterEach(() => usePlanLimits({ pages: null }));

  const upload = () => {
    const boundary = '----limit';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      Buffer.from('%PDF-1.4 not a real file'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.inject({ method: 'POST', url: '/api/source-files/upload', headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
  };

  it('is the free plan’s fifty pages, and no other plan has one', () => {
    expect(PLANS.free.keptPages).toBe(50);
    for (const plan of ['trial', 'essential', 'premium', 'family'] as const) expect(PLANS[plan].keptPages, plan).toBeNull();
  });

  it('holds nothing back where there is no limit', async () => {
    await seedDocument();
    await expect(requirePageRoom(OWNER_ID, 1000)).resolves.toBeUndefined();
  });

  it('refuses what would pass the limit, with the plan’s refusal, and only what would', async () => {
    const before = await getStore().pages.count(OWNER_ID);
    usePlanLimits({ pages: before + 2 });
    await expect(requirePageRoom(OWNER_ID, 1)).resolves.toBeUndefined();
    await expect(requirePageRoom(OWNER_ID, 2)).resolves.toBeUndefined();
    const refused = await requirePageRoom(OWNER_ID, 3).catch(e => e);
    expect(refused).toBeInstanceOf(PlanLimitError);
    expect(refused).toMatchObject({ statusCode: 402, code: 'plan_required' });
    expect(refused.message).toMatch(/more pages are not part of the account.s plan/);
    // Taking pages away is never held back.
    await expect(requirePageRoom(OWNER_ID, -3)).resolves.toBeUndefined();
  });

  it('does not count the pages an upload read again replaces against it', async () => {
    const before = await getStore().pages.count(OWNER_ID);
    usePlanLimits({ pages: before });
    await expect(requirePageRoom(OWNER_ID, 1)).rejects.toBeInstanceOf(PlanLimitError);
    await expect(requirePageRoom(OWNER_ID, 3, 3)).resolves.toBeUndefined();
    await expect(requirePageRoom(OWNER_ID, 4, 3)).rejects.toBeInstanceOf(PlanLimitError);
  });

  it('counts the pages a person keeps, hidden ones and those of any document included, not their documents', async () => {
    const before = await getStore().pages.count(OWNER_ID);
    const sourceFileId = await seedSourceFile({ userId: OWNER_ID, status: 'done' });
    for (const pageNumber of [1, 2, 3]) await seedPage(sourceFileId, { userId: OWNER_ID, pageNumber });
    expect(await getStore().pages.count(OWNER_ID)).toBe(before + 3);
    // A document over the pages does not add to what is kept.
    await getStore().documents.create(OWNER_ID, { id: uuidv4(), sourceFileId, pageStart: 1, pageEnd: 3, docType: 'other' });
    expect(await getStore().pages.count(OWNER_ID)).toBe(before + 3);
  });

  it('stops an upload before the file is kept or anything is spent on it', async () => {
    usePlanLimits({ pages: await getStore().pages.count(OWNER_ID) });
    const sources = (await getStore().sourceFiles.listFor(OWNER_ID)).length;
    const res = await upload();
    expect(res.statusCode).toBe(402);
    expect(res.json().message ?? res.json().error).toMatch(/more pages are not part of the account.s plan/);
    expect((await getStore().sourceFiles.listFor(OWNER_ID)).length).toBe(sources);
  });
});
