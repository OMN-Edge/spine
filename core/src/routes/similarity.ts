import type { HttpApp } from '../http.js';
import { getStore } from '../store/index.js';
import { requireAuth } from './middleware.js';
import { isSupportedLanguage } from '../languages.js';
import { keptNames, keptTexts, translateDocument, warmTranslations } from '../translation.js';
import { embeddingStatus, hybridSearch, relatedTo, scheduleSync } from '../similarity/index.js';

/** Related documents, and search by words and meaning together. Owner only; every call is scoped to the signed-in user. */
export async function similarityRoutes(app: HttpApp) {
  app.addHook('preHandler', requireAuth);

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
    // with translation by a model off this still reads what is kept (the sample records'), and asks for nothing more
    if (isSupportedLanguage(language)) {
      const missing: string[] = [];
      titled = [];
      for (const r of related) {
        const done = await translateDocument(req.userId, r.id, language, { cachedOnly: true });
        if (done === null || done === 'not_found') missing.push(r.id);
        titled.push({ ...r, translated_title: done && done !== 'not_found' && done.status !== 'same' && done.status !== 'off' ? done.title : null });
      }
      if (missing.length > 0) { pending = true; warmTranslations(req.userId, missing, language); }
    }
    return reply.header('Cache-Control', 'no-store').send({
      related: titled,
      translation_pending: pending,
      meaning: { enabled: status.enabled, ready: status.enabled && status.embedded >= status.documents },
    });
  });

  // Titles and summaries of some of the owner's documents in a language, for lists that name documents (the timeline, the chat's sources). Only what is
  // kept and still matches the document's own text comes back at once; the rest start translating in the background and `pending` tells the page to ask
  // again shortly. The model is never asked from here, and a list's cost is one row of each kind for each id.
  app.get<{ Querystring: { ids?: string; lang?: string; warm?: string } }>('/api/translations/titles', async (req, reply) => {
    const language = req.query.lang;
    const ids = [...new Set((req.query.ids ?? '').split(',').map(x => x.trim()).filter(Boolean))].slice(0, 60);
    if (!isSupportedLanguage(language) || ids.length === 0) return reply.header('Cache-Control', 'no-store').send({ titles: {}, summaries: {}, pending: false });
    const titles: Record<string, string | null> = {};
    const summaries: Record<string, string> = {};
    const missing: string[] = [];
    for (const [id, kept] of await keptTexts(req.userId, ids, language)) {
      if (kept.state === 'ready') {
        titles[id] = kept.title;
        if (kept.summary !== null) summaries[id] = kept.summary;
        if (kept.stale) missing.push(id);
      } else if (kept.state === 'same') titles[id] = null;
      else if (kept.state === 'missing') missing.push(id);
      // `not_found` (not the caller's, or gone: the same as an id that never existed) and `off` (nothing kept, nothing to ask) give nothing.
    }
    // `warm=0`: a list of every document asks for what is kept only, so looking at it does not start the translation of an archive.
    const warm = req.query.warm !== '0';
    if (warm && missing.length > 0) warmTranslations(req.userId, missing, language);
    return reply.header('Cache-Control', 'no-store').send({ titles, summaries, pending: warm && missing.length > 0 });
  });

  // Specialties and test names in a language, as kept (`name_translations`), for the pages that list them across documents; what is not kept yet is translated in
  // the background and `pending` tells the page to ask again.
  app.get<{ Querystring: { lang?: string } }>('/api/translations/names', async (req, reply) => {
    const language = req.query.lang;
    if (!isSupportedLanguage(language)) return reply.header('Cache-Control', 'no-store').send({ specialties: {}, tests: {}, pending: false });
    return reply.header('Cache-Control', 'no-store').send(await keptNames(req.userId, language));
  });

  // The documents that match some words, or mean something like them, merged by rank.
  app.get<{ Querystring: { q?: string; limit?: string } }>('/api/search/hybrid', async (req, reply) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 500) : '';
    if (!q) return reply.status(400).send({ error: 'q is required' });
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit ?? '30', 10) || 30, 1), 100);
    const hits = await hybridSearch(req.userId, q, limit);
    return reply.header('Cache-Control', 'no-store').send(hits.map(h => ({ ...h.doc, via: h.via })));
  });
}
