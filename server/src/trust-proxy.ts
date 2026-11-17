import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';

/**
 * The addresses Fastify believes when they send `X-Forwarded-For`: nginx on this host and no one else
 * (SECURITY.md S-31). With `true`, the leftmost entry is trusted, and nginx appends to whatever the
 * client sent, so a client could choose its own `req.ip` and with it every limiter keyed on it.
 * Listing the proxy makes Fastify take the entry the proxy added.
 */
export const TRUSTED_PROXIES = ['127.0.0.1', '::1'];

/**
 * Loopback, plus the proxy's own address when it is not on this host: `SPINE_TRUSTED_PROXIES`, comma separated addresses
 * (the Docker Compose setup pins its proxy to one). A range that would trust the world (`0.0.0.0/0`, `::/0`, anything under
 * /8) or a word like `true` stops the process, because it hands every client the choice of its own address (S-31).
 */
export function trustedProxies(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.SPINE_TRUSTED_PROXIES ?? '').split(',').map(s => s.trim()).filter(Boolean);
  for (const entry of extra) {
    const [address, bits, ...rest] = entry.split('/');
    const family = isIP(address);
    const max = family === 4 ? 32 : 128;
    const prefix = bits === undefined ? max : /^\d+$/.test(bits) ? Number(bits) : NaN;
    const widest = family === 4 ? 8 : 32;
    if (!family || rest.length > 0 || !(prefix <= max) || prefix < widest) {
      throw new Error(`SPINE_TRUSTED_PROXIES: "${entry}" is not an address or a range of at most a /${widest} width; a proxy is trusted by its address, never by a wide range`);
    }
  }
  return [...TRUSTED_PROXIES, ...extra];
}

/**
 * What Fastify is told to believe. Behind Caddy, nginx or a proxy at a known address, the addresses of `trustedProxies`. Where the platform's own front end
 * is the proxy and has no address to name (Cloud Run), `SPINE_TRUSTED_HOPS`: how many hops of `X-Forwarded-For`, counting from the server's end, are
 * the platform's. The platform appends the address it saw, so with 1 the client is the last entry and anything the client sent before it is ignored
 * (an entry it made up sits to the left of the one the platform added); with a load balancer in front of Cloud Run, 2. A count that is too large trusts
 * entries the client wrote, so it is bounded and a wrong one fails at start. Use it only where the platform alone can reach the port (a Cloud Run container): on a machine whose port a client can reach, a client would write the whole header. The two settings do not mix: one names addresses, the other a depth.
 */
export function trustProxySetting(env: NodeJS.ProcessEnv = process.env): string[] | ((address: string, hop: number) => boolean) {
  const hops = (env.SPINE_TRUSTED_HOPS ?? '').trim();
  if (!hops) return trustedProxies(env);
  if ((env.SPINE_TRUSTED_PROXIES ?? '').trim()) throw new Error('SPINE_TRUSTED_HOPS and SPINE_TRUSTED_PROXIES are both set: use the one that says how the proxy is known (S-31)');
  if (!/^[1-3]$/.test(hops)) throw new Error(`SPINE_TRUSTED_HOPS: "${hops}" is not 1, 2 or 3; it counts the platform's own hops in front of the server, and a larger number would believe what the client wrote (S-31)`);
  edgeSecret(env); // a depth is believed only for a request that carries the proof it came through the platform (S-68)
  // A function and not Fastify's own number: Fastify refuses a bare hop count (it cannot tell the platform from a client that reached the port),
  // so `edgeCheck` is what tells them apart: a request without the platform's secret loses its forwarding headers before anything reads an address.
  const depth = Number(hops);
  return (_address, hop) => hop < depth;
}

/** The header the platform's front end adds to every request it forwards, carrying `SPINE_EDGE_SECRET`. */
export const EDGE_HEADER = 'x-spine-edge';

const MIN_EDGE_SECRET = 32;

/**
 * The secret a load balancer in front of the server adds as `X-Spine-Edge` (a custom request header of the backend service). It is what tells a request the
 * platform forwarded from one a client sent to the port itself, which `SPINE_TRUSTED_HOPS` cannot (S-68): required with the hops, refused without them.
 * The one exception is a Cloud Run service reached through its own front end (a domain mapping or its `run.app` address) with a single hop: Cloud Run sets
 * `K_SERVICE` in the container, and nothing but Google's front end can reach the port, so there is no one to prove it against.
 */
export function edgeSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = (env.SPINE_EDGE_SECRET ?? '').trim();
  const hops = (env.SPINE_TRUSTED_HOPS ?? '').trim();
  if (!hops) {
    if (secret) throw new Error('SPINE_EDGE_SECRET is set without SPINE_TRUSTED_HOPS: the secret only proves a request came through the platform whose hops are counted');
    return null;
  }
  if (!secret) {
    if (hops === '1' && (env.K_SERVICE ?? '').trim()) return null;
    throw new Error('SPINE_TRUSTED_HOPS needs SPINE_EDGE_SECRET, the value the load balancer adds as X-Spine-Edge, so that a request a client sent to the port itself cannot choose its own address (S-68); only a Cloud Run service reached directly (K_SERVICE set) with one hop may go without');
  }
  if (secret.length < MIN_EDGE_SECRET) throw new Error(`SPINE_EDGE_SECRET is ${secret.length} characters; it needs at least ${MIN_EDGE_SECRET} (openssl rand -base64 48)`);
  return secret;
}

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
let lastWarned = 0;

/**
 * Before anything reads an address: a request that does not carry `SPINE_EDGE_SECRET` in `X-Spine-Edge` did not come through the platform, so what it says
 * about itself is not believed. Its forwarding headers are dropped and its address is the one it connected from. The header itself is always dropped, so the
 * secret reaches no handler and no log. Register it first.
 */
export function edgeCheck(app: FastifyInstance, env: NodeJS.ProcessEnv = process.env): void {
  const secret = edgeSecret(env);
  if (secret === null) return;
  const wanted = digest(secret);
  app.addHook('onRequest', async req => {
    const given = req.headers[EDGE_HEADER];
    delete req.headers[EDGE_HEADER];
    if (typeof given === 'string' && timingSafeEqual(digest(given), wanted)) return;
    for (const name of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded']) delete req.headers[name];
    // The platform's own probes arrive this way too; once a minute is enough to see that something else is reaching the port.
    if (Date.now() - lastWarned > 60_000) {
      lastWarned = Date.now();
      req.log.warn('a request reached the port without the platform’s X-Spine-Edge: its forwarding headers were ignored');
    }
  });
}
