/**
 * A router with the part of Fastify's interface that the route files use, so the same files answer requests on the device.
 * Nothing is listening: a request is a function call (`inject`), the way the server's own tests make them. See docs/crypto-design.md.
 *
 * What it covers is what `core/src/routes/*.ts` call, and nothing else: app.get/post/put/patch/delete with `{ preHandler }`, addHook
 * ('preHandler' | 'onRequest'), decorateRequest, rateLimit (no limit: nobody else can reach a device), register, and on the request
 * params/query/body/headers/session/log/ip/url/parts, on the reply status/code/header/type/send/raw. Errors answer as Fastify's do.
 * A test runs the same requests against Fastify and against this, and compares.
 */

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type Hook = (req: LocalRequest, reply: LocalReply) => unknown;
type Handler = (req: LocalRequest, reply: LocalReply) => unknown;
interface RouteOptions { preHandler?: Hook | Hook[]; onRequest?: Hook | Hook[]; config?: unknown }

export interface LocalRequest {
  method: string;
  url: string;
  params: Record<string, string>;
  query: Record<string, string | string[]>;
  body: unknown;
  headers: Record<string, string>;
  session: Record<string, unknown> & { destroy(): Promise<void> };
  log: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void; debug(...a: unknown[]): void };
  ip: string;
  userId: string;
  parts(): AsyncIterable<unknown>;
  [extra: string]: unknown;
}

export interface LocalReply {
  sent: boolean;
  statusCode: number;
  status(code: number): LocalReply;
  code(code: number): LocalReply;
  header(name: string, value: string | number): LocalReply;
  type(contentType: string): LocalReply;
  send(payload?: unknown): LocalReply;
  raw: { on(event: string, fn: () => void): void; write(chunk: unknown): boolean; end(): void; writeHead(): void };
}

export interface InjectRequest {
  method: string;
  url: string;
  payload?: unknown;
  headers?: Record<string, string>;
  /** What `req.session` holds for this request; the caller is whoever has unlocked the vault. */
  session?: Record<string, unknown>;
  /** The parts of a multipart upload, as the route's `req.parts()` yields them. */
  parts?: unknown[];
}

export interface InjectResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  /** Set when the body is bytes, not text. */
  bytes?: Uint8Array;
  json<T = unknown>(): T;
  /** Set for a reply written as it goes (the chat's NDJSON): read it as it comes, and call `close` if the reader goes away. */
  stream?: AsyncIterable<Uint8Array>;
  close?: () => void;
}

interface Route { method: Method; pattern: RegExp; keys: string[]; options: RouteOptions; handler: Handler; url: string }

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const compile = (url: string) => {
  const keys: string[] = [];
  const source = url.replace(/[.+*?^${}()|[\]\\]/g, '\\$&').replace(/:([A-Za-z_]\w*)/g, (_m, key) => (keys.push(key), '([^/]+)'));
  return { pattern: new RegExp(`^${source}/?$`), keys };
};

const asBytes = (payload: unknown): Uint8Array | null =>
  payload instanceof Uint8Array ? payload : payload instanceof ArrayBuffer ? new Uint8Array(payload) : null;

async function collect(stream: AsyncIterable<unknown>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : (chunk as Uint8Array));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

export class LocalApp {
  private routes: Route[] = [];
  private hooks: { onRequest: Hook[]; preHandler: Hook[] } = { onRequest: [], preHandler: [] };
  private defaults: Record<string, unknown> = {};
  private routeListeners: Array<(route: { method: string; url: string }) => void> = [];

  private add(method: Method, url: string, a: RouteOptions | Handler, b?: Handler) {
    const options = typeof a === 'function' ? {} : a;
    const handler = (typeof a === 'function' ? a : b) as Handler;
    this.routes.push({ method, url, options, handler, ...compile(url) });
    for (const listener of this.routeListeners) listener({ method, url });
  }

  get = (url: string, a: RouteOptions | Handler, b?: Handler) => this.add('GET', url, a, b);
  post = (url: string, a: RouteOptions | Handler, b?: Handler) => this.add('POST', url, a, b);
  put = (url: string, a: RouteOptions | Handler, b?: Handler) => this.add('PUT', url, a, b);
  patch = (url: string, a: RouteOptions | Handler, b?: Handler) => this.add('PATCH', url, a, b);
  delete = (url: string, a: RouteOptions | Handler, b?: Handler) => this.add('DELETE', url, a, b);

  addHook(name: string, fn: Hook | ((route: { method: string | string[]; url: string }) => void)): void {
    if (name === 'onRoute') this.routeListeners.push(fn as never);
    else if (name === 'preHandler' || name === 'onRequest') this.hooks[name].push(fn as Hook);
    else throw new Error(`LocalApp has no "${name}" hook`);
  }

  decorateRequest(name: string, value: unknown): void { this.defaults[name] = value; }
  addContentTypeParser(): void { /* bodies reach the router already parsed */ }
  /** There is no one to limit on a device; the call stays so a route file reads the same here. */
  rateLimit(): Hook { return () => undefined; }

  async register<O>(plugin: (app: LocalApp, options: O) => Promise<void> | void, options?: O): Promise<void> {
    await plugin(this, (options ?? {}) as O);
  }

