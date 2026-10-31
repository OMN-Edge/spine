import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getAccountsStore } from 'spine-core/store/index.js';
import { requireAuth, requireRecentAuth } from 'spine-core/routes/middleware.js';
import { logger } from 'spine-core/logger.js';
import { adminEmails } from '../config.js';
import { approvedMail, deleteAccount, signInLink } from '../accounts.js';
import { getMailer } from '../mail/index.js';

/**
 * Approving the accounts that asked for one under `SPINE_REGISTRATION=approval`, from the app. Who may is `SPINE_ADMIN_EMAILS`, checked on every
 * request against the signed-in account's own address (never a value the request carries); the CLI (`approve-user`) needs none of this. A waiting
 * account holds no records, so refusing one deletes the account and nothing else.
 */
export interface AdminRouteOptions {
  /** Who may approve; defaults to `SPINE_ADMIN_EMAILS`, read at each request. Tests give their own. */
  admins?: () => Set<string>;
}

export async function adminRoutes(app: FastifyInstance, opts: AdminRouteOptions = {}) {
  const admins = opts.admins ?? (() => adminEmails());

  const onlyAdmins = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await getAccountsStore().users.findById(req.userId);
    if (!user || !admins().has(user.email.toLowerCase())) return reply.status(403).send({ error: 'only an administrator can do this' });
  };

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
      mailer.send(approvedMail(user.email, signInLink())).catch(err => logger.error('could not send the approval mail', { err: err instanceof Error ? err.message : String(err) }));
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
