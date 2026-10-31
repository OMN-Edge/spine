import { HEALTH_CONSENT_VERSION, TERMS_VERSION } from '../legal.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getAccountsStore } from 'spine-core/store/index.js';
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
import { loadInstanceKind, loadRegistrationMode, type InstanceKind, type RegistrationMode } from '../config.js';
import { AUTH_VALUE, parseVaultKeys } from '../vault-keys.js';
import { removeAllObjects } from '../vault-files.js';

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
  instance?: InstanceKind;
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

/** The answer to a sign-up under `approval`: the same whether or not the address already has an account. */
const WAITING = {
  ok: true,
  pending: true,
  message: 'Your account request is in. It can be used once the administrator has approved it.',
};

const INVALID_LINK = { error: 'this link is invalid or has expired' };

export async function accountRoutes(app: FastifyInstance, opts: AccountRouteOptions = {}) {
  const registration = opts.registration ?? loadRegistrationMode();
  const instance = opts.instance ?? loadInstanceKind();
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
    return reply.send({ registration, recovery: getMailer().enabled, instance });
  });

  if (registration === 'open' || registration === 'approval') {
    app.post<{ Body: { email?: string; password?: string; auth_value?: string; keys?: unknown; consent_health_data?: unknown; accept_terms?: unknown } }>(
      '/api/auth/register',
      { preHandler: [perSource, perAddress] },
      async (req, reply) => {
        const { email, password, consent_health_data: health, accept_terms: terms } = req.body ?? {};
        // With a vault the device sends the value it derived from the password, and the keys it made; the server never sees the password.
        const vault = req.body?.auth_value !== undefined || req.body?.keys !== undefined;
        const keys = vault ? parseVaultKeys(req.body?.keys) : null;
        if (vault && (!keys || typeof req.body?.auth_value !== 'string' || !AUTH_VALUE.test(req.body.auth_value))) {
          return reply.status(400).send({ error: 'the keys are not in the expected form' });
        }
        const address = typeof email === 'string' ? normaliseEmail(email) : '';
        if (!isPlausibleEmail(address)) {
          return reply.status(400).send({ error: 'a valid email address is required' });
        }
        // Two separate acts, each ticked by the person (GDPR Art. 9(2)(a) and Art. 7): consent to the use of health data is not
        // folded into accepting the terms, and an account is not made on a half answer.
        if (health !== true || terms !== true) {
          return reply.status(400).send({ error: 'consent to the use of your health data and acceptance of the terms are both needed, and given separately' });
        }
        // A vault's password is checked on the device, where it is typed; what arrives here is a derived value.
        const problem = vault ? null : checkPasswordPolicy(password, { email: address });
        if (problem) return reply.status(400).send({ error: problem });

        const store = getAccountsStore();
        const waits = registration === 'approval';
        const verifyByMail = !waits || getMailer().enabled;
        // Hashed whether or not the address is taken, so both cost the same.
        const passwordHash = await hashPassword((vault ? req.body?.auth_value : password) as string);

        if (!(await store.users.findByEmail(address))) {
          const id = uuidv4();
          try {
            const createdAt = new Date().toISOString();
            await store.transaction(async tx => {
              await tx.users.create({
                id,
                email: address,
                passwordHash,
                createdAt,
                // Holds nothing and gets no session until confirmed. Under `approval` with no mailer there is nothing to confirm by:
                // the administrator's approval stands for it, so mail stays optional there.
                verifiedAt: verifyByMail ? null : createdAt,
                approved: !waits,
                consent: { healthVersion: HEALTH_CONSENT_VERSION, termsVersion: TERMS_VERSION },
              });
              if (keys) await tx.vault.putKeys(id, keys, createdAt);
            });
            if (verifyByMail) {
              const token = await issueUserToken(id, 'verify', VERIFY_TTL_MS);
              sendLater(req, id, verificationMail(address, verificationLink(token)), 'verification');
            }
          } catch (err) {
            // Two requests for one new address can race to the unique index. The
            // loser is an existing address; either way the answer is the same.
            if (!/UNIQUE/i.test(String(err))) throw err;
          }
        }

        return reply.send(waits ? WAITING : GENERIC);
      },
    );
  }

  app.post<{ Body: { token?: string } }>(
    '/api/auth/verify',
    { preHandler: [perSource] },
    async (req, reply) => {
      const { token } = req.body ?? {};
      if (typeof token !== 'string' || !token) return reply.status(400).send(INVALID_LINK);

      const store = getAccountsStore();
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
      const user = isPlausibleEmail(address) ? await getAccountsStore().users.findByEmail(address) : null;

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
      const user = isPlausibleEmail(address) ? await getAccountsStore().users.findByEmail(address) : null;

      if (user) {
        const token = await issueUserToken(user.id, 'reset', RESET_TTL_MS);
        sendLater(req, user.id, resetMail(user.email, resetLink(token)), 'reset');
      }
      return reply.send(GENERIC);
    },
  );

  // The recovery-wrapped key of the account a reset link is for, so the device can open it with the recovery kit and wrap it again under
  // a new master key. The link is not spent: the next call spends it. Sealed, so it is no use without the kit.
  app.post<{ Body: { token?: string } }>(
    '/api/auth/reset/keys',
    { preHandler: [perSource] },
    async (req, reply) => {
      const { token } = req.body ?? {};
      if (typeof token !== 'string' || !token) return reply.status(400).send(INVALID_LINK);
      const store = getAccountsStore();
      const userId = await store.users.peekToken(hashUserToken(token), 'reset', new Date().toISOString());
      if (!userId) return reply.status(400).send(INVALID_LINK);
      const k = await store.vault.getKeys(userId);
      if (!k) return reply.send({ vault: false });
      return reply.send({ vault: true, wrapped_by_recovery: k.wrapped_by_recovery, public_key: k.public_key, wrapped_private_key: k.wrapped_private_key, kdf_params: JSON.parse(k.kdf_params) });
    },
  );

  // `erase` is the person's choice to go on without the kit: the sealed records could never be opened again, so they are removed and the
  // account starts with an empty vault. Without it, `keys` must hold the same account key the recovery kit opened.
  app.post<{ Body: { token?: string; password?: string; auth_value?: string; keys?: unknown; erase?: unknown } }>(
    '/api/auth/reset',
    { preHandler: [perSource] },
    async (req, reply) => {
      const { token, password } = req.body ?? {};
      if (typeof token !== 'string' || !token) return reply.status(400).send(INVALID_LINK);

      const store = getAccountsStore();
      const vault = req.body?.auth_value !== undefined || req.body?.keys !== undefined;
      const keys = vault ? parseVaultKeys(req.body?.keys) : null;
      if (vault && (!keys || typeof req.body?.auth_value !== 'string' || !AUTH_VALUE.test(req.body.auth_value))) {
        return reply.status(400).send({ error: 'the keys are not in the expected form' });
      }

      // Checked before the token is spent, so a bad request does not use up the link.
      if (!vault) {
        const problem = checkPasswordPolicy(password);
        if (problem) return reply.status(400).send({ error: problem });
        const owner = await store.users.peekToken(hashUserToken(token), 'reset', new Date().toISOString());
        // A password this server knows would sit beside keys it cannot open: an account with a vault is reset with a vault's keys.
        if (owner && (await store.vault.getKeys(owner))) return reply.status(400).send({ error: 'this account has a vault: reset it from the page, with your recovery kit' });
      }

      const now = new Date().toISOString();
      const userId = await store.users.consumeToken(hashUserToken(token), 'reset', now);
      if (!userId) return reply.status(400).send(INVALID_LINK);

      // setPassword bumps auth_version, which ends every session of this user.
      await store.users.setPassword(userId, await hashPassword((vault ? req.body?.auth_value : password) as string));
      if (keys) {
        const had = await store.vault.getKeys(userId);
        if (had && req.body?.erase === true) {
          await store.vault.erase(userId);
          removeAllObjects(userId);
          await store.vault.putKeys(userId, keys, now);
        } else if (had) {
          await store.vault.replaceKeys(userId, keys, now);
        } else {
          await store.vault.putKeys(userId, keys, now);
        }
      }
      // Receiving the link proves the mailbox is theirs.
      await store.users.markVerified(userId, now);
      await store.users.invalidateTokens(userId, 'reset');
      await store.sessions.revokeExcept(userId, null);

      req.log.info({ userId, erased: req.body?.erase === true }, 'password reset by link');
      return reply.send({ ok: true });
    },
  );
}
