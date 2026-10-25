import type { FastifyInstance } from 'fastify';
import { getAccountsStore } from 'spine-core/store/index.js';
import { deleteAccount } from '../accounts.js';
import { HEALTH_CONSENT_VERSION, LEGAL_DOCS, TERMS_VERSION, consentNeeded, legalText, type LegalDoc } from '../legal.js';
import { requireAuth, requireRecentAuth } from 'spine-core/routes/middleware.js';
import { logger } from 'spine-core/logger.js';

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

  // Leaving (GDPR Art. 17, FR-EXP-02): the account, its records and the files, at once. Asks for the password again and for the
  // address typed out, so a stolen session cookie cannot do it in one request and a slip of the finger cannot do it at all.
  app.post<{ Body: { confirm?: unknown } }>('/api/account/delete', { preHandler: [requireAuth, requireRecentAuth] }, async (req, reply) => {
    const user = await getAccountsStore().users.findById(req.userId);
    if (!user) return reply.status(401).send({ error: 'not authenticated' });
    if (typeof req.body?.confirm !== 'string' || req.body.confirm.trim().toLowerCase() !== user.email.toLowerCase()) {
      return reply.status(400).send({ error: 'type your email address to confirm' });
    }
    const summary = await deleteAccount(req.userId);
    logger.info('an account was deleted by its owner', { objects: summary.objects });
    await req.session.destroy();
    return reply.send({ deleted: true, ...summary });
  });
}
