import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { getAccountsStore } from 'spine-core/store/index.js';
import { requireAuth, requireRecentAuth } from 'spine-core/routes/middleware.js';
import { SEAT_COOLDOWN_DAYS, SEAT_INVITES_WAITING, SEAT_INVITE_DAYS } from 'spine-core/billing/plans.js';
import { loadBillingConfig } from '../billing/config.js';
import { standingOf } from '../billing/seat.js';
import { windowLimiter } from '../rate-limit.js';
import { mailAfter, securityChangeMail } from '../notify.js';

/**
 * Seats: accounts that share one subscription (SECURITY.md **M-52**). The account that pays (the organizer) invites others with a link whose
 * secret is told to them and never kept (a hash of it is); an account that accepts holds a seat and has the plan's features and its one
 * allowance, and may keep its own people (profiles) up to the plan's total. A seat is not access: the organizer learns who holds the
 * seats and how many people the plan holds, nothing of what any account keeps, and to see a profile must be let in to it like anyone else
 * (M-49). Off with `SPINE_BILLING`, like the plans themselves.
 */
const ID = /^[A-Za-z0-9_-]{22}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const REFUSALS = {
  already_member: 'this account already holds a seat in a plan',
  is_organizer: 'other accounts share this account’s plan: they would be left without one',
  cooldown: 'this account left a plan lately and cannot take a seat in another one yet',
  full: 'every seat in this plan is taken',
} as const;

/** The limits per source of a request, for tests that make many from one address. */
export interface FamilyRouteOptions { perSource?: number; instanceWide?: number }

