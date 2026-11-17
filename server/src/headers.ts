import type { FastifyInstance } from 'fastify';

/**
 * The headers Caddy and nginx put on every answer (`Caddyfile`, `nginx/spine.conf`), for a deployment with no proxy of ours in front, such as
 * Cloud Run (docs/deploy-cloud-run.md): `SPINE_SERVER_HEADERS=on`. Off by default, because behind Caddy or nginx the proxy sets them and a second
 * copy would be a second header; `headers.test.ts` holds that the server's text is the Caddyfile's and nginx's, word for word.
 *
 * Also what those proxies refuse and the server alone would serve: a path with a dot-file in it (`@dotfiles` in the Caddyfile), except `/.well-known/`.
 */
export function contentSecurityPolicy(relayUrl: string | undefined): string {
  const relay = (relayUrl ?? '').trim();
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob:",
    "font-src 'self'",
    `connect-src 'self'${relay ? ` ${relay}` : ''}`,
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

export const PERMISSIONS_POLICY =
  'accelerometer=(), camera=(self), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()';

export function securityHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': PERMISSIONS_POLICY,
    'content-security-policy': contentSecurityPolicy(env.SPINE_RELAY_URL),
  };
}

export const serverHeadersOn = (env: NodeJS.ProcessEnv = process.env): boolean => (env.SPINE_SERVER_HEADERS ?? 'off') === 'on';

/** A dot-file anywhere in the path, which only `/.well-known/` may be (what the Caddyfile's `@dotfiles` and nginx's `location ~ /\.` deny). */
export const isDotfilePath = (url: string): boolean => {
  const raw = url.split('?', 1)[0];
  // As it will be read, not as it was written: `%2e` is a dot to the static files' route
  let path = raw;
  try { path = decodeURIComponent(raw); } catch { return true; } // not a path that can be read is not one to serve
  return (/\/\./.test(path) || /\/\./.test(raw)) && !path.startsWith('/.well-known/');
};

export function serverHeaders(app: FastifyInstance, env: NodeJS.ProcessEnv = process.env): void {
  const fixed = securityHeaders(env);
  app.addHook('onRequest', async (req, reply) => {
    if (!isDotfilePath(req.url)) return;
    for (const [name, value] of Object.entries(fixed)) reply.header(name, value);
    return void reply.status(403).send('forbidden');
  });
  app.addHook('onSend', async (req, reply, payload) => {
    for (const [name, value] of Object.entries(fixed)) reply.header(name, value);
    // A share's page and its sealed copy are never kept or indexed (SECURITY.md, shares)
    if (req.url.startsWith('/share/')) {
      reply.header('x-robots-tag', 'noindex, nofollow');
      reply.header('cache-control', 'no-store');
    }
    return payload;
  });
}
