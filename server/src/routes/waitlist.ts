import type { FastifyInstance } from 'fastify';
import { getAccountsStore } from 'spine-core/store/index.js';
import { isPlausibleEmail, normaliseEmail } from '../passwords.js';

const SOURCE = /^[a-z0-9_-]{1,32}$/;

export interface WaitlistRouteOptions {
  perSource?: { max: number; timeWindow: string };
}

/**
 * Asking to be told when Spine opens (the marketing plan's launch list). An address and a time are kept, nothing else; the answer is the
 * same for an address already on the list, so the form tells no one who is on it. It sends no mail itself: the operator writes to the list
 * once, by hand (`npm run cli -- waitlist`), and a person is removed by asking (or with `waitlist-remove`).
 */
export async function waitlistRoutes(app: FastifyInstance, opts: WaitlistRouteOptions = {}) {
  app.post<{ Body: { email?: unknown; source?: unknown } }>('/api/waitlist', { config: { rateLimit: opts.perSource ?? { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { email, source } = req.body ?? {};
    const address = typeof email === 'string' ? normaliseEmail(email) : '';
    if (!isPlausibleEmail(address)) return reply.status(400).send({ error: 'a valid email address is required' });
    const from = typeof source === 'string' && SOURCE.test(source) ? source : null;
    await getAccountsStore().waitlist.add(address, new Date().toISOString(), from);
    return reply.send({ ok: true });
  });
}
