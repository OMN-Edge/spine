import type { FastifyInstance } from 'fastify';
import { getStore } from '../store/index.js';
import {
  checkPasswordPolicy,
  hashPassword,
  MAX_PASSWORD_LENGTH,
  normaliseEmail,
  verifyAgainstDummy,
  verifyPassword,
} from '../passwords.js';
import { authenticate, requireAuth, type SessionData } from './middleware.js';
import { windowLimiter } from '../rate-limit.js';

/**
 * SECURITY.md P5: every unauthenticated endpoint is rate limited. Login carries
 * two independent limits:
 *
 *  - per source address, which stops a single host hammering it;
 *  - instance-wide, so a distributed attempt still throttles.
 *
 * Only the first is `@fastify/rate-limit`. The plugin marks a request with a
 * per-request symbol and returns early for any further limiter on the same
 * request, so two of its hooks cannot both apply. The instance-wide cap is a few
 * lines of our own, running after it.
 *
 * Both are overridable so tests drive the real hooks rather than a mock (P10).
 */
export interface PerSourceRateLimit {
  max: number;
  timeWindow: string | number;
}

export interface InstanceWideRateLimit {
  max: number;
  windowMs: number;
}

const TEN_MINUTES_MS = 10 * 60 * 1000;

export const DEFAULT_LOGIN_RATE_LIMIT: PerSourceRateLimit = {
  max: 10,
  timeWindow: '10 minutes',
};
export const DEFAULT_GLOBAL_LOGIN_RATE_LIMIT: InstanceWideRateLimit = {
  max: 50,
  windowMs: TEN_MINUTES_MS,
};

export interface AuthRouteOptions {
  loginRateLimit?: PerSourceRateLimit;
  globalLoginRateLimit?: InstanceWideRateLimit;
}

export async function authRoutes(app: FastifyInstance, opts: AuthRouteOptions = {}) {
  const perSource = { ...DEFAULT_LOGIN_RATE_LIMIT, ...opts.loginRateLimit };
  const instanceWide = { ...DEFAULT_GLOBAL_LOGIN_RATE_LIMIT, ...opts.globalLoginRateLimit };

  // Per source first: an address that has spent its own budget then stops
  // consuming the instance-wide one, which otherwise let one host lock everyone
  // out for the window while being refused anyway.
  const loginLimiters = [
    app.rateLimit(perSource),
    windowLimiter(
      instanceWide,
      () => 'instance',
      'too many login attempts, try again later',
    ),
  ];

  app.post<{ Body: { email?: string; password?: string } }>(
    '/api/auth/login',
    { preHandler: loginLimiters },
    async (req, reply) => {
      const { email, password } = req.body ?? {};
      if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
        return reply.status(400).send({ error: 'email and password required' });
      }

      // Argon2 hashes whatever it is given, so an unbounded password is a cheap way
      // to burn CPU. Nothing this long can be a real one (see the policy on set).
      if (password.length > MAX_PASSWORD_LENGTH) {
        return reply.status(401).send({ error: 'incorrect email or password' });
      }

      const user = await getStore().users.findByEmail(normaliseEmail(email));

      // An unknown email and a wrong password take the same time and give the
      // same answer, so the endpoint cannot be used to list accounts.
      const valid = user
        ? await verifyPassword(user.password_hash, password)
        : await verifyAgainstDummy(password);

      if (!user || !valid) {
        // Never log the submitted password, or the email it was tried against.
        req.log.warn({ ip: req.ip, userAgent: req.headers['user-agent'] }, 'failed login');
        return reply.status(401).send({ error: 'incorrect email or password' });
      }

      // Right password, address not confirmed yet: no session, and the page can offer
      // to send the link again. Only someone holding the password learns this.
      if (!user.email_verified_at) {
        return reply.status(403).send({ error: 'confirm your email address first', code: 'email_not_verified' });
      }

      // A fresh session id on login, so one fixed before login is not carried over.
      await req.session.regenerate();
      const session = req.session as SessionData;
      session.userId = user.id;
      session.authVersion = user.auth_version;

      req.log.info({ ip: req.ip, userId: user.id }, 'login succeeded');
      return reply.send({ ok: true, email: user.email });
    },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    await req.session.destroy();
    return reply.send({ ok: true });
  });

  app.get('/api/auth/me', async (req, reply) => {
    const user = await authenticate(req);
    if (!user) return reply.status(401).send({ error: 'not authenticated' });
    return reply.send({ authenticated: true, email: user.email });
  });

  // P13: changing the password ends the user's other sessions. Their sessions
  // carry the old auth_version and are refused on the next request; this one is
  // moved to the new value so it stays signed in.
  app.post<{ Body: { current?: string; next?: string } }>(
    '/api/auth/password',
    { preHandler: [requireAuth, app.rateLimit(perSource)] },
    async (req, reply) => {
      const { current, next } = req.body ?? {};
      if (typeof current !== 'string' || typeof next !== 'string') {
        return reply.status(400).send({ error: 'current and next password required' });
      }

      const problem = checkPasswordPolicy(next);
      if (problem) return reply.status(400).send({ error: problem });

      const store = getStore();
      const user = await store.users.findById(req.userId);
      if (!user || !(await verifyPassword(user.password_hash, current))) {
        req.log.warn({ ip: req.ip, userId: req.userId }, 'password change with wrong current password');
        return reply.status(401).send({ error: 'current password is incorrect' });
      }

      const authVersion = await store.users.setPassword(user.id, await hashPassword(next));
      (req.session as SessionData).authVersion = authVersion;

      req.log.info({ userId: user.id }, 'password changed');
      return reply.send({ ok: true });
    },
  );
}
