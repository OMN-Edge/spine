import type { FastifyInstance } from 'fastify';
import { getAccountsStore } from 'spine-core/store/index.js';
import { isPlausibleEmail, normaliseEmail } from '../passwords.js';
import { windowLimiter } from '../rate-limit.js';

const SOURCE = /^[a-z0-9_-]{1,32}$/;

export interface WaitlistRouteOptions {
  perSource?: { max: number; timeWindow: string };
  /** Addresses the list may hold (default `SPINE_WAITLIST_MAX` or 20,000), and additions an hour from all sources together (default 200) (SECURITY.md S-52). */
  max?: number;
  perHour?: number;
}

/**
 * Asking to be told when Spine opens (the marketing plan's launch list). An address and a time are kept, nothing else; the answer is the
 * same for an address already on the list, so the form tells no one who is on it. It sends no mail itself: the operator writes to the list
 * once, by hand (`npm run cli -- waitlist`), and a person is removed by asking (or with `waitlist-remove`).
 */
export async function waitlistRoutes(app: FastifyInstance, opts: WaitlistRouteOptions = {}) {
  const whole = (raw: string | undefined, fallback: number) => (Number.isInteger(Number(raw)) && Number(raw) > 0 && (raw ?? '').trim() !== '' ? Number(raw) : fallback);
  const inAll = windowLimiter({ max: opts.perHour ?? 200, windowMs: 60 * 60 * 1000 }, () => 'instance', 'too many requests just now, try again later');
  app.post<{ Body: { email?: unknown; source?: unknown } }>('/api/waitlist', { config: { rateLimit: opts.perSource ?? { max: 5, timeWindow: '1 minute' } }, preHandler: inAll }, async (req, reply) => {
    const { email, source } = req.body ?? {};
    const address = typeof email === 'string' ? normaliseEmail(email) : '';
    if (!isPlausibleEmail(address)) return reply.status(400).send({ error: 'a valid email address is required' });
    const from = typeof source === 'string' && SOURCE.test(source) ? source : null;
    const store = getAccountsStore();
    // The one public route that writes, so it has a ceiling: anyone can add any address, and the table must not grow without end (S-52).
    if ((await store.waitlist.count()) >= (opts.max ?? whole(process.env.SPINE_WAITLIST_MAX, 20_000)) && !(await store.waitlist.list()).some(w => w.email === address)) {
      return reply.status(503).send({ error: 'the list is full just now', code: 'full' });
    }
    await store.waitlist.add(address, new Date().toISOString(), from);
    return reply.send({ ok: true });
  });
}
