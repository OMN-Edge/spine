import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { verifyToken } from './token.js';

/**
 * The relay: the one thing between a device and the model provider (docs/crypto-design.md, SECURITY.md M-35). A device cannot hold
 * Spine's Google credential, so it sends the request here with a pass from the Spine server, and the relay adds the credential and
 * forwards it to the configured regional endpoint.
 *
 * What it keeps to: it **stores nothing and logs no content**. A request is read, forwarded and answered; the only things written down
 * are the model, the status, the sizes and the time. It forwards only the calls Spine makes (generate, stream, embed) to the project,
 * region and models it was configured with, so a pass cannot be used to reach anything else the credential can. It does see what passes
 * through it, in plaintext: it ends the TLS connection. That is why the words are "does not store or log", not "cannot see".
 */
export interface RelayTarget { model: string; endpoint: string; project: string; region: string }

export interface RelayConfig {
  secret: string;
  /** What may be called and where it goes: the models Spine uses, each at the regional host stated for it (residency is a property of it). */
  targets: RelayTarget[];
  /** The address the app is served from, which the browser needs to be told it may call this service. */
  allowedOrigin: string;
  /** Calls a user may make a day; the count is kept in this process, so run one instance to make it exact. */
  dailyCalls: number;
  maxBodyBytes: number;
  accessToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  log?: (line: Record<string, unknown>) => void;
  now?: () => number;
}

const METHODS = ['generateContent', 'streamGenerateContent', 'embedContent', 'predict'];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createRelay(config: RelayConfig) {
  const call = config.fetchImpl ?? fetch;
  const now = config.now ?? Date.now;
  const log = config.log ?? (() => undefined);
  const allowed = config.targets.map(t => ({
    target: t,
    pattern: new RegExp(`^/v1/projects/${escape(t.project)}/locations/${escape(t.region)}/publishers/google/models/${escape(t.model)}:(${METHODS.join('|')})$`),
  }));
  const used = new Map<string, { day: string; calls: number }>();

  const reply = (res: ServerResponse, status: number, error: string) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error }));
  };

  /** Counts a call against the user's day; false if there is none left. */
  function spend(userId: string): boolean {
    const day = new Date(now()).toISOString().slice(0, 10);
    const have = used.get(userId);
    if (!have || have.day !== day) { used.set(userId, { day, calls: 1 }); return true; }
    if (have.calls >= config.dailyCalls) return false;
    have.calls++;
    return true;
  }

  async function body(req: IncomingMessage): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > config.maxBodyBytes) return null;
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = now();
    res.setHeader('access-control-allow-origin', config.allowedOrigin);
    res.setHeader('vary', 'origin');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '600' });
      return void res.end();
    }
    if (req.method === 'GET' && req.url === '/healthz') return reply(res, 200, 'ok');

    const [path, query = ''] = (req.url ?? '').split('?', 2);
    const found = allowed.find(a => a.pattern.test(path));
    const match = found && ([, found.target.model, /:(\w+)$/.exec(path)![1]] as const);
    if (req.method !== 'POST' || !found || !match) return reply(res, 404, 'not a call this service makes');
    // Only the one query a streamed answer needs.
    if (query !== '' && query !== 'alt=sse') return reply(res, 400, 'unexpected query');

    const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    const who = bearer ? verifyToken(config.secret, bearer, now()) : null;
    if (!who) return reply(res, 401, 'sign in again');
    if (!spend(who.userId)) return reply(res, 429, 'the daily allowance of model calls is used up');

    const payload = await body(req);
    if (!payload) return reply(res, 413, 'too large');

    let upstream: Response;
    try {
      upstream = await call(`https://${found.target.endpoint}${path}${query ? `?${query}` : ''}`, {
        method: 'POST',
        // Only these go on: nothing the device sent, its cookies and address included, reaches the provider.
        headers: { authorization: `Bearer ${await config.accessToken()}`, 'content-type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(180_000),
      });
    } catch {
      log({ model: match[1], method: match[2], status: 502, bytes_in: payload.length, ms: now() - started });
      return reply(res, 502, 'the model provider could not be reached');
    }

    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });
    if (upstream.body) await new Promise<void>(resolve => Readable.fromWeb(upstream.body as never).on('error', resolve).on('end', resolve).pipe(res));
    else res.end();
    log({ model: match[1], method: match[2], status: upstream.status, bytes_in: payload.length, ms: now() - started });
  };
}
