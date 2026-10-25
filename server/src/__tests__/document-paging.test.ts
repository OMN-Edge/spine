import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { buildTestApp, loginSession } from './helpers/app.js';
import { seedSourceFile, OWNER_ID } from './helpers/seed.js';
import { getStore } from 'spine-core/store/index.js';

/**
 * The document list is paged. A client that wants the whole archive has to page through
 * it, and a bad limit must not break the request or let one request ask for everything.
 */
let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
const TOTAL = 520;

beforeAll(async () => {
  app = await buildTestApp();
  cookie = await loginSession(app);
  const store = getStore();
  const sf = await seedSourceFile({ status: 'done' });
  await store.transaction(async tx => {
    for (let i = 1; i <= TOTAL; i++) {
      await tx.documents.create(OWNER_ID, { id: uuidv4(), sourceFileId: sf, pageStart: i, pageEnd: i, title: `Doc ${i}` });
    }
  });
});
afterAll(async () => { await app.close(); });

const count = async (query: string) =>
  ((await app.inject({ method: 'GET', url: `/api/documents${query}`, headers: { cookie } })).json() as unknown[]).length;

describe('GET /api/documents paging', () => {
  it('returns 50 by default', async () => {
    expect(await count('')).toBe(50);
  });

  it('honours a limit and an offset', async () => {
    expect(await count('?limit=7')).toBe(7);
    expect(await count(`?limit=100&offset=${TOTAL - 30}`)).toBe(30);
  });

  it('caps a limit at 500, so one request cannot ask for the whole archive', async () => {
    expect(await count('?limit=100000')).toBe(500);
  });

  it('falls back to the default for a limit or offset that is not a usable number', async () => {
    for (const q of ['?limit=abc', '?limit=0', '?limit=-5', '?limit=', '?limit=1e9x']) {
      expect(await count(q), q).toBe(q === '?limit=1e9x' ? 1 : 50);
    }
    // A bad offset is treated as the start, not as an error.
    const res = await app.inject({ method: 'GET', url: '/api/documents?offset=abc', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as unknown[]).length).toBe(50);
  });

  it('pages through every document exactly once', async () => {
    const seen: string[] = [];
    for (let offset = 0; ; offset += 200) {
      const chunk = (await app.inject({ method: 'GET', url: `/api/documents?limit=200&offset=${offset}`, headers: { cookie } })).json() as Array<{ id: string }>;
      seen.push(...chunk.map(d => d.id));
      if (chunk.length < 200) break;
    }
    expect(seen).toHaveLength(TOTAL);
    expect(new Set(seen).size).toBe(TOTAL);
  });
});
