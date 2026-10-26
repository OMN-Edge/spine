/**
 * What the route files need of a web framework, as core's own types: a request has params, query, body, headers, an address, a log and the
 * person `requireAuth` found; a reply takes a status, headers and a payload; an app registers routes and hooks. The server's tests run the
 * routes on Fastify and the device runs them on its own router (`web/src/core/local-app.ts`); both are adapted to these (`asHttp` in
 * `server/src/http-host.ts`), and core imports no framework. A route that needs something not here adds it here, and both hosts must give it.
 */

/** The shape of a route's `Params`, `Querystring` and `Body`, named as Fastify names them. Anything not given is unknown. */
export interface RouteShape { Params?: unknown; Querystring?: unknown; Body?: unknown }

export interface HttpLog {
  info(obj: object | string, message?: string): void;
  warn(obj: object | string, message?: string): void;
  error(obj: object | string, message?: string): void;
  debug(obj: object | string, message?: string): void;
}

/** Bytes that arrive in pieces. A stream cut at the upload limit flags itself with `truncated` instead of failing. */
export type ByteSource = AsyncIterable<Uint8Array> & { truncated?: boolean };

/** One part of a multipart upload: a field with its value, or a file with its stream. */
export type UploadPart =
  | { type: 'field'; fieldname: string; value: unknown }
  | { type: 'file'; fieldname: string; filename?: string; mimetype?: string; file: ByteSource };

export interface HttpRequest<R extends RouteShape = RouteShape> {
  readonly method: string;
  readonly url: string;
  readonly params: R extends { Params: infer P } ? P : unknown;
  readonly query: R extends { Querystring: infer Q } ? Q : unknown;
  readonly body: R extends { Body: infer B } ? B : unknown;
  readonly headers: Record<string, string | undefined>;
  readonly ip: string;
  readonly log: HttpLog;
  /** Set by `requireAuth`. Empty on a route that has not passed through it. */
  userId: string;
  /** The parts of a multipart request, as they arrive. */
  parts(): AsyncIterable<UploadPart>;
}

export interface HttpReply {
  status(code: number): HttpReply;
  header(name: string, value: string | number): HttpReply;
  type(contentType: string): HttpReply;
  send(payload?: unknown): HttpReply;
  /** The connection under the reply: a streamed reply is told when the reader goes away. */
  readonly raw: { on(event: 'close', listener: () => void): unknown };
}

export type HttpHook = (req: HttpRequest, reply: HttpReply) => unknown;
export type HttpHandler<R extends RouteShape = RouteShape> = (req: HttpRequest<R>, reply: HttpReply) => unknown;

export interface HttpRouteOptions { preHandler?: HttpHook | HttpHook[] }

export interface HttpRoute {
  <R extends RouteShape = RouteShape>(url: string, handler: HttpHandler<R>): unknown;
  <R extends RouteShape = RouteShape>(url: string, options: HttpRouteOptions, handler: HttpHandler<R>): unknown;
}

export interface HttpApp {
  get: HttpRoute;
  post: HttpRoute;
  put: HttpRoute;
  patch: HttpRoute;
  delete: HttpRoute;
  addHook(name: 'preHandler', hook: HttpHook): unknown;
  /** Declares the `userId` property of a request, before any route. */
  decorateRequest(name: 'userId', value: string): unknown;
}
