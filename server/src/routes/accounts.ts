import { loadBillingConfig } from '../billing/config.js';
import { HEALTH_CONSENT_VERSION, TERMS_VERSION } from '../legal.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getAccountsStore } from 'spine-core/store/index.js';
import { isSupportedLanguage } from 'spine-core/languages.js';
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
import { AUTH_VALUE, parseKdfParams, parseVaultKeys } from '../vault-keys.js';
import { resetMessage, verifyResetProof } from '../reset-proof.js';
import { removeAllObjects } from '../vault-files.js';
import { checkSecondFactor, hasSecondFactor } from '../second-factor.js';
import { mailAfter, securityChangeMail } from '../notify.js';

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
  /** Mails the instance sends an hour to addresses that are not its signed-in accounts (a sign-up's, a resend, a reset), all sources together; default `SPINE_MAIL_MAX_PER_HOUR` or 120 (S-51). */
  mailPerHour?: number;
  /** New sign-ups an hour, all sources together; default `SPINE_SIGNUPS_MAX_PER_HOUR` or 60 (S-51). */
  signupsPerHour?: number;
  /** Attempts at one reset link in ten minutes, wrong second-factor codes included. */
  resetCodeAttempts?: number;
}

const DEFAULT_PER_SOURCE = { max: 10, timeWindow: '10 minutes' };
const DEFAULT_PER_ADDRESS: WindowLimit = { max: 3, windowMs: 60 * 60 * 1000 };
const RESET_CODE_ATTEMPTS = 5;
const RESET_CODE_WINDOW_MS = 10 * 60 * 1000;

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

