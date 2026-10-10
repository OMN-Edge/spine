import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, loginSession } from './helpers/app.js';

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;

beforeAll(async () => {
  app = await buildTestApp();
  cookie = await loginSession(app);
});
afterAll(async () => { await app.close(); });

describe('GET /api/tags', () => {
  it('returns the seeded tag list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tags', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const tags = res.json() as any[];
    expect(Array.isArray(tags)).toBe(true);
    const names = tags.map((t: any) => t.name);
    expect(names).toContain('allergy');
    expect(names).toContain('chronic');
    expect(names).toContain('vaccine');
  });

  it('returns 401 without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tags' });
    expect(res.statusCode).toBe(401);
  });
});
