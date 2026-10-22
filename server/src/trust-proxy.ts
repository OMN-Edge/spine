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
