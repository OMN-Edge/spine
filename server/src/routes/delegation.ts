import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { getAccountsStore } from 'spine-core/store/index.js';
import type { DelegationRecord, DelegationRole } from 'spine-core/store/types.js';
import { requireAuth, requireRecentAuth } from 'spine-core/routes/middleware.js';
import { vaultLimits } from '../config.js';
import { accountEntitlements } from '../billing/entitlements.js';
import { windowLimiter } from '../rate-limit.js';
import { mailAfter, securityChangeMail } from '../notify.js';
import { endOtherSessions } from '../sessions.js';
import { type SessionData } from '../session-auth.js';
import { OBJECT_ID, writeObject } from '../vault-files.js';
import { sealed } from '../vault-keys.js';
import { deleteObject, getObject, listObjects, putObject, type ObjectReq, type ObjectScope } from './vault.js';

/**
 * Letting another account into one profile (FR-PRF-02, SECURITY.md **M-49**). The owner's device seals the profile key under a key a one-time
 * code makes and leaves it here with an id the code also makes; the code is told to the other person, never sent. The other person's
 * device collects it, opens it, and seals the profile key to its own key pair for the grant. From then on it reads (and, as a guardian,
 * writes) that one profile's objects through `/api/delegated/:grant/…`, which are the vault's own handlers with the profile fixed. The
 * server holds sealed keys it cannot open and decides only who may reach which profile; ending a grant is followed by a rotation of the
 * profile key (`POST /api/vault/profiles/:id/rotate`) so a former delegate's key opens nothing that is stored later.
 */
export const INVITE_MS = 7 * 24 * 60 * 60 * 1000;
const ID = /^[A-Za-z0-9_-]{43}$/;
const PROOF = /^[A-Za-z0-9_-]{43}$/;
const HEX = /^[0-9a-f]{64}$/;
const MAX_INVITES = 10;
const MAX_GRANTS_PER_PROFILE = 6;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const roleOf = (r: unknown): DelegationRole | null => (r === 'guardian' || r === 'viewer' || r === 'self' ? r : null);

export interface DelegationRouteOptions {
  claimsPerSource?: number;
  instanceWide?: number;
}

