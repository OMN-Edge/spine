import { fileSystem } from '../files.js';
import type { HttpApp, HttpRequest, HttpReply } from '../http.js';
import { sharedChainOf } from '../linking/index.js';
import { relatedTo } from '../similarity/index.js';
import { extname } from 'path';
import { getStore, type ResolvedShareLink, type Store } from '../store/index.js';
import { resolveStoredScope, ScopeError } from '../share-scope.js';
import { isSupportedLanguage, SUPPORTED_LANGUAGES } from '../languages.js';
import { translateDocument, warmTranslations } from '../translation.js';
import { translationEnabled } from '../config.js';
import { buildSeries } from './trends.js';
import { streamReply } from './ndjson.js';
import { chatEnabled, landingUrl, publicUrl } from '../config.js';
import { getChatLlm } from '../llm/index.js';
import { askSharedAgent } from '../chat/agent.js';
import { MAX_QUESTION, MAX_TURN, MAX_TURNS, trimHistory } from '../chat/index.js';
import { logger } from '../logger.js';
import { describeError } from '../failure.js';
import type { ChatTurn } from '../llm/types.js';
import type { ChatProgress } from '../chat/index.js';
import { sharedTestNames } from '../chat/share-tests.js';

/**
 * What a recipient reads from a sealed share, answered in their own browser from the copy they opened (web/src/core/boot-share.ts): the
 * copy holds one link, found by its id, and only what that link shares. Nothing here is a control against the reader, who runs it: the
 * server's part (when the copy ends, who may open it, how often, what it counts) is in server/src/routes/shared.ts, and the model calls
 * a reader makes are bounded by the relay's allowance for the share.
 */
