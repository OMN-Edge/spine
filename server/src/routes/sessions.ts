import type { FastifyInstance } from 'fastify';
import { getAccountsStore } from 'spine-core/store/index.js';
import { verifyPassword, MAX_PASSWORD_LENGTH } from '../passwords.js';
import { checkSecondFactor, hasSecondFactor } from '../second-factor.js';
import { windowLimiter } from '../rate-limit.js';
import { recentlyAuthenticated, requireAuth } from 'spine-core/routes/middleware.js';
import { type SessionData } from '../session-auth.js';
import { endOtherSessions } from '../sessions.js';

const TEN_MINUTES_MS = 10 * 60 * 1000;
const REAUTH_ATTEMPTS = 5;

export interface SessionRouteOptions {
  /** Attempts per user per ten minutes. Tests drive the real limiter. */
  reauthAttempts?: number;
}

/**
 * The owner's sign-ins and asking for the password again (SECURITY.md S-33). Owner only, and a session is only
 * ever read or ended by the user it belongs to: every statement filters by `user_id`.
 */
export async function sessionRoutes(app: FastifyInstance, opts: SessionRouteOptions = {}) {
  app.get('/api/auth/sessions', { preHandler: requireAuth }, async (req, reply) => {
    const current = (req.session as SessionData).sid;
    const rows = await getAccountsStore().sessions.list(req.userId);
    return reply.send(rows.map(row => ({ ...row, current: row.id === current })));
  });

  app.delete<{ Params: { id: string } }>('/api/auth/sessions/:id', { preHandler: requireAuth }, async (req, reply) => {
    const ended = await getAccountsStore().sessions.revoke(req.userId, req.params.id);
    if (!ended) return reply.status(404).send({ error: 'not found' });
    return reply.send({ ok: true });
  });

  app.post('/api/auth/sessions/end-others', { preHandler: requireAuth }, async (req, reply) => {
    const ended = await endOtherSessions(req.userId, req.session as SessionData);
    return reply.send({ ok: true, ended });
  });

  // Whether the password was typed recently enough for the actions that ask (the page asks before it starts a download).
  app.get('/api/auth/reauth', { preHandler: requireAuth }, async (req, reply) => reply.send({ fresh: recentlyAuthenticated(req) }));

  // The password (and a current code, if two-factor is on) typed again: the proof the whole-archive export and a
  // share that shows page images ask for. Guessing is limited per user, so a stolen cookie cannot be used to
  // guess the password here.
  app.post<{ Body: { password?: string; code?: string } }>(
    '/api/auth/reauth',
    {
      preHandler: [
        requireAuth,
        app.rateLimit({ max: 20, timeWindow: '10 minutes' }),
        windowLimiter({ max: opts.reauthAttempts ?? REAUTH_ATTEMPTS, windowMs: TEN_MINUTES_MS }, req => req.userId || null, 'too many attempts, try again later'),
      ],
    },
    async (req, reply) => {
      const { password, code } = req.body ?? {};
      if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD_LENGTH) {
        return reply.status(400).send({ error: 'password required' });
      }
      const user = await getAccountsStore().users.findById(req.userId);
      if (!user || !(await verifyPassword(user.password_hash, password))) {
        req.log.warn({ ip: req.ip, userId: req.userId }, 'wrong password when asked again');
        return reply.status(401).send({ error: 'incorrect password' });
      }
      if (await hasSecondFactor(user.id)) {
        if (typeof code !== 'string' || !code || code.length > 64) {
          return reply.status(401).send({ error: 'a current code is required', code: 'code_required' });
        }
        if (!(await checkSecondFactor(user, code))) return reply.status(401).send({ error: 'incorrect code' });
      }
      (req.session as SessionData).reauthAt = Date.now();
      return reply.send({ ok: true });
    },
  );
}