  async inject(input: InjectRequest): Promise<InjectResponse> {
    const [path, search = ''] = input.url.split('?', 2);
    const method = input.method.toUpperCase();
    const route = this.routes.find(r => r.method === method && r.pattern.test(path));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = v;

    const closers: Array<() => void> = [];
    const out = { status: 200, headers: {} as Record<string, string>, payload: undefined as unknown, sent: false };
    const reply: LocalReply = {
      get sent() { return out.sent; },
      get statusCode() { return out.status; },
      status(code) { out.status = code; return reply; },
      code(code) { out.status = code; return reply; },
      header(name, value) { out.headers[name.toLowerCase()] = String(value); return reply; },
      type(contentType) { out.headers['content-type'] = contentType; return reply; },
      send(payload) { out.payload = payload; out.sent = true; return reply; },
      raw: { on(event: string, fn: () => void) { if (event === 'close') closers.push(fn); }, write() { return true; }, end() {}, writeHead() {} },
    } as LocalReply;

    const finish = async (): Promise<InjectResponse> => {
      let payload = out.payload;
      if (payload && typeof payload === 'object' && Symbol.asyncIterator in payload && (out.headers['content-type'] ?? '').includes('ndjson')) {
        // Written as it goes: handed on as it comes, and the route is told when the reader leaves, so it stops the model call.
        const source = payload as AsyncIterable<unknown>;
        const encoder = new TextEncoder();
        const stream = (async function* () { for await (const chunk of source) yield typeof chunk === 'string' ? encoder.encode(chunk) : (chunk as Uint8Array); })();
        return { statusCode: out.status, headers: out.headers, body: '', stream, close: () => { for (const fn of closers) fn(); (source as { destroy?: () => void }).destroy?.(); }, json: () => { throw new Error('a stream has no body to parse'); } } as InjectResponse;
      }
      if (payload && typeof payload === 'object' && Symbol.asyncIterator in payload) payload = await collect(payload as AsyncIterable<unknown>);
      const bytes = asBytes(payload);
      let body = '';
      if (bytes) {
        out.headers['content-type'] ??= 'application/octet-stream';
      } else if (typeof payload === 'string') {
        out.headers['content-type'] ??= 'text/plain; charset=utf-8';
        body = payload;
      } else if (payload !== undefined) {
        out.headers['content-type'] ??= 'application/json; charset=utf-8';
        body = JSON.stringify(payload);
      }
      return { statusCode: out.status, headers: out.headers, body, bytes: bytes ?? undefined, json: <T>() => JSON.parse(body) as T };
    };
    const fail = (status: number, error: string, message: string) => {
      out.status = status;
      out.headers = { 'content-type': 'application/json; charset=utf-8' };
      out.payload = { statusCode: status, error, message };
      out.sent = true;
    };

    if (!route) { fail(404, 'Not Found', `Route ${method}:${path} not found`); return finish(); }

    const params: Record<string, string> = {};
    const match = route.pattern.exec(path)!;
    route.keys.forEach((key, i) => { params[key] = decodeURIComponent(match[i + 1]); });
    const query: Record<string, string | string[]> = {};
    for (const [k, v] of new URLSearchParams(search)) {
      const have = query[k];
      query[k] = have === undefined ? v : Array.isArray(have) ? [...have, v] : [have, v];
    }
    let body = input.payload;
    if (typeof body === 'string' && (headers['content-type'] ?? '').includes('json')) {
      try { body = JSON.parse(body); } catch { fail(400, 'Bad Request', 'Body is not valid JSON'); return finish(); }
    }

    const session = Object.assign({ destroy: async () => { for (const k of Object.keys(session)) if (k !== 'destroy') delete session[k]; } }, input.session);
    const req: LocalRequest = Object.assign({}, this.defaults, {
      method, url: input.url, params, query, body, headers, session, log: quiet, ip: '127.0.0.1', userId: '',
      parts: () => (async function* () { for (const p of input.parts ?? []) yield p; })(),
    }) as LocalRequest;

    const listOf = (h?: Hook | Hook[]) => (h === undefined ? [] : Array.isArray(h) ? h : [h]);
    try {
      for (const hook of [...this.hooks.onRequest, ...listOf(route.options.onRequest), ...this.hooks.preHandler, ...listOf(route.options.preHandler)]) {
        const result = await hook(req, reply);
        if (out.sent) return finish();
        void result;
      }
      const result = await route.handler(req, reply);
      if (!out.sent && result !== undefined && result !== reply) { out.payload = result; out.sent = true; }
      if (!out.sent) throw new Error('Promise may not be fulfilled with \'undefined\' when statusCode is not 204');
    } catch (err) {
      const e = err as { statusCode?: number; message?: string; name?: string };
      const status = e.statusCode && e.statusCode >= 400 ? e.statusCode : 500;
      // What the server's log would say: the request and the failure's own words.
      if (status >= 500) console.error('a request failed', method, path, e.message ?? String(err));
      fail(status, status === 500 ? 'Internal Server Error' : (e.name ?? 'Error'), e.message ?? String(err));
    }
    return finish();
  }
}