export async function publicShareRoutes(app: HttpApp) {
  // The documents the link shares, in a language if one is asked for.
  app.get<{ Params: { link: string }; Querystring: { lang?: string } }>('/api/share/:link/documents', async (req, reply) => {
    const store = getStore();
    const link = await store.shareLinks.findLive(req.params.link);

    if (!link) return reply.status(410).send({ error: 'link expired or revoked' });

    // P2: an unresolvable scope returns nothing. This was S-1: the old chain
    // skipped every branch when scope_value was absent and ran the query
    // unfiltered, serving the entire archive from a `tag`-scoped link.
    let resolved: ResolvedShareLink;
    try {
      resolveStoredScope(link.scope, link.scopeValue);
      resolved = link;
    } catch (err) {
      if (err instanceof ScopeError) {
        req.log.error(
          { shareLinkId: link.id, scope: link.scope, reason: err.message },
          'share link has an unresolvable scope — serving nothing',
        );
        return reply.status(410).send({ error: 'link is not usable' });
      }
      throw err;
    }

    const documents = await store.documents.listForShare(resolved);

    // In a language: what is already translated comes with each document; for the rest the translation starts
    // now, in the background, and `translation_pending` tells the page to ask again shortly.
    const language = req.query.lang;
    if (!isSupportedLanguage(language) || !translationEnabled()) return reply.send(documents);
    const missing: string[] = [];
    const withTranslation = [];
    for (const doc of documents) {
      const done = await translateDocument(link.userId, doc.id, language, { cachedOnly: true });
      if (done === null || done === 'not_found') {
        missing.push(doc.id);
        withTranslation.push({ ...doc, translation: null, translation_pending: true });
      } else {
        withTranslation.push({ ...doc, translation: { status: done.status, title: done.title, ai_summary: done.ai_summary, user_notes: done.user_notes }, translation_pending: false });
      }
    }
    if (missing.length > 0) warmTranslations(link.userId, missing, language);
    return reply.send(withTranslation);
  });

  // What the share page needs before it shows anything: the language the owner started it in, if any, the ones it
  // can offer, and whether translating is on. Logged, since it is a read of the link.
  app.get<{ Params: { link: string } }>('/api/share/:link/meta', async (req, reply) => {
    const store = getStore();
    const link = await store.shareLinks.findLive(req.params.link);
    if (!link) return reply.status(410).send({ error: 'link expired or revoked' });
    return reply.header('Cache-Control', 'no-store').send({ language: link.language, languages: SUPPORTED_LANGUAGES, translation: translationEnabled(), chat: link.allowChat && chatEnabled(), landing_url: landingUrl() });
  });

  /**
   * The live link with its scope checked, or null after the reply has been sent: an unknown or revoked link is 410, and a link whose
   * scope cannot be resolved serves nothing (P2).
   */
  async function openLink(
    req: HttpRequest<{ Params: { link: string } }>,
    reply: HttpReply,
  ): Promise<{ link: ResolvedShareLink; store: Store } | null> {
    const store = getStore();
    const link = await store.shareLinks.findLive(req.params.link);
    if (!link) { reply.status(410).send({ error: 'link expired or revoked' }); return null; }
    try {
      resolveStoredScope(link.scope, link.scopeValue);
    } catch (err) {
      if (err instanceof ScopeError) {
        req.log.error({ shareLinkId: link.id, scope: link.scope, reason: err.message }, 'share link has an unresolvable scope — serving nothing');
        reply.status(410).send({ error: 'link is not usable' });
        return null;
      }
      throw err;
    }
    return { link, store };
  }

  // One shared document, for the recipient to read: the details Spine extracted from it, and, only if the
  // owner allowed scans for this link, which pages it has. The document must be one the link's scope
  // resolves to, so a recipient cannot name an id outside what was shared. Explicit columns throughout:
  // no owner id, no server path, no source text, no box.
  app.get<{ Params: { link: string; id: string } }>(
    '/api/share/:link/documents/:id',
    async (req, reply) => {
      const opened = await openLink(req, reply);
      if (!opened) return;
      const { link, store } = opened;

      const shared = (await store.documents.listForShare(link)).find(d => d.id === req.params.id);
      if (!shared) return reply.status(404).send({ error: 'not found' });

      const owner = link.userId;
      const [fields, measurements, doctors, tags, pages] = await Promise.all([
        store.fields.listForDocument(owner, shared.id),
        store.measurements.listForDocument(owner, shared.id),
        store.doctors.forDocument(owner, shared.id),
        store.tags.namesForDocument(owner, shared.id),
        link.includeScans ? store.pages.listForDocument(owner, shared.id) : Promise.resolve([]),
      ]);

      return reply
        .header('Cache-Control', 'no-store')
        .send({
          document: {
            id: shared.id, title: shared.title, doc_date: shared.doc_date, provider: shared.provider,
            doc_type: shared.doc_type, ai_summary: shared.ai_summary, user_notes: shared.user_notes, language: shared.language,
            page_start: shared.page_start, page_end: shared.page_end,
          },
          // Ids are only there so a translation, which is keyed by them, can be laid over the details.
          fields: fields.map(f => ({ id: f.id, label: f.label, value: f.value, group_no: f.group_no })),
          measurements: measurements.map(m => ({
            id: m.id, name: m.name, value_text: m.value_text, unit: m.unit, ref_low: m.ref_low, ref_high: m.ref_high,
            flag: m.flag, taken_on: m.taken_on,
          })),
          doctors: doctors.map(d => ({ id: d.id, name: d.name, specialty: d.specialty, role: d.role })),
          tags,
          scans: link.includeScans,
          pages: pages.map(p => ({ id: p.id, page_number: p.page_number, image_width: p.image_width, image_height: p.image_height })),
        });
    },
  );

  // One shared document in the reader's language, translated on demand and kept, so the next reader gets it at once.
  // The document must be one the link's scope resolves to, as for the document itself. The model is only ever asked
  // to translate into one of the interface's languages, once per document and language until it changes.
  app.get<{ Params: { link: string; id: string }; Querystring: { lang?: string; part?: string } }>(
    '/api/share/:link/documents/:id/translation',
    async (req, reply) => {
      const language = req.query.lang;
      if (!isSupportedLanguage(language)) return reply.status(400).send({ error: `lang must be one of ${SUPPORTED_LANGUAGES.join(', ')}` });
      const opened = await openLink(req, reply);
      if (!opened) return;
      const { link, store } = opened;
      if (!(await store.documents.listForShare(link)).some(d => d.id === req.params.id)) return reply.status(404).send({ error: 'not found' });

      const result = await translateDocument(link.userId, req.params.id, language, { part: req.query.part === 'head' ? 'head' : 'full', persistLanguage: false });
      if (result === 'not_found') return reply.status(404).send({ error: 'not found' });
      if (result === null) return reply.status(502).send({ error: 'the document could not be translated right now' });
      return reply.header('Cache-Control', 'no-store').send(result);
    },
  );

  // Values over time, for the documents the link shares and no others. The names are worked out from the shared
  // documents' own results: the owner's list (`measurements.names`) counts every document, and its "latest" could be
  // from one that was not shared.
  app.get<{ Params: { link: string } }>(
    '/api/share/:link/trends',
    async (req, reply) => {
      const opened = await openLink(req, reply);
      if (!opened) return;
      const { link, store } = opened;
      return reply.header('Cache-Control', 'no-store').send(await sharedTestNames(link.userId, await store.documents.listForShare(link)));
    },
  );

  // The documents around one shared document: those the owner linked to it (confirmed links only) and those that read alike
  // (the same test or doctor, or close in meaning), each only if the link shares it too. Reads and computes; writes nothing
  // (R-4). Titles and dates are what the list already shows; no reason text, no score, no word of who made a link.
  app.get<{ Params: { link: string; id: string } }>(
    '/api/share/:link/documents/:id/connections',
    async (req, reply) => {
      const opened = await openLink(req, reply);
      if (!opened) return;
      const { link, store } = opened;

      const shared = new Map((await store.documents.listForShare(link)).map(d => [d.id, d]));
      if (!shared.has(req.params.id)) return reply.status(404).send({ error: 'not found' });

      const [chain, related] = await Promise.all([
        sharedChainOf(link.userId, req.params.id, shared),
        relatedTo(link.userId, req.params.id, 8, new Set(shared.keys())),
      ]);
      return reply.header('Cache-Control', 'no-store').send({
        chain: chain && chain.edges.length > 0 ? chain : null,
        related: related.map(r => ({
          id: r.id, title: r.title, doc_type: r.doc_type, doc_date: r.doc_date, provider: r.provider,
          reasons: r.reasons.flatMap((x): Array<{ kind: 'tests' | 'doctors'; names: string[] } | { kind: 'meaning' }> => (x.kind === 'tests' || x.kind === 'doctors' ? [{ kind: x.kind, names: x.names }] : x.kind === 'meaning' ? [{ kind: 'meaning' }] : [])),
        })),
      });
    },
  );

  app.get<{ Params: { link: string }; Querystring: { name?: string } }>(
    '/api/share/:link/trends/series',
    async (req, reply) => {
      const opened = await openLink(req, reply);
      if (!opened) return;
      const { link, store } = opened;
      const canonical = typeof req.query.name === 'string' ? req.query.name.trim().toLowerCase() : '';
      if (!canonical) return reply.status(400).send({ error: 'name is required' });
      // Only the points that come from a shared document: the owner's series holds them all.
      const shared = new Set((await store.documents.listForShare(link)).map(d => d.id));
      const series = buildSeries(canonical, (await store.measurements.series(link.userId, canonical)).filter(p => shared.has(p.document_id)));
      if (!series) return reply.status(404).send({ error: 'not found' });
      return reply.header('Cache-Control', 'no-store').send(series);
    },
  );

  // A recipient's question about what the link shares (SECURITY.md M-20). Only for a link the owner allowed chat on. The agent reads the owner's store, so it is held to
  // `listForShare(link)` in code (`Scope`), not by its prompt; nothing is stored, and the earlier turns come from the page.
  app.post<{ Params: { link: string }; Body: { question?: unknown; history?: unknown; document_id?: unknown; stream?: unknown } }>(
    '/api/share/:link/chat',
    async (req, reply) => {
      const { question, history: sent, document_id: documentId, stream } = req.body ?? {};
      if (typeof question !== 'string' || !question.trim() || question.length > MAX_QUESTION) {
        return reply.status(400).send({ error: `question is required, at most ${MAX_QUESTION} characters` });
      }
      let history: ChatTurn[] = [];
      if (sent !== undefined) {
        const ok = Array.isArray(sent) && sent.length <= MAX_TURNS * 2 && sent.every(t => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.length <= MAX_TURN * 4);
        if (!ok) return reply.status(400).send({ error: 'history must be a few earlier turns' });
        history = trimHistory((sent as ChatTurn[]).map(t => ({ role: t.role, content: t.content })));
      }
      if (documentId !== undefined && (typeof documentId !== 'string' || documentId.length > 64)) return reply.status(400).send({ error: 'document_id must be an id' });

      const opened = await openLink(req, reply);
      if (!opened) return;
      const { link, store } = opened;
      // One 404 for "not on this link" and "switched off", as for a scan the link does not allow.
      if (!link.allowChat || !chatEnabled()) return reply.status(404).send({ error: 'not found' });
      const model = getChatLlm().agentModel?.() ?? null;
      if (!model) return reply.status(409).send({ error: 'questions are not available right now' });

      const docs = await store.documents.listForShare(link);
      const ask = (progress: ChatProgress) => askSharedAgent(model, link.userId, docs, link.label ?? null, question.trim(), history, typeof documentId === 'string' ? documentId : null, progress);
      // `looked` says what the agent searched for, in the recipient's own words; it is not for them.
      const visible = (answered: Awaited<ReturnType<typeof ask>>) => { if (!answered) return null; const { looked: _looked, ...rest } = answered; return rest; };

      // The same lines as the owner's chat (routes/ndjson.ts); all refusals are above, before the first byte.
      if (stream === true) {
        return streamReply(reply, async progress => {
          const answered = visible(await ask(progress));
          if (progress.signal?.aborted) return null;
          return answered ? { type: 'done', reply: answered } : { type: 'error', status: 502, error: 'could not answer just now' };
        }, 'answered for a share');
      }
      try {
        const answered = visible(await ask({}));
        if (!answered) return reply.status(502).send({ error: 'could not answer just now' });
        return reply.header('Cache-Control', 'no-store').send(answered);
      } catch (err) {
        logger.warn('a shared question could not be answered', { shareLinkId: link.id, error: describeError(err) });
        return reply.status(502).send({ error: 'could not answer just now' });
      }
    },
  );

  // A page image, only for a link the owner allowed scans on, and only a page that belongs to a document in
  // that link's scope (and that the owner has not hidden). Anything else is the same 404, so the answer says
  // nothing about pages outside the share.
  app.get<{ Params: { link: string; pageId: string } }>(
    '/api/share/:link/pages/:pageId/image',
    async (req, reply) => {
      const opened = await openLink(req, reply);
      if (!opened) return;
      const { link, store } = opened;
      if (!link.includeScans) return reply.status(404).send({ error: 'not found' });

      let allowed = false;
      for (const doc of await store.documents.listForShare(link)) {
        if ((await store.pages.listForDocument(link.userId, doc.id)).some(p => p.id === req.params.pageId)) { allowed = true; break; }
      }
      if (!allowed) return reply.status(404).send({ error: 'not found' });

      const imagePath = await store.pages.findImagePathFor(link.userId, req.params.pageId);
      if (!imagePath || !fileSystem().existsSync(imagePath) || !fileSystem().statSync(imagePath).isFile()) {
        return reply.status(404).send({ error: 'not found' });
      }
      return reply
        .type(extname(imagePath).toLowerCase() === '.jpg' ? 'image/jpeg' : 'image/png')
        .header('Cache-Control', 'no-store')
        .header('X-Robots-Tag', 'noindex, nofollow')
        .send(fileSystem().readStream(imagePath));
    },
  );
}
