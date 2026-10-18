import type { FastifyInstance } from 'fastify';
import { getStore } from '../store/index.js';
import { requireAuth } from './middleware.js';
import { translationEnabled } from '../config.js';
import { isSupportedLanguage } from '../languages.js';
import { translateDocument, warmTranslations } from '../translation.js';
import { embeddingStatus, hybridSearch, relatedTo, scheduleSync } from '../similarity/index.js';

/** Related documents, and search by words and meaning together. Owner only; every call is scoped to the signed-in user. */
export async function similarityRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // How much of the archive can be found by meaning yet. Asking also starts catching up, in the background.
  app.get('/api/similarity/status', async (req, reply) => {
    const status = await embeddingStatus(req.userId);
    if (status.enabled && status.embedded < status.documents) scheduleSync(req.userId);
    return reply.header('Cache-Control', 'no-store').send(status);
  });

  // Documents related to this one, and why: the same test or doctor, and what reads alike.
  app.get<{ Params: { id: string }; Querystring: { lang?: string } }>('/api/documents/:id/related', async (req, reply) => {
    if (!(await getStore().documents.findFor(req.userId, req.params.id))) return reply.status(404).send({ error: 'not found' });
    const status = await embeddingStatus(req.userId);
    if (status.enabled && status.embedded < status.documents) scheduleSync(req.userId);
    const related = await relatedTo(req.userId, req.params.id);

    // In a language: a title already translated comes with the document; the rest start translating in the background
    // (nothing is recorded on the documents) and `translation_pending` tells the page to ask again shortly.
    const language = req.query.lang;
    let titled: Array<(typeof related)[number] & { translated_title: string | null }> = related.map(r => ({ ...r, translated_title: null }));
    let pending = false;
    if (isSupportedLanguage(language) && translationEnabled()) {
      const missing: string[] = [];
      titled = [];
      for (const r of related) {
        const done = await translateDocument(req.userId, r.id, language, { cachedOnly: true });
        if (done === null || done === 'not_found') missing.push(r.id);
        titled.push({ ...r, translated_title: done && done !== 'not_found' && done.status !== 'same' ? done.title : null });
      }
      if (missing.length > 0) { pending = true; warmTranslations(req.userId, missing, language); }
    }
    return reply.header('Cache-Control', 'no-store').send({
      related: titled,
      translation_pending: pending,
      meaning: { enabled: status.enabled, ready: status.enabled && status.embedded >= status.documents },
    });
  });

  // The documents that match some words, or mean something like them, merged by rank.
  app.get<{ Querystring: { q?: string; limit?: string } }>('/api/search/hybrid', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 500) : '';
    if (!q) return reply.status(400).send({ error: 'q is required' });
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit ?? '30', 10) || 30, 1), 100);
    const hits = await hybridSearch(req.userId, q, limit);
    return reply.header('Cache-Control', 'no-store').send(hits.map(h => ({ ...h.doc, via: h.via })));
  });
}
