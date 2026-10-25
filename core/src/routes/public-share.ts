import { sharedChainOf } from '../linking/index.js';
import { relatedTo } from '../similarity/index.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createReadStream, existsSync, readFileSync, statSync } from 'fs';
import path, { extname } from 'path';
import { fileURLToPath } from 'url';
import { getStore, type ResolvedShareLink, type Store } from '../store/index.js';
import { resolveStoredScope, ScopeError } from '../share-scope.js';
import { hashShareToken } from '../share-token.js';
import { isSupportedLanguage, SUPPORTED_LANGUAGES } from '../languages.js';
import { translateDocument, warmTranslations } from '../translation.js';
import { translationEnabled } from '../config.js';
import { buildSeries } from './trends.js';
import { approvalFor, startVisitor, visitorHashOf, type Approval } from '../share-visitor.js';
import { ownerNotices } from '../owner-notices.js';
import { windowLimiter } from '../rate-limit.js';
import { v4 as uuidv4 } from 'uuid';
import { streamReply } from './ndjson.js';
import { chatEnabled, landingUrl, publicUrl } from '../config.js';
import { countryOf } from '../geo.js';
import { getChatLlm } from '../llm/index.js';
import { askSharedAgent } from '../chat/agent.js';
import { MAX_QUESTION, MAX_TURN, MAX_TURNS, trimHistory } from '../chat/index.js';
import { logger } from '../logger.js';
import { describeError } from '../failure.js';
import type { ChatTurn } from '../llm/types.js';
import type { ChatProgress } from '../chat/index.js';
import { sharedTestNames } from '../chat/share-tests.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface PublicShareRouteOptions {
  /**
   * The built SPA's index.html. `GET /share/:token` serves it so React Router
   * can render the share view: the SPA fallback in index.ts deliberately
   * excludes `/share/`, so this route is the only thing that answers a
   * recipient's URL and it has to return the app, not JSON.
   */
  appShellPath?: string;
  /** Access requests: per source, and per link. Options so tests drive the real limiters (as for login). */
  requestPerSource?: { max: number; timeWindow: string };
  requestPerLink?: { max: number; windowMs: number };
  /** Questions from a recipient: per source, and per link. Each costs model calls, and anyone with the link can ask. */
  chatPerSource?: { max: number; timeWindow: string };
  chatPerLink?: { max: number; windowMs: number };
}

/**
 * P7: every non-owner access is logged before anything is returned. Both routes
 * log, so a token being probed leaves a trace even if no document is fetched.
 *
 * `countView` is false when only the app shell was served: `view_count` counts
 * times the documents were actually read, which is what the owner is being told
 * on the Share Links page.
 *
 * S-9: X-Real-IP is trusted here, which is correct behind nginx and forgeable
 * if Fastify is reachable directly. Fastify binds loopback (config.ts) so that
 * precondition holds.
 */
async function logAccess(
  store: Store,
  req: FastifyRequest,
  linkId: string,
  { countView, documentId = null }: { countView: boolean; documentId?: string | null },
): Promise<void> {
  // `req.ip` is the address the trusted proxy saw (S-31), the same in front of nginx and in front of Caddy.
  const ip = req.ip ?? null;
  await store.shareLinks.logAccess(linkId, new Date().toISOString(), ip, countView, { country: await countryOf(ip), documentId });
}

/** Requests waiting on one link at once. */
const MAX_WAITING = 5;

const DEAD_LINK_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<title>Link unavailable</title></head><body>' +
  '<p>This link is no longer active.</p></body></html>';

