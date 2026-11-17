import type { FastifyInstance } from 'fastify';

/**
 * Whether the process is up, for a platform that asks before it sends traffic and while it runs (Cloud Run's startup and liveness checks, a load
 * balancer). It answers from the process and touches nothing, so it costs nothing to ask and says nothing about the database: the server does not listen
 * until it has opened its store (index.ts), so an answer means the start went through.
 */
export async function healthRoutes(app: FastifyInstance) {
  app.get('/healthz', async (_req, reply) => reply.header('Cache-Control', 'no-store').type('text/plain; charset=utf-8').send('ok\n'));
}
