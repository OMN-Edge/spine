import type { FastifyInstance } from 'fastify';
import { getAccountsStore } from 'spine-core/store/index.js';
import { requireAuth } from 'spine-core/routes/middleware.js';
import { emailCodeMatches, emailSecondFactorRequired, hashEmailCode, newEmailCode, signInCodeMail } from '../identity/index.js';
import { getMailer } from '../mail/index.js';
import { mailAfter, securityChangeMail } from '../identity/index.js';
import { windowLimiter } from '../rate-limit.js';
import { hasSecondFactor, passwordIsRight } from '../identity/index.js';
import { endOtherSessions } from '../identity/index.js';
import { type SessionData } from '../identity/index.js';
import { PENDING_LOGIN_MS, SECOND_FACTOR_ATTEMPTS } from './auth.js';

/**
 * A code sent to the address as the account's second step, chosen by its owner (SECURITY.md S-20; `SPINE_EMAIL_2FA=required` makes it the floor for
 * every account with no authenticator). Turning it on is two steps, as the authenticator is: the password starts it and mails a code, and the code
 * typed back proves the mailbox before sign-in depends on it, so an address that cannot receive mail cannot lock its owner out.
 * Turning it off takes the password, and is refused where the operator requires it.
 */
export async function emailSecondFactorRoutes(app: FastifyInstance) {
  const TEN_MINUTES_MS = 10 * 60 * 1000;
  const limiters = [
    requireAuth,
    app.rateLimit({ max: 10, timeWindow: '10 minutes' }),
    windowLimiter({ max: 10, windowMs: TEN_MINUTES_MS }, req => req.userId || null, 'too many requests, try again later', 'email code attempts'),
  ];
  // A mail is sent at each start, so they are counted on their own.
  const mailLimiter = windowLimiter({ max: 5, windowMs: TEN_MINUTES_MS }, req => req.userId || null, 'too many codes were sent, try again later', 'email codes sent');

  app.get('/api/auth/email-2fa', { preHandler: [requireAuth] }, async (req, reply) => {
    const user = await getAccountsStore().users.findById(req.userId);
    if (!user) return reply.status(401).send({ error: 'not authenticated' });
    return reply.send({
      enabled: user.email_second_factor === 1,
      // The operator asks every account with no authenticator for the code: it cannot be turned off.
      required: emailSecondFactorRequired(),
      // Without a mailer there is nothing to send a code with.
      available: getMailer().enabled,
    });
  });

  app.post<{ Body: { password?: string } }>('/api/auth/email-2fa/start', { preHandler: [...limiters, mailLimiter] }, async (req, reply) => {
    if (!(await passwordIsRight(req.userId, req.body?.password))) return reply.status(401).send({ error: 'password is incorrect' });
    const user = (await getAccountsStore().users.findById(req.userId))!;
    if (user.email_second_factor === 1) return reply.status(409).send({ error: 'a code by email is already on', code: 'already_on' });
    if (await hasSecondFactor(user.id)) return reply.status(409).send({ error: 'an authenticator app is on and is asked for instead; turn it off first', code: 'authenticator_on' });
    if (!getMailer().enabled) return reply.status(409).send({ error: 'this service sends no email', code: 'no_mailer' });

    const code = newEmailCode();
    try {
      await getMailer().send(signInCodeMail(user, code));
    } catch (err) {
      req.log.error({ userId: user.id, err: err instanceof Error ? err.message : String(err) }, 'could not send the code');
      return reply.status(503).send({ error: 'could not send the code, try again', code: 'code_not_sent' });
    }
    (req.session as SessionData).emailEnrol = { hash: hashEmailCode(user.id, code), expiresAt: Date.now() + PENDING_LOGIN_MS, failures: 0 };
    return reply.send({ ok: true });
  });

  app.post<{ Body: { code?: string } }>('/api/auth/email-2fa/enable', { preHandler: limiters }, async (req, reply) => {
    const session = req.session as SessionData;
    const pending = session.emailEnrol;
    if (!pending || pending.expiresAt < Date.now()) {
      delete session.emailEnrol;
      return reply.status(409).send({ error: 'start again', code: 'code_expired' });
    }
    const code = req.body?.code;
    if (typeof code !== 'string' || !code || code.length > 64) return reply.status(400).send({ error: 'code required' });

    if (!emailCodeMatches(req.userId, code, pending.hash)) {
      const failures = pending.failures + 1;
      if (failures >= SECOND_FACTOR_ATTEMPTS) {
        delete session.emailEnrol;
        return reply.status(409).send({ error: 'start again', code: 'code_expired' });
      }
      session.emailEnrol = { ...pending, failures };
      req.log.warn({ userId: req.userId, failures }, 'wrong code turning on the second step by email');
      return reply.status(400).send({ error: 'incorrect code' });
    }
    delete session.emailEnrol;

    const store = getAccountsStore();
    await store.users.setEmailSecondFactor(req.userId, true);
    // Ends the user's other sessions, which were issued without the second step (P13).
    await endOtherSessions(req.userId, session);
    const account = await store.users.findById(req.userId);
    if (account) mailAfter(req, req.userId, securityChangeMail(account, 'twoFactorOn', new Date().toISOString()), 'two-factor change');
    req.log.info({ userId: req.userId }, 'second step by email enabled');
    return reply.send({ ok: true });
  });

  app.post<{ Body: { password?: string } }>('/api/auth/email-2fa/disable', { preHandler: limiters }, async (req, reply) => {
    const store = getAccountsStore();
    const user = await store.users.findById(req.userId);
    if (!user || user.email_second_factor !== 1) return reply.status(409).send({ error: 'a code by email is not on', code: 'not_on' });
    if (emailSecondFactorRequired()) return reply.status(409).send({ error: 'this service requires a code by email', code: 'required' });
    if (!(await passwordIsRight(req.userId, req.body?.password))) return reply.status(401).send({ error: 'password is incorrect' });

    await store.users.setEmailSecondFactor(user.id, false);
    mailAfter(req, user.id, securityChangeMail(user, 'twoFactorOff', new Date().toISOString()), 'two-factor change');
    req.log.info({ userId: user.id }, 'second step by email disabled');
    return reply.send({ ok: true });
  });
}
