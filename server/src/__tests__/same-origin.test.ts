import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, loginAs } from './helpers/app.js';
import { createTestUser } from './helpers/seed.js';

/**
 * SECURITY.md S-50. The session cookie is SameSite strict, but a sibling subdomain (the checkout's, which the docs put at pay.<your domain>)
 * counts as the same site, so a script there could make a request the cookie goes with. A browser says where a request came from, and the
 * server refuses a state-changing one that did not come from the app's own origin.
 */
let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
beforeAll(async () => {
  app = await buildTestApp();
  await createTestUser('origin@spine.test');
  cookie = await loginAs(app, 'origin@spine.test');
});
afterAll(async () => { await app.close(); });

const post = (url: string, headers: Record<string, string>) => app.inject({ method: 'POST', url, headers: { cookie, host: 'spine.example.com', ...headers }, payload: {} });

describe('a request that changes something', () => {
  it('is refused when the browser says it came from a sibling subdomain or another site', async () => {
    for (const site of ['same-site', 'cross-site']) {
      const res = await post('/api/auth/sessions/end-others', { 'sec-fetch-site': site });
      expect(res.statusCode, site).toBe(403);
      expect(res.json()).toMatchObject({ code: 'cross_site' });
    }
  });

  it('is refused when the origin it names is not the app’s, for a browser that sends no fetch metadata', async () => {
    expect((await post('/api/auth/sessions/end-others', { origin: 'https://pay.example.com' })).statusCode).toBe(403);
    expect((await post('/api/auth/sessions/end-others', { origin: 'null' })).statusCode).toBe(403);
  });

  it('goes through from the app itself, and from a client that is not a browser', async () => {
    expect((await post('/api/auth/sessions/end-others', { 'sec-fetch-site': 'same-origin', origin: 'https://spine.example.com' })).statusCode).toBe(200);
    expect((await post('/api/auth/sessions/end-others', { 'sec-fetch-site': 'none' })).statusCode).toBe(200);
    expect((await post('/api/auth/sessions/end-others', {})).statusCode).toBe(200);
  });

  it('is not asked of a read, or of the provider’s notification, which no browser sends', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie, 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(200);
    const hook = await app.inject({ method: 'POST', url: '/api/billing/webhook', headers: { 'sec-fetch-site': 'cross-site' }, payload: {} });
    expect(hook.json()).not.toMatchObject({ code: 'cross_site' });
  });
});
