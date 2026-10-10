import type { FastifyInstance } from 'fastify';
import { getStore } from '../store/index.js';
import { requireAuth } from './middleware.js';

export async function tagRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/tags', async (req, reply) => {
    const tags = await getStore().tags.listFor(req.userId);
    return reply.send(tags);
  });
}
