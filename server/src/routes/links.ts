import type { FastifyInstance } from 'fastify';
import { getStore } from '../store/index.js';
import { LINK_KINDS, type LinkKind } from '../store/types.js';
import { requireAuth } from './middleware.js';
import { linkingEnabled } from '../config.js';
import { chainOf, isLinking, scheduleLinking } from '../linking/index.js';

const isKind = (v: unknown): v is LinkKind => typeof v === 'string' && (LINK_KINDS as readonly string[]).includes(v);
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64;

/** Care chains: the documents around one, and the owner's say over the links. Owner only; never on a share link. */
export async function linkRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // The chain around a document. `searching` tells the page to ask again shortly.
  app.get<{ Params: { id: string } }>('/api/documents/:id/chain', async (req, reply) => {
    const chain = await chainOf(req.userId, req.params.id);
    if (!chain) return reply.status(404).send({ error: 'not found' });
    return reply.header('Cache-Control', 'no-store').send({ enabled: linkingEnabled(), searching: isLinking(req.userId), ...chain });
  });

  // The owner adds a link by hand: confirmed at once, and it stays even if automatic linking is off.
  app.post<{ Body: { from?: unknown; to?: unknown; kind?: unknown } }>('/api/document-links', async (req, reply) => {
    const { from, to, kind } = req.body ?? {};
    if (!isId(from) || !isId(to) || !isKind(kind)) return reply.status(400).send({ error: 'from, to and kind are required' });
    const store = getStore();
    let [first, second] = [from, to];
    if (kind === 'same_episode') {
      // An episode has no direction: store it once, earlier first, so the pair cannot exist twice.
      const [a, b] = await Promise.all([store.documents.findFor(req.userId, from), store.documents.findFor(req.userId, to)]);
      if (a && b && ((a.doc_date && b.doc_date) ? a.doc_date > b.doc_date : a.id > b.id)) [first, second] = [to, from];
    }
    const added = await store.links.add(req.userId, { from_document_id: first, to_document_id: second, kind, source: 'owner', state: 'confirmed', reason: null }, new Date().toISOString());
    if (!added) return reply.status(404).send({ error: 'not found' });
    return reply.status(201).send({ ok: true });
  });

  // Confirm or dismiss a link, usually a suggestion. A dismissed pair is not suggested again.
  app.post<{ Body: { from?: unknown; to?: unknown; kind?: unknown; state?: unknown } }>('/api/document-links/state', async (req, reply) => {
    const { from, to, kind, state } = req.body ?? {};
    if (!isId(from) || !isId(to) || !isKind(kind) || (state !== 'confirmed' && state !== 'dismissed')) {
      return reply.status(400).send({ error: 'from, to, kind and state (confirmed or dismissed) are required' });
    }
    if (!(await getStore().links.setState(req.userId, from, to, kind, state))) return reply.status(404).send({ error: 'not found' });
    return reply.send({ ok: true });
  });

  // Look for links for this document now, in the background. Costs a model call, so it is limited.
  app.post<{ Params: { id: string } }>('/api/documents/:id/chain/refresh', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!(await getStore().documents.findFor(req.userId, req.params.id))) return reply.status(404).send({ error: 'not found' });
    if (!linkingEnabled()) return reply.status(409).send({ error: 'looking for links is switched off' });
    scheduleLinking(req.userId, [req.params.id], 0);
    return reply.status(202).send({ ok: true });
  });
}
