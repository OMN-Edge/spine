import { createHash } from 'node:crypto';
import { getAccountsStore } from 'spine-core/store/index.js';

/**
 * Where the server's request limits are counted (`SPINE_LIMITS`): `memory` (default), in the process, which is exactly right for one instance and for
 * the instances of a host that each keep their own count, or `store`, in the accounts database, where every instance counts into the same window, so
 * that N instances allow what one did and not N times as much. A limit that guards a password or a mail cannot be N times weaker because the service
 * was scaled; `store` is for any deployment that runs more than one instance (docs/deploy-cloud-run.md). The price is a write to the database for each
 * limited request, and the limited requests are the sign-in, sign-up, share-access and recovery ones, not a page or a read.
 */
export type LimitsWhere = 'memory' | 'store';

export function limitsWhere(env: NodeJS.ProcessEnv = process.env): LimitsWhere {
  const where = (env.SPINE_LIMITS ?? 'memory').trim();
  if (where !== 'memory' && where !== 'store') throw new Error(`SPINE_LIMITS is "${where}"; expected memory or store`);
  return where;
}

/** One more request in the window of this limiter's key: its count in the window, shared by every instance. A failure is the caller's to decide. */
export const countInStore = (limiter: string, subject: string, windowMs: number, now = Date.now()): Promise<number> =>
  getAccountsStore().maintenance.hitWindow(limiter, keyOf(subject), windowMs, now);

/**
 * What is counted is bounded: a key a client chooses (an address in a request's body can be a megabyte) is more than an index row can hold, and a count
 * that fails lets the request through, so a long key must not be a way past a limit. A long one is counted under its hash.
 */
const MAX_KEY = 200;
const keyOf = (subject: string): string => (subject.length <= MAX_KEY ? subject : `sha256:${createHash('sha256').update(subject).digest('hex')}`);

/**
 * The store `@fastify/rate-limit` counts in when the limits are shared: it keeps one window per route (the route's method and address, and for a
 * limiter made by `app.rateLimit()` in a handler's options, the order in which the process made it, the same for every instance of one build) and per
 * source. A limiter that fails to count lets the request through and says so, as the plugin's own `skipOnError` would; the database is needed for the
 * request anyway, so a limiter cannot be the thing that is down.
 */
export class SharedRateLimitStore {
  private readonly scope: string;
  private anonymous = 0;
  // The plugin makes the first one with its own settings, which count nothing: only the ones it makes for a route do.
  constructor(scope?: unknown) { this.scope = typeof scope === 'string' ? scope : ''; }

  child(routeOptions: { routeInfo?: { method?: string | string[]; url?: string } }): SharedRateLimitStore {
    const info = routeOptions.routeInfo ?? {};
    const method = Array.isArray(info.method) ? info.method.join(',') : info.method;
    const name = info.url ? `${method ?? ''} ${info.url}` : `handler#${this.anonymous++}`;
    return new SharedRateLimitStore(`plugin ${name}`);
  }

  incr(subject: string, cb: (err: Error | null, res?: { current: number; ttl: number }) => void, timeWindow: number): void {
    const now = Date.now();
    countInStore(this.scope, subject, timeWindow, now).then(
      current => cb(null, { current, ttl: timeWindow }),
      err => cb(err instanceof Error ? err : new Error(String(err))),
    );
  }
}
