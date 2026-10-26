import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { HttpApp, HttpHandler, HttpHook, HttpReply, HttpRoute, HttpRouteOptions } from 'spine-core/http.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireAuth`. Empty on a route that has not passed through it. */
    userId: string;
  }
}

const streamable = (payload: unknown): payload is AsyncIterable<Uint8Array> =>
  typeof payload === 'object' && payload !== null && Symbol.asyncIterator in payload && !(payload instanceof Readable);

/** Core's reply, over Fastify's: a body that is an async iterable (a file, a zip, a streamed answer) goes out as the stream Fastify wants. */
function replyOf(reply: FastifyReply): HttpReply {
  const wrapped: HttpReply = {
    status(code) { reply.status(code); return wrapped; },
    header(name, value) { reply.header(name, value); return wrapped; },
    type(contentType) { reply.type(contentType); return wrapped; },
    send(payload) { reply.send(streamable(payload) ? Readable.from(payload) : payload); return wrapped; },
    raw: reply.raw,
  };
  return wrapped;
}

type Wrapped = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** A handler or hook written against core's reply, as Fastify calls it. What it returns when it has replied is Fastify's own reply, which is how Fastify knows. */
const handlerOf = (handler: HttpHook | HttpHandler): Wrapped => async (req, reply) => {
  const mine = replyOf(reply);
  const result = await handler(req as never, mine);
  return result === mine ? reply : result;
};

/**
 * Fastify as the app core's routes are written against (`spine-core/http.js`). Core declares only what its routes use of a framework; this
 * registers the routes on Fastify, with the reply core talks to put over Fastify's.
 */
export function asHttp(app: FastifyInstance): HttpApp {
  const route = (method: 'get' | 'post' | 'put' | 'patch' | 'delete'): HttpRoute =>
    ((url: string, a: HttpRouteOptions | HttpHandler, b?: HttpHandler) => {
      const options = typeof a === 'function' ? {} : a;
      const handler = (typeof a === 'function' ? a : b) as HttpHandler;
      const pre = options.preHandler === undefined ? undefined : [options.preHandler].flat().map(handlerOf);
      return app[method](url, pre ? { preHandler: pre as never } : {}, handlerOf(handler) as never);
    }) as HttpRoute;
  return {
    get: route('get'), post: route('post'), put: route('put'), patch: route('patch'), delete: route('delete'),
    addHook: (name, hook) => app.addHook(name, handlerOf(hook) as never),
    decorateRequest: (name, value) => app.decorateRequest(name, value),
  };
}

/** Core's routes, as a Fastify plugin: for the tests that run them on Fastify (the server itself registers none). */
export const asPlugin = <O = undefined>(routes: (app: HttpApp, options: O) => Promise<void>): FastifyPluginAsync<O extends undefined ? Record<never, never> : O & object> =>
  async (app, options) => routes(asHttp(app), options as O);
