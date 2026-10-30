import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { getAccountsStore } from 'spine-core/store/index.js';
import { requireAuth, requireRecentAuth } from 'spine-core/routes/middleware.js';
import { countryOf } from '../geo.js';
import { mailAfter, newSignInMail, securityChangeMail } from '../notify.js';
import { windowLimiter } from '../rate-limit.js';
import { cleanHeader, startSession } from '../sessions.js';
import { type SessionData } from '../session-auth.js';
import { sealed } from '../vault-keys.js';

/**
 * Letting a new device in from one that is signed in (TR-CRY-05, SECURITY.md **M-41**), without typing the master password on the new one.
 *
 * The signed-in device makes a one-time code, seals the account key under a key the code makes, and leaves that here with an id the code
 * also makes. The code is shown to the person and typed (or scanned) into the new device; it is never sent to this server, which holds
 * ciphertext and an id it cannot reverse. The new device asks with the id, and gets a token only it holds. The owner sees what asked
 * (its browser and the country it came from) on the device that made the offer and approves or refuses. Only then can the asking device
 * collect the sealed key, with a sign-in.
 *
 * That sign-in is the third thing that may start a session (`second-factor.test.ts` guards the list). It does not ask for a code
 * because the device that approved had one, and it is not taken to have typed the password: the actions that ask for it lately
 * still ask. What makes it safe is repeated from the others: the offer is single-use, a few minutes long, one per account, void when the
 * password changes or the account goes, bound to the one browser that asked first, approved by a person who typed their password lately,
 * rate limited at every public step, and mailed.
 */
export const OFFER_MS = 10 * 60 * 1000;
const ID = /^[A-Za-z0-9_-]{43}$/;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export interface EnrolmentRouteOptions {
  /** Asks per source per ten minutes (to find an offer), and collections (which are polled while the owner decides). Tests drive the real limiters. */
  requestsPerSource?: number;
  claimsPerSource?: number;
  instanceWide?: number;
}

export async function enrolmentRoutes(app: FastifyInstance, opts: EnrolmentRouteOptions = {}) {
  const store = () => getAccountsStore().enrolments;
  const publicLimits = (perSource: number) => [
    app.rateLimit({ max: perSource, timeWindow: '10 minutes' }),
    windowLimiter({ max: opts.instanceWide ?? 3000, windowMs: 10 * 60 * 1000 }, () => 'instance', 'too many attempts, try again later'),
  ];

  // --- The signed-in device ------------------------------------------------------------------------------------------------

  app.post<{ Body: { id?: unknown; wrapped?: unknown } }>('/api/enrol/offer', { preHandler: [requireAuth, requireRecentAuth, app.rateLimit({ max: 10, timeWindow: '10 minutes' })] }, async (req, reply) => {
    const { id, wrapped } = req.body ?? {};
    if (typeof id !== 'string' || !ID.test(id)) return reply.status(400).send({ error: 'the code is not what it should be' });
    if (!sealed(wrapped, 90, 200)) return reply.status(400).send({ error: 'the sealed key is not what it should be' });
    const user = await getAccountsStore().users.findById(req.userId);
    if (!user || !user.email_verified_at) return reply.status(401).send({ error: 'not authenticated' });
    const now = Date.now();
    await store().sweep(new Date(now).toISOString());
    await store().offer(req.userId, { id, wrapped, authVersion: user.auth_version, at: new Date(now).toISOString(), expiresAt: new Date(now + OFFER_MS).toISOString() });
    return reply.header('Cache-Control', 'no-store').send({ ok: true, expires_at: new Date(now + OFFER_MS).toISOString() });
  });

  // Polled while the code is on screen: nothing yet, or a browser asking.
  app.get('/api/enrol/offer', { preHandler: [requireAuth] }, async (req, reply) => {
    return reply.header('Cache-Control', 'no-store').send({ offer: await store().current(req.userId, new Date().toISOString()) });
  });

  app.post<{ Body: { approve?: unknown } }>('/api/enrol/decision', { preHandler: [requireAuth, requireRecentAuth] }, async (req, reply) => {
    const approve = req.body?.approve;
    if (typeof approve !== 'boolean') return reply.status(400).send({ error: 'approve or refuse' });
    if (!(await store().decide(req.userId, approve, new Date().toISOString()))) return reply.status(404).send({ error: 'no device is waiting' });
    req.log.info({ userId: req.userId, approve }, 'device enrolment decided');
    return reply.send({ ok: true });
  });

  app.delete('/api/enrol/offer', { preHandler: [requireAuth] }, async (req, reply) => {
    await store().cancel(req.userId);
    return reply.send({ ok: true });
  });

  // --- The new device (nobody yet) -----------------------------------------------------------------------------------------------

  // Says that this browser holds the code. The id is 256 bits the code made, so a guess finds nothing, and an unknown, used, expired or
  // taken id all answer the same.
  app.post<{ Body: { id?: unknown } }>('/api/enrol/request', { preHandler: publicLimits(opts.requestsPerSource ?? 20) }, async (req, reply) => {
    const id = req.body?.id;
    const gone = () => reply.status(404).send({ error: 'this code is not valid, or it has expired' });
    if (typeof id !== 'string' || !ID.test(id)) return gone();
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const taken = await store().request(id, hash(token), {
      agent: cleanHeader(req.headers['user-agent'], 200), country: await countryOf(req.ip), at: now.toISOString(),
    }, now.toISOString());
    if (!taken) return gone();
    req.log.info({ ip: req.ip }, 'a device asked to be let in');
    return reply.header('Cache-Control', 'no-store').send({ token });
  });

  // Polled by the asking browser until the owner decides. Once approved, the first call that finds it so is signed in and gets the sealed key.
  app.post<{ Body: { id?: unknown; token?: unknown } }>('/api/enrol/claim', { preHandler: publicLimits(opts.claimsPerSource ?? 600) }, async (req, reply) => {
    const { id, token } = req.body ?? {};
    const gone = () => reply.status(404).send({ error: 'this code is not valid, or it has expired' });
    if (typeof id !== 'string' || !ID.test(id) || typeof token !== 'string' || token.length !== 43) return gone();
    const got = await store().claim(id, hash(token), new Date().toISOString());
    if (got.status === 'waiting') return reply.status(202).header('Cache-Control', 'no-store').send({ waiting: true });
    if (got.status === 'denied') return reply.status(403).send({ error: 'the other device did not allow this one', code: 'refused' });
    if (got.status !== 'approved') return gone();

    // Approved, and now spent. The account must be the one the offer was made for: a changed password or a removed account voids it.
    const user = await getAccountsStore().users.findById(got.userId);
    if (!user || !user.email_verified_at || user.auth_version !== got.authVersion) return gone();
    await req.session.regenerate();
    const device = await startSession(req, reply, user.id, user.auth_version, { passwordTyped: false });
    // Always told: a way in that needed no password is worth a mail even from a browser the account knows.
    mailAfter(req, user.id, device === 'new' ? newSignInMail(user.email, new Date().toISOString()) : securityChangeMail(user.email, 'A device was let in to your account by one that was signed in', new Date().toISOString()), 'device enrolled');
    req.log.info({ ip: req.ip, userId: user.id }, 'login succeeded by enrolment');
    return reply.header('Cache-Control', 'no-store').send({ ok: true, email: user.email, credential_id: `enrol:${id}`, wrapped_key: got.wrapped });
  });
}
