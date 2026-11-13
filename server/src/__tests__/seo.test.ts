import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { useSettings } from 'spine-core/config.js';
import { copyOfTheSite, readSeoPages, robotsTxt, seoRoutes, sitemapXml, type SeoPage } from '../seo.js';

/** What a search engine is told, from the instance's own address (docs/deploy-cloud-run.md): the pages, the sitemap, and that a copy is not the site. */
let dist: string;
const PAGES: SeoPage[] = [{ path: '/' }, { path: '/trust' }, { path: '/pricing', when: 'billing' }];

beforeEach(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-seo-'));
  fs.mkdirSync(path.join(dist, 'trust'));
  fs.mkdirSync(path.join(dist, 'pricing'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<title>shell</title>');
  fs.writeFileSync(path.join(dist, 'trust/index.html'), '<title>trust page</title>');
  fs.writeFileSync(path.join(dist, 'pricing/index.html'), '<title>pricing page</title>');
  fs.writeFileSync(path.join(dist, 'seo.json'), JSON.stringify(PAGES));
  useSettings({ ...process.env, SPINE_DOMAIN: 'spine.example.org' } as never);
});
afterEach(() => { fs.rmSync(dist, { recursive: true, force: true }); vi.unstubAllEnvs(); });

async function build() {
  const app = Fastify();
  copyOfTheSite(app);
  await app.register(fastifyStatic, { root: dist, prefix: '/', decorateReply: true });
  await app.register(seoRoutes, { webDist: dist });
  app.setNotFoundHandler(async (_req, reply) => reply.header('x-robots-tag', 'noindex').sendFile('index.html', dist));
  return app;
}
const ask = async (url: string, host = 'spine.example.org') => {
  const app = await build();
  const res = await app.inject({ url, headers: { host } });
  await app.close();
  return res;
};

describe('robots.txt and the sitemap', () => {
  it('keep the API and the shares out, and name the sitemap by this instance’s own address', async () => {
    const res = await ask('/robots.txt');
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toBe('User-agent: *\nDisallow: /api/\nDisallow: /share/\nSitemap: https://spine.example.org/sitemap.xml\n');
    expect(res.body).not.toMatch(/spinevault|cocinda/);
  });

  it('list the public pages with absolute addresses, and the pricing page only where there are plans', async () => {
    const without = (await ask('/sitemap.xml')).body;
    expect(without).toContain('<loc>https://spine.example.org/</loc>');
    expect(without).toContain('<loc>https://spine.example.org/trust</loc>');
    expect(without).not.toContain('pricing');
    vi.stubEnv('SPINE_BILLING', 'on');
    expect((await ask('/sitemap.xml')).body).toContain('<loc>https://spine.example.org/pricing</loc>');
    expect(sitemapXml(PAGES, true)).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  });

  it('have no sitemap to name when the build lists no page or the instance has no address', async () => {
    fs.rmSync(path.join(dist, 'seo.json'));
    expect((await ask('/sitemap.xml')).statusCode).toBe(404);
    expect((await ask('/robots.txt')).body).not.toContain('Sitemap');
    expect(readSeoPages(dist)).toEqual([]);
    expect(robotsTxt(false)).not.toContain('Sitemap');
  });
});

describe('a public page', () => {
  it('is its own file at its address, with or without the slash', async () => {
    expect((await ask('/trust')).body).toBe('<title>trust page</title>');
    expect((await ask('/trust/')).body).toBe('<title>trust page</title>');
  });

  it('is open to search engines, and the shell for any other path is not', async () => {
    expect((await ask('/trust')).headers['x-robots-tag']).toBeUndefined();
    expect((await ask('/')).headers['x-robots-tag']).toBeUndefined();
    const other = await ask('/account');
    expect(other.body).toBe('<title>shell</title>');
    expect(other.headers['x-robots-tag']).toBe('noindex');
  });
});

describe('a copy of the site at another address', () => {
  it('says it is not the site: noindex, and a canonical link to the same path on this instance’s own name', async () => {
    const res = await ask('/trust?x=1', 'spine-abc123-ew.a.run.app');
    expect(res.headers['x-robots-tag']).toBe('noindex');
    expect(res.headers.link).toBe('<https://spine.example.org/trust>; rel="canonical"');
    expect((await ask('/trust', 'www.spine.example.org')).headers.link).toContain('rel="canonical"');
  });

  it('says nothing at its own name, whatever the case or port', async () => {
    for (const host of ['spine.example.org', 'Spine.Example.Org:443']) {
      const res = await ask('/trust', host);
      expect(res.headers.link, host).toBeUndefined();
      expect(res.headers['x-robots-tag'], host).toBeUndefined();
    }
  });

  it('says nothing where the instance has no address of its own, as on a local run', async () => {
    useSettings({ ...process.env, SPINE_DOMAIN: '' } as never);
    expect((await ask('/trust', 'localhost:3000')).headers.link).toBeUndefined();
  });
});
