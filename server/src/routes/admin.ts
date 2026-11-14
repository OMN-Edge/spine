import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getAccountsStore } from 'spine-core/store/index.js';
import { requireAuth, requireRecentAuth } from 'spine-core/routes/middleware.js';
import { logger } from 'spine-core/logger.js';
import { adminEmails, marketingEmails } from '../config.js';
import { approvedMail, deleteAccount, signInLink } from '../accounts.js';
import { getMailer } from '../mail/index.js';
import { dashboardOf, type Dashboard } from '../dashboard.js';
import { changeSetting, operatorSettings } from '../operator-settings.js';
import { changeFairUse, fairUseSections } from '../billing/fair-use-admin.js';
import { syncFairUse } from '../billing/fair-use.js';

/**
 * Approving the accounts that asked for one under `SPINE_REGISTRATION=approval`, from the app. Who may is `SPINE_ADMIN_EMAILS`, checked on every
 * request against the signed-in account's own address (never a value the request carries); the CLI (`approve-user`) needs none of this. A waiting
 * account holds no records, so refusing one deletes the account and nothing else.
 */
export interface AdminRouteOptions {
  /** Who may approve; defaults to `SPINE_ADMIN_EMAILS`, read at each request. Tests give their own. */
  admins?: () => Set<string>;
  /** Who may read the numbers: the administrators and the marketing role (`SPINE_MARKETING_EMAILS`). Tests give their own. */
  readers?: () => Set<string>;
}

export async function adminRoutes(app: FastifyInstance, opts: AdminRouteOptions = {}) {
  const admins = opts.admins ?? (() => adminEmails());
  // The marketing role reads the numbers and can change nothing.
  const readers = opts.readers ?? (() => new Set([...admins(), ...marketingEmails()]));

  const onlyAdmins = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await getAccountsStore().users.findById(req.userId);
    if (!user || !admins().has(user.email.toLowerCase())) return reply.status(403).send({ error: 'only an administrator can do this' });
  };

  // The numbers the operator and the marketing role look at: counts and the plans accounts are on, never a person (`dashboard.ts`). Worked out at most once a minute.
  let memo: { at: number; value: Dashboard } | null = null;
  // The numbers walk every account, so a second request while they are being worked out waits for the same answer instead of starting another walk.
  let working: Promise<Dashboard> | null = null;
  const onlyReaders = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await getAccountsStore().users.findById(req.userId);
    if (!user || !readers().has(user.email.toLowerCase())) return reply.status(403).send({ error: 'only an administrator can do this' });
  };
  app.get('/api/admin/dashboard', { preHandler: [requireAuth, onlyReaders] }, async (_req, reply) => {
    if (!memo || Date.now() - memo.at > 60_000) {
      working ??= dashboardOf(getAccountsStore()).finally(() => { working = null; });
      memo = { at: Date.now(), value: await working };
    }
    return reply.header('Cache-Control', 'no-store').send(memo.value);
  });

  // The settings the admin page changes (`operator-settings.ts`): the marketing role may read them, an administrator change them. A change is
  // checked against the setting's bounds and takes effect within half a minute everywhere, the numbers at once.
  app.get('/api/admin/settings', { preHandler: [requireAuth, onlyReaders] }, async (req, reply) => {
    const settings = await operatorSettings(getAccountsStore());
    const user = await getAccountsStore().users.findById(req.userId);
    return reply.header('Cache-Control', 'no-store').send({ settings: settings.map(({ fallbackOf: _f, ...s }) => s), can_edit: !!user && admins().has(user.email.toLowerCase()) });
  });
  app.put<{ Body: { key?: unknown; value?: unknown } }>('/api/admin/settings', { preHandler: [requireAuth, onlyAdmins, requireRecentAuth] }, async (req, reply) => {
    const problem = await changeSetting(getAccountsStore(), req.body?.key, req.body?.value ?? null, new Date().toISOString());
    if (problem) return reply.status(400).send({ error: problem });
    memo = null;
    logger.info('an operator setting was changed', { event: 'operator_setting', key: req.body?.key, account: req.userId });
    const settings = await operatorSettings(getAccountsStore());
    return reply.send({ settings: settings.map(({ fallbackOf: _f, ...s }) => s) });
  });

  // The hidden fair-use ceilings (`billing/fair-use-admin.ts`): an administrator only, for both reading and changing, because they are never shown to anyone
  // else, the marketing role included.
  app.get('/api/admin/fair-use', { preHandler: [requireAuth, onlyAdmins] }, async (_req, reply) => {
    await syncFairUse(getAccountsStore());
    return reply.header('Cache-Control', 'no-store').send({ sections: fairUseSections() });
  });
  app.put<{ Body: { path?: unknown; value?: unknown } }>('/api/admin/fair-use', { preHandler: [requireAuth, onlyAdmins, requireRecentAuth] }, async (req, reply) => {
    const problem = await changeFairUse(getAccountsStore(), req.body?.path, req.body?.value ?? null, new Date().toISOString());
    if (problem) return reply.status(400).send({ error: problem });
    logger.info('a fair-use ceiling was changed', { event: 'fair_use_change', path: req.body?.path, account: req.userId });
    return reply.send({ sections: fairUseSections() });
  });

  app.get('/api/admin/accounts', { preHandler: [requireAuth, onlyAdmins] }, async (_req, reply) => {
    const waiting = (await getAccountsStore().users.list()).filter(u => u.approved === 0);
    return reply.send({ pending: waiting.map(u => ({ id: u.id, email: u.email, created_at: u.created_at, email_confirmed: !!u.email_verified_at })) });
  });

  app.post<{ Params: { id: string } }>('/api/admin/accounts/:id/approve', { preHandler: [requireAuth, onlyAdmins, requireRecentAuth] }, async (req, reply) => {
    const store = getAccountsStore();
    const user = await store.users.findById(req.params.id);
    if (!user || !(await store.users.approve(user.id, new Date().toISOString()))) return reply.status(404).send({ error: 'no such account waiting for approval' });
    logger.info('an account was approved', { by: req.userId, userId: user.id });
    const mailer = getMailer();
    if (mailer.enabled) {
      mailer.send(approvedMail(user, signInLink())).catch(err => logger.error('could not send the approval mail', { err: err instanceof Error ? err.message : String(err) }));
    }
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string } }>('/api/admin/accounts/:id/refuse', { preHandler: [requireAuth, onlyAdmins, requireRecentAuth] }, async (req, reply) => {
    const user = await getAccountsStore().users.findById(req.params.id);
    // Only one that is still waiting: an approved account's records are its owner's, and are not the administrator's to remove.
    if (!user || user.approved !== 0) return reply.status(404).send({ error: 'no such account waiting for approval' });
    await deleteAccount(user.id);
    logger.info('an account request was refused', { by: req.userId, userId: user.id });
    return reply.send({ ok: true });
  });
}
