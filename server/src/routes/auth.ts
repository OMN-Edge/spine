import type { FastifyInstance } from 'fastify';
import { getAccountsStore } from 'spine-core/store/index.js';
import {
  MAX_PASSWORD_LENGTH,
  normaliseEmail,
  verifyAgainstDummy,
  verifyPassword,
} from '../passwords.js';
import { authenticate, maySignIn, type SessionData } from '../session-auth.js';
import { windowLimiter } from '../rate-limit.js';
import { startSession } from '../sessions.js';
import { mailAfter, newSignInMail } from '../notify.js';
import { checkSecondFactor, hasSecondFactor } from '../second-factor.js';
import { consentNeeded } from '../legal.js';

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

/** Wrong codes allowed at the second step, per user, whatever address they come from. */
export const SECOND_FACTOR_ATTEMPTS = 5;
/** How long a correct password stays valid while the code is fetched from the phone. */
export const PENDING_LOGIN_MS = 5 * 60 * 1000;

export interface AuthRouteOptions {
  loginRateLimit?: PerSourceRateLimit;
  globalLoginRateLimit?: InstanceWideRateLimit;
  /** Attempts per user per ten minutes at the second step. Tests drive the real limiter. */
  secondFactorAttempts?: number;
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

      const user = await getAccountsStore().users.findByEmail(normaliseEmail(email));

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

      // Right password, but the administrator has not approved the account yet (SPINE_REGISTRATION=approval): no session either.
      if (user.approved === 0) {
        return reply.status(403).send({ error: 'your account is waiting for the administrator to approve it', code: 'awaiting_approval' });
      }

      // A fresh session id on login, so one fixed before login is not carried over.
      await req.session.regenerate();
      const session = req.session as SessionData;

      // The password alone is not enough for a user with a second factor (M-12). This
      // is the only place a session is issued, so it is the only place that checks.
      if (await hasSecondFactor(user.id)) {
        session.pending = {
          userId: user.id,
          authVersion: user.auth_version,
          expiresAt: Date.now() + PENDING_LOGIN_MS,
          failures: 0,
        };
        req.log.info({ ip: req.ip, userId: user.id }, 'password accepted, second factor required');
        return reply.send({ second_factor_required: true });
      }

      const device = await startSession(req, reply, user.id, user.auth_version);
      if (device === 'new') mailAfter(req, user.id, newSignInMail(user.email, new Date().toISOString()), 'new sign-in');

      req.log.info({ ip: req.ip, userId: user.id }, 'login succeeded');
      return reply.send({ ok: true, email: user.email });
    },
  );

  // Six digits is a million possibilities, so guessing is limited three ways: per
  // source, per user whatever the source, and the pending login is dropped after a few
  // wrong tries. The user limit is keyed on the session's pending login, so an
  // unauthenticated caller with no pending login is not counted against anyone.
  const secondFactorLimiters = [
    app.rateLimit(perSource),
    windowLimiter(
      { max: opts.secondFactorAttempts ?? SECOND_FACTOR_ATTEMPTS, windowMs: TEN_MINUTES_MS },
      req => (req.session as SessionData).pending?.userId ?? null,
      'too many attempts, try again later',
    ),
  ];

  app.post<{ Body: { code?: string } }>(
    '/api/auth/login/second-factor',
    { preHandler: secondFactorLimiters },
    async (req, reply) => {
      const session = req.session as SessionData;
      const pending = session.pending;
      const expired = { error: 'sign in again', code: 'login_expired' };

      if (!pending || pending.expiresAt < Date.now()) {
        delete session.pending;
        return reply.status(401).send(expired);
      }

      const { code } = req.body ?? {};
      if (typeof code !== 'string' || !code || code.length > 64) {
        return reply.status(400).send({ error: 'code required' });
      }

      // Re-read the user: a password change or deletion since the password step voids it.
      const user = await getAccountsStore().users.findById(pending.userId);
      if (!user || !maySignIn(user) || user.auth_version !== pending.authVersion) {
        delete session.pending;
        return reply.status(401).send(expired);
      }

      if (!(await checkSecondFactor(user, code))) {
        const failures = pending.failures + 1;
        session.pending = { ...pending, failures };
        req.log.warn({ ip: req.ip, userId: user.id, failures }, 'failed second factor');
        if (failures >= SECOND_FACTOR_ATTEMPTS) {
          delete session.pending;
          return reply.status(401).send(expired);
        }
        return reply.status(401).send({ error: 'incorrect code' });
      }

      await req.session.regenerate();
      const device = await startSession(req, reply, user.id, user.auth_version);
      if (device === 'new') mailAfter(req, user.id, newSignInMail(user.email, new Date().toISOString()), 'new sign-in');

      req.log.info({ ip: req.ip, userId: user.id }, 'login succeeded with second factor');
      return reply.send({ ok: true, email: user.email });
    },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    const { userId, sid } = req.session as SessionData;
    if (userId && sid) await getAccountsStore().sessions.revoke(userId, sid);
    await req.session.destroy();
    return reply.send({ ok: true });
  });

  app.get('/api/auth/me', async (req, reply) => {
    const user = await authenticate(req);
    if (!user) return reply.status(401).send({ error: 'not authenticated' });
    return reply.send({
      authenticated: true,
      email: user.email,
      second_factor_enabled: await hasSecondFactor(user.id),
      // Whether the account has a vault. One that has none is asked to make it before anything else (docs/crypto-design.md).
      vault: (await getAccountsStore().vault.getKeys(user.id)) !== null,
      // What this account still has to agree to before the app shows anything (CR-GDPR-01). Nothing once it has.
      consent_needed: consentNeeded(user),
    });
  });
}

