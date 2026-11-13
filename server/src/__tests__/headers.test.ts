import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { securityHeaders, contentSecurityPolicy, serverHeaders, serverHeadersOn, isDotfilePath } from '../headers.js';
import { trustProxySetting } from '../trust-proxy.js';

const root = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const quoted = (text: string, header: string) => new RegExp(`${header}\\s+"([^"]+)"`).exec(text)![1].replace(/\s+/g, ' ').replace(/ ;/g, ';').trim();

describe('the headers the server sets when no proxy of ours is in front', () => {
  // Caddy, nginx and the server are three copies of one policy: a change to one that misses the others is a page that behaves differently by host.
  it('are the Caddyfile’s and nginx’s, word for word', () => {
    const caddy = root('Caddyfile');
    const nginx = root('nginx/spine.conf');
    const mine = securityHeaders({});
    const nginxValue = (header: string) => quoted(nginx.replace(/add_header /g, ''), header).replace('SPINE_RELAY_URL', '').replace(/ ;/g, ';').replace(/\s+/g, ' ').trim();
    for (const [name, header] of [
      ['strict-transport-security', 'Strict-Transport-Security'],
      ['x-content-type-options', 'X-Content-Type-Options'],
      ['x-frame-options', 'X-Frame-Options'],
      ['referrer-policy', 'Referrer-Policy'],
      ['permissions-policy', 'Permissions-Policy'],
      ['content-security-policy', 'Content-Security-Policy'],
    ] as const) {
      expect(mine[name], `Caddyfile ${header}`).toBe(quoted(caddy, header).replace('{$SPINE_RELAY_URL:}', '').replace(/ ;/g, ';').replace(/\s+/g, ' ').trim());
      expect(mine[name], `nginx ${header}`).toBe(nginxValue(header));
    }
  });

  it('name the relay in what the page may connect to, and only when there is one', () => {
    expect(contentSecurityPolicy('https://relay.example.test')).toContain("connect-src 'self' https://relay.example.test;");
    expect(contentSecurityPolicy(undefined)).toContain("connect-src 'self';");
  });

  it('are off unless asked for', () => {
    expect(serverHeadersOn({})).toBe(false);
    expect(serverHeadersOn({ SPINE_SERVER_HEADERS: 'on' })).toBe(true);
  });

  const build = async () => {
    const app = Fastify({ logger: false });
    serverHeaders(app, { SPINE_RELAY_URL: 'https://relay.example.test' });
    app.get('/', async () => 'page');
    app.get('/share/abc', async () => 'shared');
    app.get('/.well-known/security.txt', async () => 'contact');
    return app;
  };

  it('are on every answer, an error and a refusal too', async () => {
    const app = await build();
    for (const url of ['/', '/nothing-here', '/.env']) {
      const res = await app.inject({ url });
      expect(res.headers['content-security-policy'], url).toContain('https://relay.example.test');
      expect(res.headers['x-frame-options'], url).toBe('DENY');
      expect(res.headers['strict-transport-security'], url).toBeDefined();
    }
  });

  it('keep a share out of every cache and index, and nothing else', async () => {
    const app = await build();
    const shared = await app.inject({ url: '/share/abc' });
    expect(shared.headers['cache-control']).toBe('no-store');
    expect(shared.headers['x-robots-tag']).toBe('noindex, nofollow');
    const page = await app.inject({ url: '/' });
    expect(page.headers['cache-control']).toBeUndefined();
    expect(page.headers['x-robots-tag']).toBeUndefined();
  });

  it('refuse a path with a dot-file in it, except /.well-known/', async () => {
    const app = await build();
    expect((await app.inject({ url: '/.env' })).statusCode).toBe(403);
    expect((await app.inject({ url: '/assets/.git/config' })).statusCode).toBe(403);
    expect((await app.inject({ url: '/.well-known/security.txt' })).statusCode).toBe(200);
    expect(isDotfilePath('/a.b/c.txt?x=/.y')).toBe(false);
    expect(isDotfilePath('/%2eenv')).toBe(true);
    expect(isDotfilePath('/assets/%2e%2e/%2egit/config')).toBe(true);
    expect(isDotfilePath('/bad%zz')).toBe(true);
  });
});

describe('the platform’s hops in front of the server (SPINE_TRUSTED_HOPS, S-31)', () => {
  const clientOf = async (hops: number, forwarded: string) => {
    const app = Fastify({ logger: false, trustProxy: trustProxySetting({ SPINE_TRUSTED_HOPS: String(hops) }) });
    app.get('/', async req => req.ip);
    return (await app.inject({ url: '/', remoteAddress: '10.0.0.1', headers: { 'x-forwarded-for': forwarded } })).body;
  };

  it('take the address the platform appended, not one the client wrote before it', async () => {
    expect(await clientOf(1, '198.51.100.7')).toBe('198.51.100.7');
    expect(await clientOf(1, '203.0.113.9, 198.51.100.7')).toBe('198.51.100.7');
    expect(await clientOf(1, '203.0.113.9, 203.0.113.10, 198.51.100.7')).toBe('198.51.100.7');
  });

  it('count a load balancer in front as a second hop', async () => {
    expect(await clientOf(2, '203.0.113.9, 198.51.100.7, 35.191.0.1')).toBe('198.51.100.7');
  });

  it('are a depth of 1 to 3, and not mixed with an address list', () => {
    const one = trustProxySetting({ SPINE_TRUSTED_HOPS: '1' }) as (address: string, hop: number) => boolean;
    expect([one('10.0.0.1', 0), one('198.51.100.7', 1)]).toEqual([true, false]);
    for (const bad of ['0', '4', 'true', '-1', '1.5']) expect(() => trustProxySetting({ SPINE_TRUSTED_HOPS: bad }), bad).toThrow(/SPINE_TRUSTED_HOPS/);
    expect(() => trustProxySetting({ SPINE_TRUSTED_HOPS: '1', SPINE_TRUSTED_PROXIES: '10.0.0.1' })).toThrow(/both set/);
    expect(trustProxySetting({})).toEqual(['127.0.0.1', '::1']);
  });
});
