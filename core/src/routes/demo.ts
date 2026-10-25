import type { FastifyInstance } from 'fastify';
import { DEMO_LANGUAGES, type DemoLanguage } from '../demo/records.js';
import { demoState, loadDemo, removeDemo } from '../demo/index.js';
import { requireAuth } from './middleware.js';

export async function demoRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/demo', async (req, reply) => reply.header('Cache-Control', 'no-store').send(await demoState(req.userId)));

  // Sample records for trying Spine before uploading anything real: invented, in English or Romanian, written without a model.
  app.post<{ Body: { language?: unknown } }>('/api/demo', async (req, reply) => {
    const language = req.body?.language ?? 'en';
    if (!DEMO_LANGUAGES.includes(language as DemoLanguage)) return reply.status(400).send({ error: `language must be one of ${DEMO_LANGUAGES.join(', ')}` });
    if ((await loadDemo(req.userId, language as DemoLanguage)) === 'already') return reply.status(409).send({ error: 'the sample records are already there' });
    return reply.status(202).send(await demoState(req.userId));
  });

  app.delete('/api/demo', async (req, reply) => {
    const outcome = await removeDemo(req.userId);
    if (outcome === 'busy') return reply.status(409).send({ error: 'the sample records are still being set up' });
    if (outcome === 'none') return reply.status(404).send({ error: 'there are no sample records' });
    return reply.send({ removed: true });
  });
}
