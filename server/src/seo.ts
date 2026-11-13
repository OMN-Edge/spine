import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { publicUrl, settings } from 'spine-core/config.js';
import { billingOn } from './billing/config.js';

/**
 * What a search engine is told about the public pages, from this instance's own address (`SPINE_DOMAIN`), so that every way of serving the app
 * publishes the operator's site and never the project's. The pages themselves are files of the build (`web/scripts/seo-pages.mjs` writes one for each
 * public screen, with its own title and description, and `seo.json` listing them); this adds what depends on the address:
 *
 *  - `/robots.txt` and `/sitemap.xml`, with absolute addresses (a page's own file is served by the static handler, `/trust` and `/trust/` alike);
 *  - a canonical link and `noindex` on any answer for a host that is not `SPINE_DOMAIN` (the `run.app` address of a Cloud Run service, a `www.`
 *    name), so that a copy of the site is not indexed beside it.
 *
 * The shell served for every other address (a screen behind a sign-in, an unknown path) is `noindex` too (`index.ts`).
 */
export interface SeoPage { path: string; when?: 'billing' }

/** The pages the build lists, or none when it lists none (a build from before, or the tests'). */
export function readSeoPages(webDist: string): SeoPage[] {
  try {
    const listed = JSON.parse(fs.readFileSync(path.join(webDist, 'seo.json'), 'utf8')) as unknown;
    return Array.isArray(listed) ? listed.filter((p): p is SeoPage => typeof p?.path === 'string' && /^\/[a-z0-9-]*$/.test(p.path)) : [];
  } catch {
    return [];
  }
}

/** The host name this instance is served at, or null when it is not set (a local run): nothing is then a copy. */
export const ownHost = (env: NodeJS.ProcessEnv = settings() as NodeJS.ProcessEnv): string | null =>
  (env.SPINE_DOMAIN ?? '').trim().replace(/:\d+$/, '').toLowerCase() || null;

export function robotsTxt(withSitemap: boolean): string {
  // The API and a share's pages are no one's to read; the rest is open.
  return ['User-agent: *', 'Disallow: /api/', 'Disallow: /share/', ...(withSitemap ? [`Sitemap: ${publicUrl('/sitemap.xml')}`] : []), ''].join('\n');
}

export function sitemapXml(pages: SeoPage[], billing: boolean): string {
  const urls = pages.filter(p => p.when !== 'billing' || billing).map(p => `  <url><loc>${publicUrl(p.path)}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

/** On the app itself (not in a plugin, whose hook would reach only its own routes): every answer for a host that is not this instance's own. */
export function copyOfTheSite(app: FastifyInstance): void {
  app.addHook('onSend', async (req, reply, payload) => {
    const own = ownHost();
    if (!own || req.hostname.replace(/:\d+$/, '').toLowerCase() === own) return payload;
    if (!reply.hasHeader('x-robots-tag')) reply.header('x-robots-tag', 'noindex');
    reply.header('link', `<${publicUrl(req.url.split('?')[0])}>; rel="canonical"`);
    return payload;
  });
}

export async function seoRoutes(app: FastifyInstance, opts: { webDist: string }) {
  const pages = readSeoPages(opts.webDist);

  app.get('/robots.txt', async (_req, reply) =>
    reply.header('cache-control', 'public, max-age=3600').type('text/plain; charset=utf-8').send(robotsTxt(ownHost() !== null && pages.length > 0)));

  app.get('/sitemap.xml', async (_req, reply) => {
    if (ownHost() === null || pages.length === 0) return reply.status(404).type('text/plain; charset=utf-8').send('not found\n');
    return reply.header('cache-control', 'public, max-age=3600').type('application/xml; charset=utf-8').send(sitemapXml(pages, billingOn()));
  });
}
