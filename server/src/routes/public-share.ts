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
import type { MeasurementName } from '../store/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface PublicShareRouteOptions {
  /**
   * The built SPA's index.html. `GET /share/:token` serves it so React Router
   * can render the share view: the SPA fallback in index.ts deliberately
   * excludes `/share/`, so this route is the only thing that answers a
   * recipient's URL and it has to return the app, not JSON.
   */
  appShellPath?: string;
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
  { countView }: { countView: boolean },
): Promise<void> {
  const ip = (req.headers['x-real-ip'] as string) ?? req.socket.remoteAddress ?? null;
  await store.shareLinks.logAccess(linkId, new Date().toISOString(), ip, countView);
}

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

    // A dead link gets a plain page rather than the app, so a recipient whose
    // link expired is not left looking at a spinner.
    if (!link) return reply.status(410).type('text/html').send(DEAD_LINK_PAGE);

    await logAccess(store, req, link.id, { countView: false });

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

    // Log every data access — this is where medical data actually flows
    await logAccess(store, req, link.id, { countView: true });

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
    return reply.header('Cache-Control', 'no-store').send({ language: link.language, languages: SUPPORTED_LANGUAGES, translation: translationEnabled() });
  });

  /**
   * The live link for a presented token with its scope checked, logged first (P7), or null after the
   * reply has been sent. The same order as the list route: an unknown or revoked token is 410, a link
   * whose scope cannot be resolved serves nothing (P2).
   */
  async function openLink(
    req: FastifyRequest<{ Params: { token: string } }>,
    reply: import('fastify').FastifyReply,
    countView: boolean,
  ): Promise<{ link: ResolvedShareLink; store: Store } | null> {
    const store = getStore();
    const link = await store.shareLinks.findLiveByTokenHash(hashShareToken(req.params.token));
    if (!link) { reply.status(410).send({ error: 'link expired or revoked' }); return null; }

    await logAccess(store, req, link.id, { countView });
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
      const opened = await openLink(req, reply, true);
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
      const byName = new Map<string, MeasurementName>();
      for (const doc of await store.documents.listForShare(link)) {
        for (const m of await store.measurements.listForDocument(link.userId, doc.id)) {
          const held = byName.get(m.canonical);
          const newer = !held || (m.taken_on ?? '') >= (held.latest_taken_on ?? '');
          byName.set(m.canonical, {
            canonical: m.canonical,
            name: newer ? m.name : held.name,
            unit: newer ? m.unit : held.unit,
            count: (held?.count ?? 0) + 1,
            latest_value_text: newer ? m.value_text : held.latest_value_text,
            latest_taken_on: newer ? m.taken_on : held.latest_taken_on,
            latest_flag: newer ? m.flag : held.latest_flag,
          });
        }
      }
      return reply.header('Cache-Control', 'no-store').send([...byName.values()].sort((a, b) => a.name.localeCompare(b.name)));
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
