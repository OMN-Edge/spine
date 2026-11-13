import { isIP } from 'node:net';

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
  // A function and not Fastify's own number: Fastify refuses a bare hop count (it cannot tell the platform from a client that reached the port), and
  // this is only for a port that the platform alone can reach, which is how Cloud Run serves a container.
  const depth = Number(hops);
  return (_address, hop) => hop < depth;
}
