import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Where a request that changes something may come from (SECURITY.md S-50). The session cookie is SameSite strict, but a sibling subdomain counts
 * as the same site, so a script on the checkout's origin (which the docs put at `pay.<your domain>`, and which belongs to the payment provider's
 * page) could make a request the cookie goes with. A browser says where a request came from (`Sec-Fetch-Site`, and `Origin`), and a state-changing
 * request to the API that did not come from the app's own origin is refused. A client that is not a browser sends neither header and is not a
 * way to use someone's cookie, so it is not asked. The payment provider's notification is its own, checked by its signature.
 */
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const NOT_BROWSER_CALLS = new Set(['/api/billing/webhook']);

export async function sameOriginOnly(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (SAFE.has(req.method)) return;
  const path = req.url.split('?', 1)[0];
  if (!path.startsWith('/api/') || NOT_BROWSER_CALLS.has(path)) return;
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string') {
    if (site === 'same-origin' || site === 'none') return;
  } else {
    const origin = req.headers.origin;
    if (typeof origin !== 'string') return;
    try {
      if (new URL(origin).host === req.headers.host) return;
    } catch { /* `null`, or not an address: not the app's */ }
  }
  req.log.warn({ ip: req.ip, path, site: site ?? null }, 'a request that changes something came from another origin');
  return void reply.status(403).send({ error: 'this request did not come from the app', code: 'cross_site' });
}
