import type { FastifyInstance, FastifyRequest } from 'fastify';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getStore, type ResolvedShareLink, type Store } from '../store/index.js';
import { resolveStoredScope, ScopeError } from '../share-scope.js';
import { hashShareToken } from '../share-token.js';

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
  app.get<{ Params: { token: string } }>('/api/share/:token/documents', async (req, reply) => {
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

    return reply.send(await store.documents.listForShare(resolved));
  });
}
