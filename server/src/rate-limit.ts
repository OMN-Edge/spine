import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * A fixed-window counter, keyed by whatever the caller chooses.
 *
 * `@fastify/rate-limit` marks a request with a per-request symbol and skips any
 * further limiter on the same request, so a route cannot stack a per-source limit
 * with a per-address one using the plugin alone. This covers the second kind:
 * "no more than N of these per address", and the instance-wide caps.
 *
 * In memory and per process, which is all one process needs. Expired keys are
 * dropped as they are met, so the map does not grow without bound.
 */
export interface WindowLimit {
  max: number;
  windowMs: number;
}

/** The most keys one limiter holds; an attacker with a great many source addresses cannot make the map grow past it. */
const MAX_KEYS = 100_000;

export function windowLimiter(
  limit: WindowLimit,
  keyOf: (req: FastifyRequest) => string | null,
  message = 'too many requests, try again later',
) {
  const windows = new Map<string, { start: number; count: number }>();

  return async function enforce(req: FastifyRequest, reply: FastifyReply) {
    const key = keyOf(req);
    if (key === null) return; // nothing to key on (e.g. no email in the body)

    const now = Date.now();
    // The map is in the order the windows began (a key is added when its window starts and removed when it ends), so the first key that has
    // not expired ends the walk: a request pays for the keys that ended, not for every key there is (SECURITY.md S-53).
    for (const [k, w] of windows) {
      if (now - w.start < limit.windowMs) break;
      windows.delete(k);
    }
    // And never more keys than a small host should hold: past the ceiling the oldest windows end early.
    while (windows.size >= MAX_KEYS) windows.delete(windows.keys().next().value as string);

    const current = windows.get(key) ?? { start: now, count: 0 };
    current.count += 1;
    windows.set(key, current);

    if (current.count > limit.max) {
      req.log.warn({ ip: req.ip, ...limit }, 'rate limit exceeded');
      return reply.status(429).send({ error: message });
    }
  };
}
