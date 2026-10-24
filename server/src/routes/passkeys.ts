import type { FastifyInstance } from 'fastify';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, AuthenticatorTransport, RegistrationResponseJSON } from '@simplewebauthn/server';
import { getStore } from '../store/index.js';
import { relyingParty } from '../passkeys.js';
import { mailAfter, newSignInMail, securityChangeMail } from '../notify.js';
import { startSession } from '../sessions.js';
import { windowLimiter } from '../rate-limit.js';
import { sealed } from '../vault-keys.js';
import { requireAuth, requireRecentAuth, type SessionData } from './middleware.js';
import { PENDING_LOGIN_MS } from './auth.js';

/**
 * Passkeys (FR-ACC-02): sign in with a fingerprint, a face or a device PIN instead of a password. The device holds a private key per
 * site and signs a challenge the server made; the server keeps only the public key. Nothing typed can be phished, because the
 * browser will only sign for this site's own address.
 *
 * A passkey is used with user verification required, so it is two factors in one (something the person has, something they are or
 * know): signing in with one does not ask for a code. It is therefore the second place that may start a session
 * (`second-factor.test.ts` guards the list), and everything that makes the password route safe is repeated: a rate limit per source,
 * a challenge that is single-use and short-lived, an unverified address or a changed account refused, a fresh session id, and mail
 * about a new browser. Adding and removing passkeys needs the password typed lately, and removing one is mailed, so a stolen cookie
 * cannot quietly add its own way in.
 */
const CHALLENGE_MS = PENDING_LOGIN_MS;
const MAX_PASSKEYS = 10;

const cleanName = (value: unknown): string => {
  const name = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return name.slice(0, 60) || 'Passkey';
};

export interface PasskeyRouteOptions {
  /** Sign-in attempts per source per ten minutes, and in all. Tests drive the real limiters. */
  perSource?: number;
  instanceWide?: number;
}