/** Where sign-ups come from that the loops in the marketing plan are meant to bring: a shared page, a card, an invitation. A count a day, never a person. */
const SIGNUP_REFS = new Set(['share', 'card', 'invite', 'doctors']);
async function countSignup(ref: unknown): Promise<void> {
  try {
    const day = new Date().toISOString().slice(0, 10);
    await getAccountsStore().metrics.bump('signup', day);
    if (typeof ref === 'string' && SIGNUP_REFS.has(ref)) await getAccountsStore().metrics.bump(`signup_from_${ref}`, day);
  } catch {
    // a count is never worth a failed sign-up
  }
}

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

  // In all, as login has: each source and each address is limited, but a spread of them made the instance send mail to as many strangers as
  // there were sources, at its provider's cost and reputation, and take as many sign-ups (S-51). The per-source limit runs first.
  const hour = 60 * 60 * 1000;
  const whole = (raw: string | undefined, fallback: number) => (Number.isInteger(Number(raw)) && Number(raw) > 0 && (raw ?? '').trim() !== '' ? Number(raw) : fallback);
  const mailCap = windowLimiter({ max: opts.mailPerHour ?? whole(process.env.SPINE_MAIL_MAX_PER_HOUR, 120), windowMs: hour }, () => 'instance', 'too many requests just now, try again later');
  const signupCap = windowLimiter({ max: opts.signupsPerHour ?? whole(process.env.SPINE_SIGNUPS_MAX_PER_HOUR, 60), windowMs: hour }, () => 'instance', 'too many sign-ups just now, try again later');

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
    return reply.send({ registration, recovery: getMailer().enabled, instance, billing: loadBillingConfig().enabled, waitlist: (process.env.SPINE_WAITLIST ?? 'off') === 'on' });
  });

  if (registration === 'open' || registration === 'approval') {
    app.post<{ Body: { email?: string; password?: string; auth_value?: string; keys?: unknown; consent_health_data?: unknown; accept_terms?: unknown; ref?: unknown; language?: unknown } }>(
      '/api/auth/register',
      { preHandler: [perSource, perAddress, mailCap, signupCap] },
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
        // The language the page was in, so the first mail (the one that confirms the address) is written in it; anything else is left unset.
        const language = isSupportedLanguage(req.body?.language) ? req.body.language : null;
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
                language,
                consent: { healthVersion: HEALTH_CONSENT_VERSION, termsVersion: TERMS_VERSION },
              });
              if (keys) await tx.vault.putKeys(id, keys, createdAt);
            });
            await countSignup(req.body?.ref);
            if (verifyByMail) {
              const token = await issueUserToken(id, 'verify', VERIFY_TTL_MS);
              sendLater(req, id, verificationMail({ email: address, language }, verificationLink(token)), 'verification');
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
    { preHandler: [perSource, perAddress, mailCap] },
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
    { preHandler: [perSource, perAddress, mailCap] },
    async (req, reply) => {
      // Without a mailer there is nothing to send; the operator issues the link.
      if (!getMailer().enabled) {
        return reply.status(404).send({ error: 'password recovery by email is not enabled' });
      }

      const address = normaliseEmail(String(req.body?.email ?? ''));
      const user = isPlausibleEmail(address) ? await getAccountsStore().users.findByEmail(address) : null;

      // An owner who turned off recovery by email gets no mail, and the same answer as anyone (S-38).
      if (user && user.email_recovery !== 0) {
        const token = await issueUserToken(user.id, 'reset', RESET_TTL_MS);
        sendLater(req, user.id, resetMail(user, resetLink(token)), 'reset');
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
      // Whether the reset will ask for a code, so the page can ask before the person has made new keys.
      const second_factor = await hasSecondFactor(userId);
      const email_recovery = (await store.users.findById(userId))?.email_recovery !== 0;
      if (!k) return reply.send({ vault: false, second_factor, email_recovery });
      return reply.send({ vault: true, second_factor, email_recovery, wrapped_by_recovery: k.wrapped_by_recovery, public_key: k.public_key, wrapped_private_key: k.wrapped_private_key, kdf_params: JSON.parse(k.kdf_params) });
    },
  );

  // `erase` is the person's choice to go on without the kit: the sealed records could never be opened again, so they are removed and the
  // account starts with an empty vault. Without it, `keys` must hold the same account key the recovery kit opened.
  // A reset replaces the keys the records open with, and the link is only the mailbox's word, so an account with a second factor is asked for
  // it here too (S-38). A code is a few digits: attempts are counted per link, so holding the link is not a way to try them all.
  const perLink = windowLimiter(
    { max: opts.resetCodeAttempts ?? RESET_CODE_ATTEMPTS, windowMs: RESET_CODE_WINDOW_MS },
    (req: FastifyRequest) => {
      const token = (req.body as { token?: unknown } | undefined)?.token;
      return typeof token === 'string' && token ? hashUserToken(token) : null;
    },
    'too many attempts, try again later',
  );
  app.post<{ Body: { token?: string; password?: string; auth_value?: string; keys?: unknown; erase?: unknown; code?: unknown; proof?: unknown } }>(
    '/api/auth/reset',
    { preHandler: [perSource, perLink] },
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

      // Whose link it is, without spending it: what follows is checked first, so a refusal leaves it good for the owner.
      const holder = await store.users.peekToken(hashUserToken(token), 'reset', new Date().toISOString());

      // The owner turned off recovery by email: a link cannot start the records over. It can still carry a reset signed with the recovery kit,
      // which is checked below (S-38).
      if (holder && req.body?.erase === true && (await store.users.findById(holder))?.email_recovery === 0) {
        return reply.status(403).send({ error: 'recovery by email is turned off for this account', code: 'email_recovery_off' });
      }

      // The second factor. A code is spent when it is right (a step or a recovery code is used once), and the check is after what could fail on
      // shape, so a bad request does not use one up.
      if (holder && (await hasSecondFactor(holder))) {
        const code = req.body?.code;
        if (typeof code !== 'string' || !code || code.length > 64) return reply.status(401).send({ error: 'a code from your authenticator or a recovery code is needed', code: 'second_factor_required' });
        if (!(await checkSecondFactor({ id: holder }, code))) {
          req.log.warn({ ip: req.ip, userId: holder }, 'failed second factor on a reset');
          return reply.status(401).send({ error: 'incorrect code', code: 'second_factor_required' });
        }
      }

      // The recovery kit, before the link is spent. The link is the mailbox's word and the server cannot open what the kit opens, so a vault with a
      // verifier is replaced only by a request signed for it, over this link and these keys (S-38). Starting over without the kit cannot be
      // signed for and is not asked to (an owner who wants it refused turns off recovery by email, above); a vault with no verifier is refused here, since it has no key to prove the kit against.
      if (holder && keys && req.body?.erase !== true) {
        const verifier = (await store.vault.getKeys(holder))?.reset_verifier;
        const params = parseKdfParams(keys.kdf_params);
        // A vault with no verifier (one from before them) is not reset by the link alone any more: it has no key to prove the kit against.
        if (!verifier || !(params && verifyResetProof(verifier, resetMessage(token, req.body?.auth_value as string, keys, params), req.body?.proof))) {
          req.log.warn({ ip: req.ip, userId: holder }, 'reset without the recovery kit refused');
          return reply.status(401).send({ error: 'this reset needs your recovery kit', code: 'recovery_proof_required' });
        }
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
          await removeAllObjects(userId);
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

      // Said to the address, so a reset the owner did not make is seen (S-38); what the reset did, never anything about the records.
      const owner = await store.users.findById(userId);
      if (owner) {
        const what = keys && req.body?.erase === true ? 'resetByLinkErased' : 'resetByLink';
        mailAfter(req, userId, securityChangeMail(owner, what, now), 'reset');
      }

      req.log.info({ userId, erased: req.body?.erase === true }, 'password reset by link');
      return reply.send({ ok: true });
    },
  );
}
