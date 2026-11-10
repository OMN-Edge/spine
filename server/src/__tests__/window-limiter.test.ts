import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { windowLimiter } from '../rate-limit.js';

/** SECURITY.md S-53: the limiter that keys on an address or a user dropped expired keys by walking the whole map on every request. */
const req = (key: string) => ({ key, ip: '10.0.0.1', log: { warn: () => undefined } }) as unknown as FastifyRequest & { key: string };
const reply = () => { const r = { code: 0, status(c: number) { r.code = c; return r; }, send() { return r; } }; return r as unknown as FastifyReply & { code: number }; };
const limiter = (max: number, windowMs: number) => windowLimiter({ max, windowMs }, r => (r as unknown as { key: string }).key);

afterEach(() => vi.useRealTimers());

describe('the per-key window limiter', () => {
  it('allows up to the maximum in a window, refuses the next, and starts again when the window has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const enforce = limiter(2, 60_000);
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) { const r = reply(); await enforce(req('a'), r); codes.push(r.code); }
    expect(codes).toEqual([0, 0, 429]);
    vi.setSystemTime(1_000_000 + 60_000);
    const r = reply();
    await enforce(req('a'), r);
    expect(r.code).toBe(0);
  });

  it('does not let keys that have not expired go, and lets the ones that have', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const enforce = limiter(1, 60_000);
    await enforce(req('old'), reply());
    vi.setSystemTime(1_030_000);
    await enforce(req('newer'), reply());
    vi.setSystemTime(1_061_000); // old's window is over, newer's is not
    const [a, b] = [reply(), reply()];
    await enforce(req('old'), a);
    await enforce(req('newer'), b);
    expect([a.code, b.code]).toEqual([0, 429]);
  });

  it('does not make a request slow however many keys are in the window', async () => {
    const enforce = limiter(1000, 3_600_000);
    for (let i = 0; i < 120_000; i++) await enforce(req(`address-${i}`), reply());
    const started = performance.now();
    for (let i = 0; i < 2000; i++) await enforce(req(`address-${i % 100}`), reply());
    // A walk of every key on each of these would be a hundred million steps or more.
    expect(performance.now() - started).toBeLessThan(500);
  }, 60_000);
});
