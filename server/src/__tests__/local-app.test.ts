import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { LocalApp } from '../../../web/src/core/local-app.js';
import { buildTestApp, loginSession } from './helpers/app.js';
import { OWNER_ID, seedDocument } from './helpers/seed.js';
import { getStore } from '../store/index.js';
import { decorateAuth } from '../routes/middleware.js';
import { tagRoutes } from '../routes/tags.js';
import { doctorRoutes } from '../routes/doctors.js';
import { trendRoutes } from '../routes/trends.js';
import { episodeRoutes } from '../routes/episodes.js';
import { documentRoutes } from '../routes/documents.js';

/**
 * The route files answer on the device through `LocalApp` (web/src/core/local-app.ts). This holds that to Fastify: the same requests
 * against both, over one store, must give the same status and the same body.
 */
describe('LocalApp answers as Fastify does', () => {
  let fastify: Awaited<ReturnType<typeof buildTestApp>>;
  let cookie: string;
  let local: LocalApp;
  let session: Record<string, unknown>;

  beforeAll(async () => {
    fastify = await buildTestApp();
    cookie = await loginSession(fastify);
    await seedDocument({ tags: ['cardio', 'labs'], provider: 'Clinic A' });
    await seedDocument({ tags: ['labs'], provider: 'Clinic B', docDate: '2026-02-01' });

    // The device's own sign-in: a row in `user_sessions`, which is what `requireAuth` checks.
    const sid = 'local-session';
    await getStore().sessions.open(OWNER_ID, { id: sid, at: new Date().toISOString(), userAgent: '', address: '' });
    const user = (await getStore().users.findById(OWNER_ID))!;
    session = { userId: OWNER_ID, authVersion: user.auth_version, sid, reauthAt: Date.now() };

    local = new LocalApp();
    const app = local as unknown as FastifyInstance;
    decorateAuth(app);
    for (const routes of [tagRoutes, doctorRoutes, trendRoutes, episodeRoutes, documentRoutes]) await routes(app);
  });

  const both = async (method: string, url: string, payload?: unknown, signedIn = true) => {
    const a = await fastify.inject({ method: method as 'GET', url, payload: payload as object | undefined, headers: signedIn ? { cookie } : {} });
    const b = await local.inject({ method, url, payload, session: signedIn ? { ...session } : {} });
    return { a, b };
  };

  const same = async (method: string, url: string, payload?: unknown, signedIn = true) => {
    const { a, b } = await both(method, url, payload, signedIn);
    expect(b.statusCode).toBe(a.statusCode);
    expect(b.json()).toEqual(a.json());
    return b;
  };

  it('lists what Fastify lists', async () => {
    for (const url of ['/api/tags', '/api/providers', '/api/doctors', '/api/episodes', '/api/measurements', '/api/document-types', '/api/documents']) {
      const res = await same('GET', url);
      expect(res.statusCode).toBe(200);
    }
  });

  it('passes path parameters and the query string', async () => {
    const list = (await local.inject({ method: 'GET', url: '/api/documents', session })).json<{ documents?: Array<{ id: string }> } | Array<{ id: string }>>();
    const id = (Array.isArray(list) ? list : list.documents!)[0].id;
    await same('GET', `/api/documents/${id}`);
    await same('GET', '/api/documents?tag=labs');
    await same('GET', '/api/documents/does-not-exist');
  });

  it('refuses when nobody is signed in', async () => {
    const { b } = await both('GET', '/api/tags', undefined, false);
    expect(b.statusCode).toBe(401);
    await same('GET', '/api/tags', undefined, false);
  });

  it('answers an unknown route as Fastify does', async () => {
    await same('GET', '/api/nothing-here');
  });

  it('writes the same, and refuses a bad body the same', async () => {
    await same('POST', '/api/episodes', { title: '' });
    await same('PATCH', '/api/tags/nope', { name: 'x' });
    const made = await local.inject({ method: 'POST', url: '/api/episodes/propose', session: { ...session } });
    expect(made.statusCode).toBe(200);
  });
});
