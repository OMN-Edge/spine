import { endOtherSessions } from '../sessions.js';
import { mailAfter, securityChangeMail } from '../notify.js';
import type { FastifyInstance } from 'fastify';
import { getStore } from '../store/index.js';
import { verifyPassword } from '../passwords.js';
import { requireAuth, type SessionData } from './middleware.js';
import { windowLimiter } from '../rate-limit.js';
import { checkSecondFactor, newRecoveryCodes } from '../second-factor.js';
import {
  base32Encode,
  decryptSecret,
  encryptSecret,
  generateSecret,
  matchTotp,
  otpauthUri,
} from '../totp.js';

/**
 * Managing the second factor (SECURITY.md M-12). Every route needs a session, and the
 * ones that weaken or replace the factor also need the password and a current code, so a
 * stolen session alone cannot turn it off.
 *
 * Password and code are guessable by someone holding a session, so these are limited per
 * user as well as per source.
 */
export interface TotpRouteOptions {
  /** Attempts per user per ten minutes. Tests drive the real limiter. */
  attempts?: number;
}

export async function totpRoutes(app: FastifyInstance, opts: TotpRouteOptions = {}) {
  const limiters = [
    requireAuth,
    app.rateLimit({ max: 10, timeWindow: '10 minutes' }),
    windowLimiter({ max: opts.attempts ?? 10, windowMs: 10 * 60 * 1000 }, req => req.userId || null),
  ];

  const issuer = () => process.env.SPINE_DOMAIN || 'Archive';

  app.get('/api/auth/totp', { preHandler: [requireAuth] }, async (req, reply) => {
    const store = getStore();
    const totp = await store.users.getTotp(req.userId);
    const enabled = totp?.confirmed_at != null;
    return reply.send({
      enabled,
      recovery_codes_left: enabled ? await store.users.countRecoveryCodes(req.userId) : 0,
    });
  });

  /** The password is checked again for anything that changes the factor. */
  async function passwordOk(userId: string, password: unknown): Promise<boolean> {
    if (typeof password !== 'string' || !password) return false;
    const user = await getStore().users.findById(userId);
    return !!user && (await verifyPassword(user.password_hash, password));
  }

  // Step 1: a secret is made and shown. Nothing changes at login until step 2 succeeds.
  app.post<{ Body: { password?: string } }>('/api/auth/totp/setup', { preHandler: limiters }, async (req, reply) => {
    if (!(await passwordOk(req.userId, req.body?.password))) {
      return reply.status(401).send({ error: 'password is incorrect' });
    }

    const store = getStore();
    const user = (await store.users.findById(req.userId))!;
    const secret = generateSecret();
    const started = await store.users.beginTotp(req.userId, encryptSecret(user.id, secret), new Date().toISOString());
    if (!started) return reply.status(409).send({ error: 'two-factor is already on; turn it off first' });

    return reply.send({ secret: base32Encode(secret), otpauth_uri: otpauthUri(secret, user.email, issuer()) });
  });

  // Step 2: a first code proves the app has the secret before login starts depending on it.
  app.post<{ Body: { code?: string } }>('/api/auth/totp/enable', { preHandler: limiters }, async (req, reply) => {
    const { code } = req.body ?? {};
    if (typeof code !== 'string') return reply.status(400).send({ error: 'code required' });

    const store = getStore();
    const totp = await store.users.getTotp(req.userId);
    if (!totp) return reply.status(409).send({ error: 'start setup first' });
    if (totp.confirmed_at) return reply.status(409).send({ error: 'two-factor is already on' });

    let step: number | null = null;
    try {
      step = matchTotp(decryptSecret(req.userId, totp.secret_enc), code, Date.now(), 0);
    } catch {
      return reply.status(409).send({ error: 'start setup again' });
    }
    if (step === null) return reply.status(400).send({ error: 'incorrect code' });

    const { codes, hashes } = newRecoveryCodes();
    const authVersion = await store.users.enableTotp(req.userId, step, hashes, new Date().toISOString());
    if (authVersion === null) return reply.status(409).send({ error: 'two-factor is already on' });

    // Ends the user's other sessions, which were issued without the factor (P13).
    (req.session as SessionData).authVersion = authVersion;
    await endOtherSessions(req.userId, req.session as SessionData);
    const account = await store.users.findById(req.userId);
    if (account) mailAfter(req, req.userId, securityChangeMail(account.email, 'Two-factor sign-in was turned on', new Date().toISOString()), 'two-factor change');
    req.log.info({ userId: req.userId }, 'two-factor enabled');
    return reply.send({ ok: true, recovery_codes: codes });
  });

  app.post<{ Body: { password?: string; code?: string } }>(
    '/api/auth/totp/disable',
    { preHandler: limiters },
    async (req, reply) => {
      const user = await proofOr401(req, reply);
      if (!user) return;

      const authVersion = await getStore().users.disableTotp(user.id);
      (req.session as SessionData).authVersion = authVersion;
      await endOtherSessions(user.id, req.session as SessionData);
      mailAfter(req, user.id, securityChangeMail(user.email, 'Two-factor sign-in was turned off', new Date().toISOString()), 'two-factor change');
      req.log.info({ userId: user.id }, 'two-factor disabled');
      return reply.send({ ok: true });
    },
  );

  app.post<{ Body: { password?: string; code?: string } }>(
    '/api/auth/totp/recovery-codes',
    { preHandler: limiters },
    async (req, reply) => {
      const user = await proofOr401(req, reply);
      if (!user) return;

      const { codes, hashes } = newRecoveryCodes();
      await getStore().users.replaceRecoveryCodes(user.id, hashes);
      req.log.info({ userId: user.id }, 'recovery codes regenerated');
      return reply.send({ ok: true, recovery_codes: codes });
    },
  );

  /** Password and a current code (an authenticator code or an unspent recovery code). */
  async function proofOr401(
    req: { userId: string; body?: { password?: string; code?: string } | undefined; log: { warn: (o: object, m: string) => void } },
    reply: { status: (n: number) => { send: (b: object) => unknown } },
  ) {
    const store = getStore();
    const totp = await store.users.getTotp(req.userId);
    if (!totp?.confirmed_at) {
      reply.status(409).send({ error: 'two-factor is not on' });
      return null;
    }
    if (!(await passwordOk(req.userId, req.body?.password))) {
      reply.status(401).send({ error: 'password is incorrect' });
      return null;
    }
    const user = (await store.users.findById(req.userId))!;
    if (typeof req.body?.code !== 'string' || !(await checkSecondFactor(user, req.body.code))) {
      req.log.warn({ userId: user.id }, 'two-factor change with a wrong code');
      reply.status(401).send({ error: 'incorrect code' });
      return null;
    }
    return user;
  }
}