export async function passkeyRoutes(app: FastifyInstance, opts: PasskeyRouteOptions = {}) {
  const perSource = [
    app.rateLimit({ max: opts.perSource ?? 20, timeWindow: '10 minutes' }),
    windowLimiter({ max: opts.instanceWide ?? 200, windowMs: 10 * 60 * 1000 }, () => 'instance', 'too many sign-in attempts, try again later'),
  ];

  // --- Managing them (signed in) ---------------------------------------------------------------------------------------------

  app.get('/api/auth/passkeys', { preHandler: [requireAuth] }, async (req, reply) => {
    const list = await getStore().users.listPasskeys(req.userId);
    // Names, dates and whether it opens the vault: the credential id and key are the server's, and so is the sealed key, which is not sent here.
    return reply.header('Cache-Control', 'no-store').send(list.map(p => ({ id: p.id, name: p.name, backed_up: p.backed_up, created_at: p.created_at, last_used_at: p.last_used_at, opens_vault: p.wrapped_key !== null })));
  });

  app.post('/api/auth/passkeys/options', { preHandler: [requireAuth, requireRecentAuth, app.rateLimit({ max: 20, timeWindow: '10 minutes' })] }, async (req, reply) => {
    const store = getStore();
    const user = await store.users.findById(req.userId);
    if (!user) return reply.status(401).send({ error: 'not authenticated' });
    const mine = await store.users.listPasskeys(req.userId);
    if (mine.length >= MAX_PASSKEYS) return reply.status(409).send({ error: `at most ${MAX_PASSKEYS} passkeys` });
    const rp = relyingParty();
    const options = await generateRegistrationOptions({
      rpName: rp.name, rpID: rp.id, userName: user.email, userID: new TextEncoder().encode(user.id), attestationType: 'none',
      excludeCredentials: mine.map(p => ({ id: p.id, transports: (p.transports ?? undefined) as AuthenticatorTransport[] | undefined })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      // Asks the authenticator to support the PRF extension, which is what lets this passkey open the vault; one that cannot just signs in.
      extensions: { prf: {} } as never,
    });
    (req.session as SessionData).passkey = { kind: 'register', challenge: options.challenge, expiresAt: Date.now() + CHALLENGE_MS };
    return reply.header('Cache-Control', 'no-store').send(options);
  });

  app.post<{ Body: { response?: RegistrationResponseJSON; name?: unknown } }>('/api/auth/passkeys', { preHandler: [requireAuth, requireRecentAuth, app.rateLimit({ max: 20, timeWindow: '10 minutes' })] }, async (req, reply) => {
    const session = req.session as SessionData;
    const held = session.passkey;
    delete session.passkey; // one challenge, one try
    if (!held || held.kind !== 'register' || held.expiresAt < Date.now()) return reply.status(400).send({ error: 'start again', code: 'passkey_expired' });
    if (!req.body?.response || typeof req.body.response !== 'object') return reply.status(400).send({ error: 'the passkey is missing' });

    const rp = relyingParty();
    let verified;
    try {
      verified = await verifyRegistrationResponse({ response: req.body.response, expectedChallenge: held.challenge, expectedOrigin: rp.origin, expectedRPID: rp.id, requireUserVerification: true });
    } catch {
      return reply.status(400).send({ error: 'this passkey could not be verified' });
    }
    if (!verified.verified || !verified.registrationInfo) return reply.status(400).send({ error: 'this passkey could not be verified' });

    const { credential, credentialBackedUp } = verified.registrationInfo;
    const added = await getStore().users.addPasskey(req.userId, {
      id: credential.id, public_key: Buffer.from(credential.publicKey).toString('base64url'), counter: credential.counter,
      transports: (credential.transports as string[] | undefined) ?? null, name: cleanName(req.body.name), backed_up: credentialBackedUp, created_at: new Date().toISOString(),
    });
    if (!added) return reply.status(409).send({ error: 'this passkey is already registered' });
    const user = await getStore().users.findById(req.userId);
    if (user) mailAfter(req, user.id, securityChangeMail(user.email, 'A passkey was added to your account.', new Date().toISOString()), 'passkey added');
    return reply.status(201).send({ ok: true });
  });

  app.patch<{ Params: { id: string }; Body: { name?: unknown } }>('/api/auth/passkeys/:id', { preHandler: [requireAuth] }, async (req, reply) => {
    if (!(await getStore().users.renamePasskey(req.userId, req.params.id, cleanName(req.body?.name)))) return reply.status(404).send({ error: 'not found' });
    return reply.send({ ok: true });
  });

  // Lets a passkey open the vault: the device made a key from the passkey's PRF output (which never leaves it), sealed the account key under it
  // and sends only that. The server holds ciphertext it cannot open. Needs the password typed lately, as adding a passkey does, and is
  // mailed, because it is a new way to open the records. Null takes it away again.
  app.put<{ Params: { id: string }; Body: { wrapped_key?: unknown } }>('/api/auth/passkeys/:id/vault-key', { preHandler: [requireAuth, requireRecentAuth, app.rateLimit({ max: 20, timeWindow: '10 minutes' })] }, async (req, reply) => {
    const wrapped = req.body?.wrapped_key;
    if (wrapped !== null && !sealed(wrapped, 90, 200)) return reply.status(400).send({ error: 'the sealed key is not what it should be' });
    if (!(await getStore().users.setPasskeyWrappedKey(req.userId, req.params.id, wrapped as string | null))) return reply.status(404).send({ error: 'not found' });
    const user = await getStore().users.findById(req.userId);
    if (user) mailAfter(req, user.id, securityChangeMail(user.email, wrapped === null ? 'A passkey can no longer open your records.' : 'A passkey can now open your records.', new Date().toISOString()), 'passkey vault key');
    return reply.send({ ok: true });
  });

  app.delete<{ Params: { id: string } }>('/api/auth/passkeys/:id', { preHandler: [requireAuth, requireRecentAuth] }, async (req, reply) => {
    if (!(await getStore().users.removePasskey(req.userId, req.params.id))) return reply.status(404).send({ error: 'not found' });
    const user = await getStore().users.findById(req.userId);
    if (user) mailAfter(req, user.id, securityChangeMail(user.email, 'A passkey was removed from your account.', new Date().toISOString()), 'passkey removed');
    return reply.send({ ok: true });
  });

  // --- Signing in (nobody yet) -----------------------------------------------------------------------------------------------

  // No account is named: the device offers the passkeys it holds for this site, so there is nothing here that tells a stranger
  // whether an address has an account.
  app.post('/api/auth/passkey/options', { preHandler: perSource }, async (req, reply) => {
    const rp = relyingParty();
    const options = await generateAuthenticationOptions({ rpID: rp.id, userVerification: 'required' });
    await req.session.regenerate();
    (req.session as SessionData).passkey = { kind: 'login', challenge: options.challenge, expiresAt: Date.now() + CHALLENGE_MS };
    return reply.header('Cache-Control', 'no-store').send(options);
  });

  app.post<{ Body: { response?: AuthenticationResponseJSON } }>('/api/auth/passkey/login', { preHandler: perSource }, async (req, reply) => {
    const session = req.session as SessionData;
    const held = session.passkey;
    delete session.passkey; // one challenge, one try
    if (!held || held.kind !== 'login' || held.expiresAt < Date.now()) return reply.status(401).send({ error: 'sign in again', code: 'login_expired' });
    const response = req.body?.response;
    if (!response || typeof response !== 'object' || typeof response.id !== 'string') return reply.status(400).send({ error: 'the passkey is missing' });

    const refused = () => {
      req.log.warn({ ip: req.ip, userAgent: req.headers['user-agent'] }, 'failed passkey sign-in');
      return reply.status(401).send({ error: 'this passkey could not be used' });
    };

    const store = getStore();
    const passkey = await store.users.findPasskey(response.id);
    if (!passkey) return refused();
    const user = await store.users.findById(passkey.user_id);
    if (!user || !user.email_verified_at) return refused();

    const rp = relyingParty();
    let verified;
    try {
      verified = await verifyAuthenticationResponse({
        response, expectedChallenge: held.challenge, expectedOrigin: rp.origin, expectedRPID: rp.id, requireUserVerification: true,
        credential: { id: passkey.id, publicKey: Buffer.from(passkey.public_key, 'base64url'), counter: passkey.counter, transports: (passkey.transports ?? undefined) as AuthenticatorTransport[] | undefined },
      });
    } catch {
      return refused();
    }
    if (!verified.verified) return refused();
    await store.users.touchPasskey(passkey.id, verified.authenticationInfo.newCounter, new Date().toISOString());

    await req.session.regenerate();
    const device = await startSession(req, reply, user.id, user.auth_version);
    if (device === 'new') mailAfter(req, user.id, newSignInMail(user.email, new Date().toISOString()), 'new sign-in');
    req.log.info({ ip: req.ip, userId: user.id }, 'login succeeded with a passkey');
    // The sealed key travels with the sign-in: it is ciphertext, and only this passkey's PRF output (on the device) opens it.
    return reply.send({ ok: true, email: user.email, credential_id: passkey.id, wrapped_key: passkey.wrapped_key });
  });
}
