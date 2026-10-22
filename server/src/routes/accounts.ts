import { HEALTH_CONSENT_VERSION, TERMS_VERSION } from '../legal.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getStore } from '../store/index.js';
import { getMailer, type MailMessage } from '../mail/index.js';
import {
  checkPasswordPolicy,
  hashPassword,
  isPlausibleEmail,
  normaliseEmail,
} from '../passwords.js';
import {
  RESET_TTL_MS,
  VERIFY_TTL_MS,
  issueUserToken,
  resetLink,
  resetMail,
  verificationLink,
  verificationMail,
} from '../accounts.js';
import { hashUserToken } from '../user-tokens.js';
import { windowLimiter, type WindowLimit } from '../rate-limit.js';
import { loadRegistrationMode, type RegistrationMode } from '../config.js';

/**
 * Signup, address verification and password recovery (SECURITY.md M-6, M-11).
 *
 * Every one of these is public, so every one is rate limited twice: per source
 * address, and per email address — the second so that the endpoint cannot be used
 * to flood somebody's inbox. And none of them can be used to find out which
 * addresses have accounts: an unknown and a known address get the same answer, in
 * about the same time, because the mail is sent after the response.
 */
export interface AccountRouteOptions {
  registration?: RegistrationMode;
  perSource?: { max: number; timeWindow: string | number };
  perAddress?: WindowLimit;
}

const DEFAULT_PER_SOURCE = { max: 10, timeWindow: '10 minutes' };
const DEFAULT_PER_ADDRESS: WindowLimit = { max: 3, windowMs: 60 * 60 * 1000 };

/** The answer for every request that names an address, whether or not it has an account. */
const GENERIC = {
  ok: true,
  message: 'If that address can receive mail, a link is on its way. Nothing after a few minutes? Request another.',
};

const INVALID_LINK = { error: 'this link is invalid or has expired' };

