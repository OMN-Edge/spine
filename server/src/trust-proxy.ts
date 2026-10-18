/**
 * The addresses Fastify believes when they send `X-Forwarded-For`: nginx on this host and no one else
 * (SECURITY.md S-31). With `true`, the leftmost entry is trusted, and nginx appends to whatever the
 * client sent, so a client could choose its own `req.ip` and with it every limiter keyed on it.
 * Listing the proxy makes Fastify take the entry the proxy added.
 */
export const TRUSTED_PROXIES = ['127.0.0.1', '::1'];