export async function delegationRoutes(app: FastifyInstance, opts: DelegationRouteOptions = {}) {
  // Ciphertext arrives as the request body, as it is, as for the vault's own routes.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: vaultLimits().objectBytes }, (_req, body, done) => done(null, body));
  const repo = () => getAccountsStore().delegations;
  const sessionOf = (req: FastifyRequest) => req.session as unknown as SessionData;

  // --- The owner ----------------------------------------------------------------------------------------------------------

  app.post<{ Body: { id?: unknown; profile_id?: unknown; role?: unknown; wrapped?: unknown; proof_hash?: unknown } }>(
    '/api/delegations/invites',
    { preHandler: [requireAuth, requireRecentAuth, app.rateLimit({ max: 20, timeWindow: '10 minutes' })] },
    async (req, reply) => {
      const { id, profile_id: profileId, role: rawRole, wrapped, proof_hash: proofHash } = req.body ?? {};
      const role = roleOf(rawRole);
      if (typeof id !== 'string' || !ID.test(id) || typeof profileId !== 'string' || !OBJECT_ID.test(profileId) || !role || !sealed(wrapped, 90, 200) || typeof proofHash !== 'string' || !HEX.test(proofHash)) {
        return reply.status(400).send({ error: 'the invitation is not what it should be' });
      }
      const plan = await accountEntitlements(req.userId);
      if (plan && !plan.delegation) return reply.status(402).send({ error: 'letting another account in is not part of the account’s plan', code: 'plan_required' });
      const store = getAccountsStore();
      const profile = await store.vault.get(req.userId, profileId);
      if (!profile || profile.kind !== 'profile' || profile.deleted) return reply.status(404).send({ error: 'not found' });
      const now = new Date();
      if ((await repo().invites(req.userId, now.toISOString())).length >= MAX_INVITES) return reply.status(409).send({ error: 'too many invitations are waiting; cancel one first', code: 'too_many' });
      if ((await repo().ownedBy(req.userId)).filter(g => g.profile_id === profileId).length >= MAX_GRANTS_PER_PROFILE) return reply.status(409).send({ error: 'this person already has as many people let in as is allowed', code: 'too_many' });
      // The person themselves: one, and only one account at a time (a second invitation would be for someone else).
      if (role === 'self' && ((await repo().ownedBy(req.userId)).some(g => g.profile_id === profileId && g.role === 'self') || (await repo().invites(req.userId, now.toISOString())).some(i => i.profile_id === profileId && i.role === 'self'))) {
        return reply.status(409).send({ error: 'this person already has an account of their own, or an invitation for one is waiting', code: 'self_exists' });
      }
      await repo().invite(req.userId, { id, profileId, role, wrapped, proofHash, now: now.toISOString(), expiresAt: new Date(now.getTime() + INVITE_MS).toISOString() });
      return reply.status(201).header('Cache-Control', 'no-store').send({ ok: true, expires_at: new Date(now.getTime() + INVITE_MS).toISOString() });
    },
  );

  app.delete<{ Params: { id: string } }>('/api/delegations/invites/:id', { preHandler: [requireAuth] }, async (req, reply) => {
    if (!ID.test(req.params.id) || !(await repo().cancelInvite(req.userId, req.params.id))) return reply.status(404).send({ error: 'not found' });
    return reply.send({ ok: true });
  });

  // Who may reach what: the grants of the owner's profiles (with the address of whoever was let in), the invitations still waiting, and the
  // grants made to this account (with the key sealed to it, which only this account's keys open).
  app.get('/api/delegations', { preHandler: [requireAuth] }, async (req, reply) => {
    const now = new Date().toISOString();
    const [owned, invites, received] = await Promise.all([repo().ownedBy(req.userId), repo().invites(req.userId, now), repo().madeTo(req.userId)]);
    return reply.header('Cache-Control', 'no-store').send({
      owned: owned.map(g => ({ id: g.id, profile_id: g.profile_id, delegate_email: g.delegate_email, delegate_public_key: g.delegate_public_key, role: g.role, state: g.state, created_at: g.created_at })),
      invites,
      received: received.map(g => ({ id: g.id, owner_email: g.owner_email, profile_id: g.profile_id, role: g.role, state: g.state, wrapped_key: g.wrapped_key })),
    });
  });

  // Pause or resume a grant (an owner's call: a paused grant opens nothing and keeps its key).
  app.post<{ Params: { id: string }; Body: { state?: unknown } }>('/api/delegations/:id/state', { preHandler: [requireAuth, app.rateLimit({ max: 60, timeWindow: '10 minutes' })] }, async (req, reply) => {
    const state = req.body?.state;
    if (state !== 'active' && state !== 'paused') return reply.status(400).send({ error: 'state must be active or paused' });
    const grant = await repo().get(req.params.id);
    if (!grant || grant.owner_user_id !== req.userId || grant.state === 'revoked' || grant.state === 'pending') return reply.status(404).send({ error: 'not found' });
    await repo().setState(req.userId, grant.id, state, new Date().toISOString());
    return reply.send({ ok: true, profile_id: grant.profile_id });
  });

  // Ends a grant. It changes who can open a profile, so the password is asked again, as for the other settings that do. The answer names the
  // profile, because its key must be replaced next (the rotation route below).
  app.post<{ Params: { id: string } }>('/api/delegations/:id/revoke', { preHandler: [requireAuth, requireRecentAuth, app.rateLimit({ max: 60, timeWindow: '10 minutes' })] }, async (req, reply) => {
    const grant = await repo().get(req.params.id);
    if (!grant || grant.owner_user_id !== req.userId || grant.state === 'revoked') return reply.status(404).send({ error: 'not found' });
    await repo().setState(req.userId, grant.id, 'revoked', new Date().toISOString());
    return reply.send({ ok: true, profile_id: grant.profile_id });
  });

  // The delegate gives the access up. The owner is told to replace the key the next time they sign in (the owner's page asks).
  app.delete<{ Params: { id: string } }>('/api/delegations/:id', { preHandler: [requireAuth] }, async (req, reply) => {
    const grant = await repo().get(req.params.id);
    if (!grant || grant.delegate_user_id !== req.userId || !(await repo().leave(req.userId, grant.id, new Date().toISOString()))) return reply.status(404).send({ error: 'not found' });
    return reply.send({ ok: true });
  });

  // --- The one let in -----------------------------------------------------------------------------------------------------

  const limits = [
    app.rateLimit({ max: opts.claimsPerSource ?? 10, timeWindow: '10 minutes' }),
    windowLimiter({ max: opts.instanceWide ?? 2000, windowMs: 10 * 60 * 1000 }, () => 'instance', 'too many attempts, try again later'),
  ];

  // Spends an invitation: the grant starts pending and the sealed profile key is handed over once. The code is never here, only the id it
  // makes and a proof it makes, of which the server held only a hash.
  app.post<{ Body: { id?: unknown; proof?: unknown } }>('/api/delegations/claim', { preHandler: [requireAuth, ...limits] }, async (req, reply) => {
    const { id, proof } = req.body ?? {};
    if (typeof id !== 'string' || !ID.test(id) || typeof proof !== 'string' || !PROOF.test(proof)) return reply.status(400).send({ error: 'the code is not what it should be' });
    const claimed = await repo().claim(req.userId, id, sha256(proof), new Date().toISOString(), randomUUID());
    if (!claimed) return reply.status(404).send({ error: 'this code is not valid, or it has been used or has expired', code: 'invalid_code' });
    const owner = await getAccountsStore().users.findById(claimed.grant.owner_user_id);
    if (owner) mailAfter(req, owner.id, securityChangeMail(owner.email, 'Someone accepted your invitation and was given access to a profile', new Date().toISOString()), 'delegation accepted');
    return reply.header('Cache-Control', 'no-store').send({ grant: { id: claimed.grant.id, profile_id: claimed.grant.profile_id, role: claimed.grant.role, owner_email: owner?.email ?? '' }, wrapped: claimed.wrapped });
  });

  app.put<{ Params: { id: string }; Body: { wrapped_key?: unknown } }>('/api/delegations/:id/key', { preHandler: [requireAuth, app.rateLimit({ max: 30, timeWindow: '10 minutes' })] }, async (req, reply) => {
    if (!sealed(req.body?.wrapped_key, 40, 400)) return reply.status(400).send({ error: 'the sealed key is not what it should be' });
    if (!(await repo().complete(req.userId, req.params.id, req.body.wrapped_key, new Date().toISOString()))) return reply.status(404).send({ error: 'not found' });
    return reply.send({ ok: true });
  });

  // --- The profile's objects, for a delegate ------------------------------------------------------------------------------

  /** The grant the request names, if it is this account's and live; the owner's vault and the profile it may reach. */
  const scopeOf = async (req: FastifyRequest<{ Params: { grant: string } }>): Promise<{ ownerId: string; scope: ObjectScope; grant: DelegationRecord } | null> => {
    const grant = await repo().get(req.params.grant);
    if (!grant || grant.delegate_user_id !== req.userId || grant.state !== 'active') return null;
    return { ownerId: grant.owner_user_id, scope: { profileId: grant.profile_id, write: grant.role !== 'viewer' }, grant };
  };
  const gate = [requireAuth, app.rateLimit({ max: 600, timeWindow: '1 minute' })];

  app.get<{ Params: { grant: string }; Querystring: { since?: string } }>('/api/delegated/:grant/objects', { preHandler: gate }, async (req, reply) => {
    const s = await scopeOf(req);
    if (!s) return reply.status(404).send({ error: 'not found' });
    return listObjects(req, reply, s.ownerId, s.scope);
  });
  app.get<{ Params: { grant: string; id: string } }>('/api/delegated/:grant/objects/:id', { preHandler: gate }, async (req, reply) => {
    const s = await scopeOf(req);
    if (!s) return reply.status(404).send({ error: 'not found' });
    return getObject(req as unknown as ObjectReq, reply, s.ownerId, s.scope);
  });
  app.put<{ Params: { grant: string; id: string }; Body: Buffer }>('/api/delegated/:grant/objects/:id', { preHandler: gate }, async (req, reply) => {
    const s = await scopeOf(req);
    if (!s) return reply.status(404).send({ error: 'not found' });
    return putObject(req as unknown as ObjectReq, reply, s.ownerId, s.scope);
  });
  app.delete<{ Params: { grant: string; id: string }; Querystring: { base?: string } }>('/api/delegated/:grant/objects/:id', { preHandler: gate }, async (req, reply) => {
    const s = await scopeOf(req);
    if (!s) return reply.status(404).send({ error: 'not found' });
    return deleteObject(req as unknown as ObjectReq, reply, s.ownerId, s.scope);
  });

  // --- Replacing a profile's key ------------------------------------------------------------------------------------------

  // After access was ended (or a person leaves), the owner's device makes a new profile key and seals again what it protects: every data key
  // of the profile, the profile record itself, and the key each remaining grant holds. All of it in one step. The owner's other sign-ins end,
  // so no device goes on writing under the old key. Content a former delegate already read cannot be recalled.
  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 8 * 1024 * 1024 }, (_req, body, done) => {
    try { done(null, body === '' ? {} : JSON.parse(body as string)); } catch (err) { done(err as Error, undefined); }
  });
  app.post<{ Params: { profile: string }; Body: { profile_wrapped?: unknown; profile_body?: unknown; objects?: unknown; grants?: unknown } }>(
    '/api/vault/profiles/:profile/rotate',
    { preHandler: [requireAuth, requireRecentAuth, app.rateLimit({ max: 10, timeWindow: '10 minutes' })] },
    async (req, reply) => {
      const { profile_wrapped: profileWrapped, profile_body: body, objects, grants } = req.body ?? {};
      const asList = (v: unknown) => (Array.isArray(v) && v.length <= 100_000 ? (v as Array<{ id?: unknown; wrapped_key?: unknown }>) : null);
      const objectList = asList(objects);
      const grantList = asList(grants);
      if (!OBJECT_ID.test(req.params.profile) || !sealed(profileWrapped, 90, 200) || typeof body !== 'string' || !/^[A-Za-z0-9_-]{20,}$/.test(body) || !objectList || !grantList
        || ![...objectList, ...grantList].every(o => typeof o.id === 'string' && sealed(o.wrapped_key, 90, 200))) {
        return reply.status(400).send({ error: 'the new keys are not in the expected form' });
      }
      const bytes = Buffer.from(body, 'base64url');
      const now = new Date().toISOString();
      const store = getAccountsStore();
      // Every active or paused grant of the profile must come with its new key, and no other: a grant left out could no longer open the profile.
      const held = (await store.delegations.ownedBy(req.userId)).filter(g => g.profile_id === req.params.profile && (g.state === 'active' || g.state === 'paused')).map(g => g.id).sort();
      const given = grantList.map(g => g.id as string).sort();
      if (held.length !== given.length || held.some((id, i) => id !== given[i])) return reply.status(409).send({ error: 'the grants changed; try again', code: 'grants_changed' });
      const done = await store.vault.rotateProfile(req.userId, req.params.profile, { profileWrapped, profileSize: bytes.length, objects: objectList.map(o => ({ id: o.id as string, wrappedKey: o.wrapped_key as string })) }, now,
        () => writeObject(req.userId, req.params.profile, bytes));
      if (!done) return reply.status(409).send({ error: 'the vault changed; try again', code: 'conflict' });
      await store.delegations.rewrap(req.userId, req.params.profile, grantList.map(g => ({ id: g.id as string, wrappedKey: g.wrapped_key as string })), now);
      await endOtherSessions(req.userId, sessionOf(req));
      return reply.send({ seq: done.seq });
    },
  );
}
