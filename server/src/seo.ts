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
  return ['User-agent: *', 'Disallow: /api/', 'Disallow: /share/', 'Disallow: /admin', ...(withSitemap ? [`Sitemap: ${publicUrl('/sitemap.xml')}`] : []), ''].join('\n');
}

/** `lastmod` is the day the site was last put up (a date), said once for every page: they are files of one build. */
export function sitemapXml(pages: SeoPage[], billing: boolean, lastmod?: string): string {
  const day = lastmod ? `<lastmod>${lastmod}</lastmod>` : '';
  const urls = pages.filter(p => p.when !== 'billing' || billing).map(p => `  <url><loc>${publicUrl(p.path)}</loc>${day}</url>`);
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
    let lastmod: string | undefined;
    try { lastmod = fs.statSync(path.join(opts.webDist, 'seo.json')).mtime.toISOString().slice(0, 10); } catch { /* a build with no list: no date */ }
    return reply.header('cache-control', 'public, max-age=3600').type('application/xml; charset=utf-8').send(sitemapXml(pages, billingOn(), lastmod));
  });
}

const escapeAttr = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const jsonLd = (data: unknown) => JSON.stringify(data).replace(/</g, '\\u003c');

/**
 * A public page's head with what depends on this instance's address, added where the page is given out (the build names no address, so the same commit builds the same files anywhere): the
 * page's own address as its canonical one, the preview image, and what the site and the page are, as data a search engine reads (`schema.org`).
 */
export function withAddress(html: string, pagePath: string): string {
  const url = publicUrl(pagePath);
  const origin = publicUrl('');
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
  const data = pagePath === '/'
    ? { '@context': 'https://schema.org', '@graph': [
        { '@type': 'WebSite', name: 'Spine', url: origin, inLanguage: 'en' },
        { '@type': 'SoftwareApplication', name: 'Spine', url: origin, applicationCategory: 'HealthApplication', operatingSystem: 'Any (in a web browser)' },
      ] }
    : { '@context': 'https://schema.org', '@type': 'WebPage', name: title.replace(/&quot;/g, '"').replace(/&amp;/g, '&'), url, isPartOf: { '@type': 'WebSite', name: 'Spine', url: origin } };
  const head = [
    `<link rel="canonical" href="${escapeAttr(url)}" />`,
    `<meta property="og:url" content="${escapeAttr(url)}" />`,
    `<meta property="og:site_name" content="Spine" />`,
    `<meta property="og:image" content="${escapeAttr(publicUrl('/og.png'))}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<script type="application/ld+json">${jsonLd(data)}</script>`,
  ].join('\n    ');
  return html.replace('</head>', `    ${head}\n  </head>`);
}

/**
 * The public pages as files of the build, with this instance's address in their heads (`withAddress`), given out for their own paths; the front page (`home.html`, drawn with its text) to a
 * visitor with no session, and the plain shell, whose first draw is the app, to anyone signed in. And `www.` sent to the plain address with a permanent redirect, so there is one site and
 * not two. On the app itself, like `copyOfTheSite`.
 */
export function publicPages(app: FastifyInstance, webDist: string): void {
  const own = ownHost();
  const pages = new Map<string, string>();
  for (const { path: p } of readSeoPages(webDist)) {
    try {
      const html = fs.readFileSync(path.join(webDist, p === '/' ? 'home.html' : `${p.slice(1)}/index.html`), 'utf8');
      pages.set(p, own ? withAddress(html, p) : html);
    } catch { /* a page this build did not draw */ }
  }
  app.addHook('onRequest', async (req, reply) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return;
    const host = req.hostname.replace(/:\d+$/, '').toLowerCase();
    if (own && host === `www.${own}`) return reply.redirect(publicUrl(req.url), 301);
    const wanted = req.url.split('?')[0]!.replace(/(.)\/$/, '$1');
    const html = pages.get(wanted);
    if (!html) return;
    // The front page is also where a signed-in person lands: the shell, which draws the app, is theirs.
    if (wanted === '/' && /(?:^|;\s*)sessionId=/.test(req.headers.cookie ?? '')) return;
    return reply.header('cache-control', 'public, max-age=0').type('text/html; charset=utf-8').send(html);
  });
}
