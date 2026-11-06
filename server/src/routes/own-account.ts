import type { FastifyInstance } from 'fastify';
import { getAccountsStore } from 'spine-core/store/index.js';
import { deleteAccount, wipeAccount } from '../accounts.js';
import { AUTH_VALUE, parseVaultKeys } from '../vault-keys.js';
import { mailAfter, securityChangeMail } from '../notify.js';
import { HEALTH_CONSENT_VERSION, LEGAL_DOCS, TERMS_VERSION, consentNeeded, legalText, type LegalDoc } from '../legal.js';
import { requireAuth, requireRecentAuth } from 'spine-core/routes/middleware.js';
import { logger } from 'spine-core/logger.js';
import { subscriptionEntitles } from 'spine-core/billing/plans.js';

export async function ownAccountRoutes(app: FastifyInstance) {
  // The texts a person agrees to. Public: they are read before an account exists.
  app.get<{ Params: { doc: string } }>('/api/legal/:doc', async (req, reply) => {
    const doc = req.params.doc as LegalDoc;
    const text = LEGAL_DOCS.includes(doc) ? legalText(doc) : null;
    if (!text) return reply.status(404).send({ error: 'not found' });
    return reply.header('Cache-Control', 'public, max-age=300').send({ doc, ...text });
  });

  // Agreeing, for an account that has not yet (the operator made it, or the texts changed). Two separate acts: the use of health data
  // and the terms, each given in full or not at all; nothing is recorded on a half answer.
  app.post<{ Body: { health_data?: unknown; terms?: unknown } }>('/api/account/consent', { preHandler: requireAuth }, async (req, reply) => {
    const user = await getAccountsStore().users.findById(req.userId);
    if (!user) return reply.status(401).send({ error: 'not authenticated' });
    const need = consentNeeded(user);
    const { health_data: health, terms } = req.body ?? {};
    if ((need.health && health !== true) || (need.terms && terms !== true)) {
      return reply.status(400).send({ error: 'consent to the use of your health data and acceptance of the terms are both needed, and given separately' });
    }
    await getAccountsStore().users.recordConsent(req.userId, { healthVersion: HEALTH_CONSENT_VERSION, termsVersion: TERMS_VERSION }, new Date().toISOString());
    return reply.send({ ok: true });
  });

  // Whether an emailed link may recover the account (SECURITY.md S-38). On unless the owner turns it off. Off, no recovery mail is sent and a
  // link cannot start the records over or replace the keys without the recovery kit's signature, so it can only be turned off once the vault has
  // the verifier that signature is checked against: off before that would leave the kit with nothing to prove.
  app.put<{ Body: { enabled?: unknown } }>('/api/account/email-recovery', { preHandler: [requireAuth, requireRecentAuth, app.rateLimit({ max: 10, timeWindow: '10 minutes' })] }, async (req, reply) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') return reply.status(400).send({ error: 'enabled must be true or false' });
    const store = getAccountsStore();
    const user = await store.users.findById(req.userId);
    if (!user) return reply.status(401).send({ error: 'not authenticated' });
    if (!enabled && !(await store.vault.getKeys(req.userId))?.reset_verifier) {
      return reply.status(409).send({ error: 'this vault has no reset verifier, so it cannot be recovered with the recovery kit alone', code: 'verifier_missing' });
    }
    await store.users.setEmailRecovery(req.userId, enabled);
    mailAfter(req, user.id, securityChangeMail(user.email, enabled ? 'Recovery of your account by email was turned on' : 'Recovery of your account by email was turned off', new Date().toISOString()), 'email recovery setting');
    req.log.info({ userId: req.userId, enabled }, 'email recovery setting changed');
    return reply.send({ ok: true, email_recovery: enabled });
  });

  // Leaving (GDPR Art. 17, FR-EXP-02): the account, its records and the files, at once. Asks for the password again and for the
  // address typed out, so a stolen session cookie cannot do it in one request and a slip of the finger cannot do it at all.
  app.post<{ Body: { confirm?: unknown } }>('/api/account/delete', { preHandler: [requireAuth, requireRecentAuth] }, async (req, reply) => {
    const user = await getAccountsStore().users.findById(req.userId);
    if (!user) return reply.status(401).send({ error: 'not authenticated' });
    if (typeof req.body?.confirm !== 'string' || req.body.confirm.trim().toLowerCase() !== user.email.toLowerCase()) {
      return reply.status(400).send({ error: 'type your email address to confirm' });
    }
    // Leaving does not stop a subscription at the payment provider, and a person who left would go on being charged: cancel it first.
    const sub = await getAccountsStore().billing.get(req.userId);
    if (sub?.provider === 'paddle' && !sub.cancel_scheduled && subscriptionEntitles(sub, new Date())) {
      return reply.status(409).send({ error: 'cancel the subscription first (billing, manage), then delete the account', code: 'subscription_active' });
    }
    const summary = await deleteAccount(req.userId);
    logger.info('an account was deleted by its owner', { objects: summary.objects });
    await req.session.destroy();
    return reply.send({ deleted: true, ...summary });
  });

  // Starting over: every record, file, share and the old vault go, the account stays, with the new, empty vault the device made
  // (`wipeAccount`). Asked for as a deletion is, because nothing of it can be brought back; every device is signed out, this one too, and
  // the next sign-in is with the new master password. The owner is told by mail, as of a password change.
  app.post<{ Body: { confirm?: unknown; auth_value?: unknown; keys?: unknown } }>('/api/account/wipe', { preHandler: [requireAuth, requireRecentAuth] }, async (req, reply) => {
    const user = await getAccountsStore().users.findById(req.userId);
    if (!user) return reply.status(401).send({ error: 'not authenticated' });
    if (typeof req.body?.confirm !== 'string' || req.body.confirm.trim().toLowerCase() !== user.email.toLowerCase()) {
      return reply.status(400).send({ error: 'type your email address to confirm' });
    }
    const keys = parseVaultKeys(req.body?.keys);
    const authValue = req.body?.auth_value;
    if (!keys || typeof authValue !== 'string' || !AUTH_VALUE.test(authValue)) {
      return reply.status(400).send({ error: 'the new keys are not in the expected form' });
    }
    const summary = await wipeAccount(req.userId, { authValue, keys });
    logger.info('an account was wiped by its owner', { objects: summary.objects });
    mailAfter(req, user.id, securityChangeMail(user.email, 'Your records were erased and your account started over with a new password', new Date().toISOString()), 'wipe');
    await req.session.destroy();
    return reply.send({ wiped: true, ...summary });
  });
}