export async function familyRoutes(app: FastifyInstance, opts: FamilyRouteOptions = {}) {
  const store = () => getAccountsStore();
  const off = () => !loadBillingConfig().enabled;
  const limits = [
    app.rateLimit({ max: opts.perSource ?? 10, timeWindow: '10 minutes' }),
    windowLimiter({ max: opts.instanceWide ?? 2000, windowMs: 10 * 60 * 1000 }, () => 'instance', 'too many attempts, try again later'),
  ];

  // What the account page shows: whose plan this is, who holds the seats, how many people it holds.
  app.get('/api/family', { preHandler: requireAuth }, async (req, reply) => {
    if (off()) return reply.header('Cache-Control', 'no-store').send({ enabled: false });
    const now = new Date();
    const standing = await standingOf(store(), req.userId, now);
    if (!standing) return reply.status(401).send({ error: 'not authenticated' });
    const e = standing.entitlements;
    const profiles = { used: await store().family.profilesHeld(standing.holder), limit: e.profiles };
    if (standing.seat === 'member') {
      const organizer = await store().users.findById(standing.holder);
      return reply.header('Cache-Control', 'no-store').send({ enabled: true, role: 'member', organizer_email: organizer?.email ?? '', profiles, cooldown_days: SEAT_COOLDOWN_DAYS });
    }
    if (standing.seat === 'organizer') {
      const [members, invites] = await Promise.all([store().family.members(req.userId), store().family.invites(req.userId, now.toISOString())]);
      return reply.header('Cache-Control', 'no-store').send({ enabled: true, role: 'organizer', seats: { used: members.length + 1, limit: e.seats }, members, invites, profiles, invite_days: SEAT_INVITE_DAYS, cooldown_days: SEAT_COOLDOWN_DAYS });
    }
    // An account with a plan of its own and no one sharing it may still take a seat elsewhere, so it is told what it is: nothing, yet.
    return reply.header('Cache-Control', 'no-store').send({ enabled: true, role: 'none', profiles });
  });

  // --- The organizer ---------------------------------------------------------------------------------------------------------------

  // Makes an invitation. The secret is in the answer once; only its hash stays here.
  app.post('/api/family/invites', { preHandler: [requireAuth, requireRecentAuth, app.rateLimit({ max: opts.perSource ?? 20, timeWindow: '10 minutes' })] }, async (req, reply) => {
    if (off()) return reply.status(404).send({ error: 'this instance has no plans' });
    const now = new Date();
    const standing = await standingOf(store(), req.userId, now);
    if (!standing || standing.seat !== 'organizer') return reply.status(402).send({ error: 'sharing a plan is not part of the account’s plan', code: 'plan_required' });
    const [members, invites] = await Promise.all([store().family.members(req.userId), store().family.invites(req.userId, now.toISOString())]);
    if (members.length + 1 >= standing.entitlements.seats) return reply.status(409).send({ error: 'every seat in this plan is taken', code: 'full' });
    if (invites.length >= SEAT_INVITES_WAITING) return reply.status(409).send({ error: 'too many invitations are waiting; cancel one first', code: 'too_many' });
    const id = randomBytes(16).toString('base64url');
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + SEAT_INVITE_DAYS * 24 * 3600e3).toISOString();
    await store().family.invite(req.userId, { id, secretHash: sha256(secret), now: now.toISOString(), expiresAt });
    return reply.status(201).header('Cache-Control', 'no-store').send({ id, secret, expires_at: expiresAt });
  });

  app.delete<{ Params: { id: string } }>('/api/family/invites/:id', { preHandler: [requireAuth] }, async (req, reply) => {
    if (off()) return reply.status(404).send({ error: 'this instance has no plans' });
    if (!(await store().family.cancelInvite(req.userId, req.params.id))) return reply.status(404).send({ error: 'not found' });
    return reply.send({ ok: true });
  });

  // Ends a member's seat. Their records stay where they are; they have the plan of their own again.
  app.delete<{ Params: { id: string } }>('/api/family/members/:id', { preHandler: [requireAuth, requireRecentAuth, app.rateLimit({ max: opts.perSource ?? 20, timeWindow: '10 minutes' })] }, async (req, reply) => {
    if (off()) return reply.status(404).send({ error: 'this instance has no plans' });
    const member = (await store().family.members(req.userId)).find(m => m.id === req.params.id);
    if (!member || !(await store().family.remove(req.userId, member.id, new Date().toISOString()))) return reply.status(404).send({ error: 'not found' });
    mailAfter(req, member.id, securityChangeMail(member.email, 'Your seat in a shared plan was ended by the account that pays for it: your records are untouched and your account has its own plan again', new Date().toISOString()), 'seat removed');
    return reply.send({ ok: true });
  });

  // --- The one invited -------------------------------------------------------------------------------------------------------------

  // Who an invitation is from, before anything is taken. Signed in, limited like accepting, and changes nothing.
  app.post<{ Body: { id?: unknown; secret?: unknown } }>('/api/family/preview', { preHandler: [requireAuth, ...limits] }, async (req, reply) => {
    if (off()) return reply.status(404).send({ error: 'this instance has no plans' });
    const { id, secret } = req.body ?? {};
    if (typeof id !== 'string' || !ID.test(id) || typeof secret !== 'string' || !SECRET.test(secret)) return reply.status(400).send({ error: 'the invitation is not what it should be' });
    const found = await store().family.peek(req.userId, id, sha256(secret), new Date().toISOString());
    if (!found) return reply.status(404).send({ error: 'this invitation is not valid, or it has been used or has expired', code: 'invalid_code' });
    const organizer = await store().users.findById(found.organizer_id);
    return reply.header('Cache-Control', 'no-store').send({ organizer_email: organizer?.email ?? '', expires_at: found.expires_at, cooldown_days: SEAT_COOLDOWN_DAYS });
  });

  app.post<{ Body: { id?: unknown; secret?: unknown } }>('/api/family/join', { preHandler: [requireAuth, ...limits] }, async (req, reply) => {
    if (off()) return reply.status(404).send({ error: 'this instance has no plans' });
    const { id, secret } = req.body ?? {};
    if (typeof id !== 'string' || !ID.test(id) || typeof secret !== 'string' || !SECRET.test(secret)) return reply.status(400).send({ error: 'the invitation is not what it should be' });
    const now = new Date();
    const found = await store().family.peek(req.userId, id, sha256(secret), now.toISOString());
    if (!found) return reply.status(404).send({ error: 'this invitation is not valid, or it has been used or has expired', code: 'invalid_code' });
    // The plan must still be one with seats: an invitation outlives a cancelled subscription.
    const standing = await standingOf(store(), found.organizer_id, now);
    if (!standing || standing.seat !== 'organizer') return reply.status(402).send({ error: 'this plan has ended', code: 'plan_ended' });
    const result = await store().family.join(req.userId, id, sha256(secret), now.toISOString(), { seats: standing.entitlements.seats, cooldownDays: SEAT_COOLDOWN_DAYS });
    if (typeof result === 'string') {
      if (result === 'invalid') return reply.status(404).send({ error: 'this invitation is not valid, or it has been used or has expired', code: 'invalid_code' });
      return reply.status(409).send({ error: REFUSALS[result], code: result });
    }
    const [organizer, me] = await Promise.all([store().users.findById(result.organizer_id), store().users.findById(req.userId)]);
    if (organizer) mailAfter(req, organizer.id, securityChangeMail(organizer.email, `${me?.email ?? 'An account'} accepted your invitation and holds a seat in your plan`, now.toISOString()), 'seat taken');
    return reply.header('Cache-Control', 'no-store').send({ ok: true });
  });

  // Gives the seat up. The account keeps everything it has and has a plan of its own again.
  app.post('/api/family/leave', { preHandler: [requireAuth, app.rateLimit({ max: opts.perSource ?? 10, timeWindow: '10 minutes' })] }, async (req, reply) => {
    if (off()) return reply.status(404).send({ error: 'this instance has no plans' });
    const membership = await store().family.membership(req.userId);
    if (!membership || !(await store().family.leave(req.userId, new Date().toISOString()))) return reply.status(404).send({ error: 'there is no seat to give up' });
    const [organizer, me] = await Promise.all([store().users.findById(membership.organizer_id), store().users.findById(req.userId)]);
    if (organizer) mailAfter(req, organizer.id, securityChangeMail(organizer.email, `${me?.email ?? 'An account'} gave up its seat in your plan`, new Date().toISOString()), 'seat left');
    return reply.send({ ok: true });
  });
}