export async function accountRoutes(app: FastifyInstance, opts: AccountRouteOptions = {}) {
  const registration = opts.registration ?? loadRegistrationMode();
  const perSource = app.rateLimit({ ...DEFAULT_PER_SOURCE, ...opts.perSource });
  const perAddress = windowLimiter(
    { ...DEFAULT_PER_ADDRESS, ...opts.perAddress },
    (req: FastifyRequest) => {
      const email = (req.body as { email?: unknown } | undefined)?.email;
      return typeof email === 'string' ? normaliseEmail(email) : null;
    },
    'too many requests for this address, try again later',
  );

  /**
   * After the response, so how long the mail provider takes does not depend on
   * whether the address exists. A failure is logged; the user's recourse is to
   * request another, which is what the generic answer tells them.
   */
  const sendLater = (req: FastifyRequest, userId: string, message: MailMessage, what: string) => {
    void getMailer()
      .send(message)
      .catch(err => {
        // The error carries a status, never the message — which holds a live link.
        req.log.error({ userId, err: err instanceof Error ? err.message : String(err) }, `could not send ${what} mail`);
      });
  };

  // What the sign-in page needs to know before anyone is signed in.
  app.get('/api/auth/options', async (_req, reply) => {
    return reply.send({ registration, recovery: getMailer().enabled });
  });

  if (registration === 'open') {
    app.post<{ Body: { email?: string; password?: string; consent_health_data?: unknown; accept_terms?: unknown } }>(
      '/api/auth/register',
      { preHandler: [perSource, perAddress] },
      async (req, reply) => {
        const { email, password, consent_health_data: health, accept_terms: terms } = req.body ?? {};
        const address = typeof email === 'string' ? normaliseEmail(email) : '';
        if (!isPlausibleEmail(address)) {
          return reply.status(400).send({ error: 'a valid email address is required' });
        }
        // Two separate acts, each ticked by the person (GDPR Art. 9(2)(a) and Art. 7): consent to the use of health data is not
        // folded into accepting the terms, and an account is not made on a half answer.
        if (health !== true || terms !== true) {
          return reply.status(400).send({ error: 'consent to the use of your health data and acceptance of the terms are both needed, and given separately' });
        }
        const problem = checkPasswordPolicy(password, { email: address });
        if (problem) return reply.status(400).send({ error: problem });

        const store = getStore();
        // Hashed whether or not the address is taken, so both cost the same.
        const passwordHash = await hashPassword(password as string);

        if (!(await store.users.findByEmail(address))) {
          const id = uuidv4();
          try {
            await store.users.create({
              id,
              email: address,
              passwordHash,
              createdAt: new Date().toISOString(),
              verifiedAt: null, // holds nothing and gets no session until confirmed
              consent: { healthVersion: HEALTH_CONSENT_VERSION, termsVersion: TERMS_VERSION },
            });
            const token = await issueUserToken(id, 'verify', VERIFY_TTL_MS);
            sendLater(req, id, verificationMail(address, verificationLink(token)), 'verification');
          } catch (err) {
            // Two requests for one new address can race to the unique index. The
            // loser is an existing address; either way the answer is the same.
            if (!/UNIQUE/i.test(String(err))) throw err;
          }
        }

        return reply.send(GENERIC);
      },
    );
  }

  app.post<{ Body: { token?: string } }>(
    '/api/auth/verify',
    { preHandler: [perSource] },
    async (req, reply) => {
      const { token } = req.body ?? {};
      if (typeof token !== 'string' || !token) return reply.status(400).send(INVALID_LINK);

      const store = getStore();
      const now = new Date().toISOString();
      const userId = await store.users.consumeToken(hashUserToken(token), 'verify', now);
      if (!userId) return reply.status(400).send(INVALID_LINK);

      await store.users.markVerified(userId, now);
      req.log.info({ userId }, 'email verified');
      return reply.send({ ok: true });
    },
  );

  app.post<{ Body: { email?: string } }>(
    '/api/auth/resend-verification',
    { preHandler: [perSource, perAddress] },
    async (req, reply) => {
      const address = normaliseEmail(String(req.body?.email ?? ''));
      const user = isPlausibleEmail(address) ? await getStore().users.findByEmail(address) : null;

      if (user && !user.email_verified_at && getMailer().enabled) {
        const token = await issueUserToken(user.id, 'verify', VERIFY_TTL_MS);
        sendLater(req, user.id, verificationMail(user.email, verificationLink(token)), 'verification');
      }
      return reply.send(GENERIC);
    },
  );

  app.post<{ Body: { email?: string } }>(
    '/api/auth/forgot',
    { preHandler: [perSource, perAddress] },
    async (req, reply) => {
      // Without a mailer there is nothing to send; the operator issues the link.
      if (!getMailer().enabled) {
        return reply.status(404).send({ error: 'password recovery by email is not enabled' });
      }

      const address = normaliseEmail(String(req.body?.email ?? ''));
      const user = isPlausibleEmail(address) ? await getStore().users.findByEmail(address) : null;

      if (user) {
        const token = await issueUserToken(user.id, 'reset', RESET_TTL_MS);
        sendLater(req, user.id, resetMail(user.email, resetLink(token)), 'reset');
      }
      return reply.send(GENERIC);
    },
  );

  app.post<{ Body: { token?: string; password?: string } }>(
    '/api/auth/reset',
    { preHandler: [perSource] },
    async (req, reply) => {
      const { token, password } = req.body ?? {};
      if (typeof token !== 'string' || !token) return reply.status(400).send(INVALID_LINK);

      // Checked before the token is spent, so a too-short password does not use
      // up the link.
      const problem = checkPasswordPolicy(password);
      if (problem) return reply.status(400).send({ error: problem });

      const store = getStore();
      const now = new Date().toISOString();
      const userId = await store.users.consumeToken(hashUserToken(token), 'reset', now);
      if (!userId) return reply.status(400).send(INVALID_LINK);

      // setPassword bumps auth_version, which ends every session of this user.
      await store.users.setPassword(userId, await hashPassword(password as string));
      // Receiving the link proves the mailbox is theirs.
      await store.users.markVerified(userId, now);
      await store.users.invalidateTokens(userId, 'reset');
      await store.sessions.revokeExcept(userId, null);

      req.log.info({ userId }, 'password reset by link');
      return reply.send({ ok: true });
    },
  );
}
