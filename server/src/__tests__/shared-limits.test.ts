import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getAccountsStore } from 'spine-core/store/index.js';
import { windowLimiter } from '../rate-limit.js';
import { limitsWhere, SharedRateLimitStore } from '../limits.js';
import { buildTestApp } from './helpers/app.js';

/**
 * With more than one instance a limit that is counted in each would be N times weaker. With SPINE_LIMITS=store the count is in the accounts database,
 * so what the instances allow together is what one did. Two limiters built the way two instances build them stand for two instances here.
 */
const req = (key: string) => ({ key, ip: '10.0.0.1', log: { warn: () => undefined, error: () => undefined } }) as unknown as FastifyRequest;
const reply = () => { const r = { code: 0, status(c: number) { r.code = c; return r; }, send() { return r; } }; return r as unknown as FastifyReply & { code: number }; };
const limiter = (max: number, name: string, windowMs = 60_000) => windowLimiter({ max, windowMs }, r => (r as unknown as { key: string }).key, 'too many', name);
const codes = async (enforce: ReturnType<typeof limiter>, key: string, n: number) => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) { const r = reply(); await enforce(req(key), r); out.push(r.code); }
  return out;
};

describe('limits that are counted in the database (SPINE_LIMITS=store)', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const before = process.env.SPINE_LIMITS;
  beforeAll(async () => { app = await buildTestApp(); process.env.SPINE_LIMITS = 'store'; });
  afterAll(async () => { if (before === undefined) delete process.env.SPINE_LIMITS; else process.env.SPINE_LIMITS = before; await app.close(); });

  it('is memory unless asked, and a word that is neither is refused', () => {
    expect(limitsWhere({})).toBe('memory');
    expect(limitsWhere({ SPINE_LIMITS: 'store' })).toBe('store');
    expect(() => limitsWhere({ SPINE_LIMITS: 'redis' })).toThrow(/SPINE_LIMITS/);
  });

  it('count one window for every instance, so two instances allow what one did', async () => {
    const first = limiter(3, 'shared-a');
    const second = limiter(3, 'shared-a');
    expect(await codes(first, 'source', 2)).toEqual([0, 0]);
    expect(await codes(second, 'source', 2)).toEqual([0, 429]); // the third request of the window, whichever instance it reaches
    expect(await codes(first, 'source', 1)).toEqual([429]);
  });

  it('keep a limiter, and a source, apart from the others', async () => {
    expect(await codes(limiter(1, 'shared-b'), 'x', 2)).toEqual([0, 429]);
    expect(await codes(limiter(1, 'shared-c'), 'x', 1)).toEqual([0]); // another limiter, the same source
    expect(await codes(limiter(1, 'shared-b'), 'y', 1)).toEqual([0]); // the same limiter, another source
  });

  it('start a new window when the last has ended', async () => {
    const store = getAccountsStore().maintenance;
    expect(await store.hitWindow('shared-d', 'k', 1000, 5000)).toBe(1);
    expect(await store.hitWindow('shared-d', 'k', 1000, 5500)).toBe(2);
    expect(await store.hitWindow('shared-d', 'k', 1000, 6000)).toBe(1);
    expect(await store.pruneWindows(7000)).toBeGreaterThanOrEqual(1);
    expect(await store.hitWindow('shared-d', 'k', 1000, 7100)).toBe(1);
  });

  it('count a key no client can make too long to count, so a long one is no way past a limit', async () => {
    const huge = 'x'.repeat(1_000_000);
    const enforce = limiter(1, 'shared-long');
    expect(await codes(enforce, huge, 3)).toEqual([0, 429, 429]);
  });

  it('are counted at once without losing a request to another', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => getAccountsStore().maintenance.hitWindow('shared-e', 'k', 60_000, Date.now())));
    expect([...results].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('are what the plugin’s per-address limits count in too, across instances', async () => {
    const build = async () => {
      const server = Fastify({ logger: false });
      await server.register(fastifyRateLimit, { global: false, store: SharedRateLimitStore as never });
      server.get('/limited', { preHandler: server.rateLimit({ max: 3, timeWindow: 60_000 }) }, async () => 'ok');
      server.get('/other', { config: { rateLimit: { max: 1, timeWindow: 60_000 } } }, async () => 'ok');
      return server;
    };
    const a = await build();
    const b = await build();
    const statuses = [];
    for (const server of [a, b, a, b]) statuses.push((await server.inject({ url: '/limited', remoteAddress: '198.51.100.9' })).statusCode);
    expect(statuses).toEqual([200, 200, 200, 429]);
    // another route is another limit, and another address another count
    expect((await b.inject({ url: '/other', remoteAddress: '198.51.100.9' })).statusCode).toBe(200);
    expect((await a.inject({ url: '/other', remoteAddress: '198.51.100.9' })).statusCode).toBe(429);
    expect((await a.inject({ url: '/limited', remoteAddress: '198.51.100.10' })).statusCode).toBe(200);
  });
});