export async function publicShareRoutes(
  app: FastifyInstance,
  opts: PublicShareRouteOptions = {},
) {
  const appShellPath =
    opts.appShellPath ?? path.join(__dirname, '../../../web/dist/index.html');

  app.get<{ Params: { token: string } }>('/share/:token', async (req, reply) => {
    const store = getStore();
    // P6: the column holds sha256(token), so the presented value is hashed
    // before the lookup.
    const link = await store.shareLinks.findLiveByTokenHash(hashShareToken(req.params.token));

    // A sealed share (docs/crypto-design.md, stage 4) is opened by the page itself, which asks the server about it and says if it ended, so
    // the app is served for its id whatever its state. The server cannot tell what is in it; the access is noted when the page opens it.
    const sealed = !link && /^[A-Za-z0-9_-]{22,64}$/.test(req.params.token) ? await store.shared.get(req.params.token) : null;

    // A dead link gets a plain page rather than the app, so a recipient whose
    // link expired is not left looking at a spinner.
    if (!link && !sealed) return reply.status(410).type('text/html').send(DEAD_LINK_PAGE);

    if (link) await logAccess(store, req, link.id, { countView: false });

    if (!existsSync(appShellPath)) {
      req.log.error({ appShellPath }, 'share view requested but the web build is missing');
      return reply.status(500).type('text/html').send(DEAD_LINK_PAGE);
    }

    // Read rather than sendFile: this route must work whether or not
    // @fastify/static is registered in the surrounding app.
    return reply.type('text/html').send(readFileSync(appShellPath, 'utf8'));
  });

  // JSON API for the public share view (used by the frontend PublicShareView page)
  app.get<{ Params: { token: string }; Querystring: { lang?: string } }>('/api/share/:token/documents', async (req, reply) => {
    const store = getStore();
    const link = await store.shareLinks.findLiveByTokenHash(hashShareToken(req.params.token));

    if (!link) return reply.status(410).send({ error: 'link expired or revoked' });

    // M-19: a link that needs approval reads nothing until this browser has been approved. Logged either way (P7),
    // but only a read that was allowed counts as a view.
    const approval = await approvalFor(store, req, link);
    await logAccess(store, req, link.id, { countView: approval === 'open' });
    if (approval !== 'open') return reply.status(403).send({ error: 'approval required', approval });

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
  app.get<{ Params: { token: string } }>('/api/share/:token/meta', async (req, reply) => {
    const store = getStore();
    const link = await store.shareLinks.findLiveByTokenHash(hashShareToken(req.params.token));
    if (!link) return reply.status(410).send({ error: 'link expired or revoked' });
    await logAccess(store, req, link.id, { countView: false });
    // `approval` is what the page needs to decide between asking for access, waiting, and showing the documents.
    const approval = await approvalFor(store, req, link);
    return reply.header('Cache-Control', 'no-store').send({ language: link.language, languages: SUPPORTED_LANGUAGES, translation: translationEnabled(), approval, chat: link.allowChat && chatEnabled(), landing_url: landingUrl() });
  });

  // A visitor asks to be let in. The first request from a browser gives it its cookie and tells the owner (by mail, if
  // there is a mailer; the request is on the Share links page either way); asking again changes nothing and sends
  // nothing. Bounded three ways: per source here, per link below, and a cap on how many wait at once (the store).
  const perLink = windowLimiter(
    opts.requestPerLink ?? { max: 10, windowMs: 60 * 60 * 1000 },
    req => hashShareToken((req.params as { token?: string }).token ?? ''),
    'too many requests for this link, try again later',
  );
  app.post<{ Params: { token: string }; Body: { note?: unknown } }>(
    '/api/share/:token/access-request',
    { config: { rateLimit: opts.requestPerSource ?? { max: 10, timeWindow: '1 minute' } }, preHandler: perLink },
    async (req, reply) => {
      const store = getStore();
      const link = await store.shareLinks.findLiveByTokenHash(hashShareToken(req.params.token));
      if (!link) return reply.status(410).send({ error: 'link expired or revoked' });
      await logAccess(store, req, link.id, { countView: false });
      if (!link.requireApproval) return reply.header('Cache-Control', 'no-store').send({ approval: 'open' as Approval });

      const existing = await approvalFor(store, req, link);
      if (existing !== 'needed') return reply.header('Cache-Control', 'no-store').send({ approval: existing });

      // Text from a stranger: cut short, control characters out. The owner sees it as text and it is not in the mail.
      const raw = typeof req.body?.note === 'string' ? req.body.note : '';
      const note = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120) || null;
      const userAgent = String(req.headers['user-agent'] ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) || null;
      const ip = req.ip ?? null;

      const visitor = visitorHashOf(req) ?? startVisitor(reply);
      const id = uuidv4();
      const requestedAt = new Date().toISOString();
      const created = await store.shareLinks.createRequest(link.id, { id, visitorHash: visitor, note, ipAddress: ip, userAgent, requestedAt }, MAX_WAITING);
      if (!created) return reply.status(429).send({ error: 'too many requests are waiting for this link' });

      // After the response, as for account mail: how long the provider takes is not the visitor's business.
      const notices = ownerNotices();
      if (notices?.enabled()) {
        const owner = await store.users.findById(link.userId);
        if (owner) {
          void notices.accessRequested(owner, id, requestedAt, ip).catch(err => {
            req.log.error({ shareLinkId: link.id, err: err instanceof Error ? err.message : String(err) }, 'could not send access request mail');
          });
        }
      }
      return reply.status(202).header('Cache-Control', 'no-store').send({ approval: 'pending' as Approval });
    },
  );

  /**
   * The live link for a presented token with its scope checked, logged first (P7), or null after the
   * reply has been sent. The same order as the list route: an unknown or revoked token is 410, a link
   * whose scope cannot be resolved serves nothing (P2).
   */
  async function openLink(
    req: FastifyRequest<{ Params: { token: string } }>,
    reply: import('fastify').FastifyReply,
    countView: boolean,
    documentId: string | null = null,
  ): Promise<{ link: ResolvedShareLink; store: Store } | null> {
    const store = getStore();
    const link = await store.shareLinks.findLiveByTokenHash(hashShareToken(req.params.token));
    if (!link) { reply.status(410).send({ error: 'link expired or revoked' }); return null; }

    const approval = await approvalFor(store, req, link);
    // Only a document the link really shares is recorded as opened: the id comes from the recipient.
    const opened = approval === 'open' && documentId && (await store.documents.listForShare(link)).some(d => d.id === documentId) ? documentId : null;
    await logAccess(store, req, link.id, { countView: countView && approval === 'open', documentId: opened });
    if (approval !== 'open') { reply.status(403).send({ error: 'approval required', approval }); return null; }
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
  app.get<{ Params: { token: string; id: string } }>(
    '/api/share/:token/documents/:id',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const opened = await openLink(req, reply, true, req.params.id);
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
  app.get<{ Params: { token: string; id: string }; Querystring: { lang?: string; part?: string } }>(
    '/api/share/:token/documents/:id/translation',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const language = req.query.lang;
      if (!isSupportedLanguage(language)) return reply.status(400).send({ error: `lang must be one of ${SUPPORTED_LANGUAGES.join(', ')}` });
      const opened = await openLink(req, reply, false);
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
  app.get<{ Params: { token: string } }>(
    '/api/share/:token/trends',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const opened = await openLink(req, reply, false);
      if (!opened) return;
      const { link, store } = opened;
      return reply.header('Cache-Control', 'no-store').send(await sharedTestNames(link.userId, await store.documents.listForShare(link)));
    },
  );

  // The documents around one shared document: those the owner linked to it (confirmed links only) and those that read alike
  // (the same test or doctor, or close in meaning), each only if the link shares it too. Reads and computes; writes nothing
  // (R-4). Titles and dates are what the list already shows; no reason text, no score, no word of who made a link.
  app.get<{ Params: { token: string; id: string } }>(
    '/api/share/:token/documents/:id/connections',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const opened = await openLink(req, reply, false);
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

  app.get<{ Params: { token: string }; Querystring: { name?: string } }>(
    '/api/share/:token/trends/series',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const opened = await openLink(req, reply, false);
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

  // A recipient's question about what the link shares (SECURITY.md M-20). Only for a link the owner allowed chat on, and only
  // once the link is open to this browser (approval, scope). The agent reads the owner's store, so it is held to
  // `listForShare(link)` in code (`Scope`), not by its prompt; nothing is stored, and the earlier turns come from the page.
  const chatPerLink = windowLimiter(
    opts.chatPerLink ?? { max: 60, windowMs: 60 * 60 * 1000 },
    req => hashShareToken((req.params as { token?: string }).token ?? ''),
    'too many questions for this link, try again later',
  );
  app.post<{ Params: { token: string }; Body: { question?: unknown; history?: unknown; document_id?: unknown; stream?: unknown } }>(
    '/api/share/:token/chat',
    { config: { rateLimit: opts.chatPerSource ?? { max: 10, timeWindow: '1 minute' } }, preHandler: chatPerLink },
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

      const opened = await openLink(req, reply, false);
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
  app.get<{ Params: { token: string; pageId: string } }>(
    '/api/share/:token/pages/:pageId/image',
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const opened = await openLink(req, reply, false);
      if (!opened) return;
      const { link, store } = opened;
      if (!link.includeScans) return reply.status(404).send({ error: 'not found' });

      let allowed = false;
      for (const doc of await store.documents.listForShare(link)) {
        if ((await store.pages.listForDocument(link.userId, doc.id)).some(p => p.id === req.params.pageId)) { allowed = true; break; }
      }
      if (!allowed) return reply.status(404).send({ error: 'not found' });

      const imagePath = await store.pages.findImagePathFor(link.userId, req.params.pageId);
      if (!imagePath || !existsSync(imagePath) || !statSync(imagePath).isFile()) {
        return reply.status(404).send({ error: 'not found' });
      }
      return reply
        .type(extname(imagePath).toLowerCase() === '.jpg' ? 'image/jpeg' : 'image/png')
        .header('Cache-Control', 'no-store')
        .header('X-Robots-Tag', 'noindex, nofollow')
        .send(createReadStream(imagePath));
    },
  );
}
