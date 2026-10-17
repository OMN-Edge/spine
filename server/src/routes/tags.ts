import type { FastifyInstance } from 'fastify';
import { getStore } from '../store/index.js';
import { requireAuth } from './middleware.js';
import { MAX_TAG_LENGTH } from '../tags.js';

const MAX_PROVIDER_LENGTH = 200;

/**
 * The names the app extracted and reuses, kept by the person: tags here, providers beside them. (Doctors have
 * their own routes, and tests are managed with their trends in `trends.ts`.) Every call is scoped to the signed-in
 * user by the store (P12); an id that is not theirs is a 404.
 */
export async function tagRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  const tagId = (value: unknown): number | null => {
    const n = typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : NaN;
    return Number.isSafeInteger(n) ? n : null;
  };

  // Each tag with how many documents carry it.
  app.get('/api/tags', async (req, reply) => {
    return reply.send(await getStore().tags.listWithCounts(req.userId));
  });

  // Rename a tag. A name another tag has makes the two one (`merged`).
  app.patch<{ Params: { id: string }; Body: { name?: unknown } }>('/api/tags/:id', async (req, reply) => {
    const id = tagId(req.params.id);
    const name = req.body?.name;
    if (id === null) return reply.status(404).send({ error: 'not found' });
    if (typeof name !== 'string' || name.trim() === '' || name.length > MAX_TAG_LENGTH * 2) {
      return reply.status(400).send({ error: `name must be 1 to ${MAX_TAG_LENGTH} characters` });
    }
    const result = await getStore().tags.rename(req.userId, id, name);
    if (result === 'not_found') return reply.status(404).send({ error: 'not found' });
    if (result === 'invalid') return reply.status(400).send({ error: 'name must have something in it' });
    return reply.send({ result });
  });

  app.post<{ Params: { id: string }; Body: { into?: unknown } }>('/api/tags/:id/merge', async (req, reply) => {
    const from = tagId(req.params.id);
    const into = typeof req.body?.into === 'number' && Number.isSafeInteger(req.body.into) ? req.body.into : null;
    if (from === null) return reply.status(404).send({ error: 'not found' });
    if (into === null) return reply.status(400).send({ error: 'into must be a tag id' });
    const result = await getStore().tags.merge(req.userId, from, into);
    if (result === 'same') return reply.status(400).send({ error: 'a tag cannot be merged into itself' });
    if (result === 'not_found') return reply.status(404).send({ error: 'not found' });
    return reply.send({ result });
  });

  app.delete<{ Params: { id: string } }>('/api/tags/:id', async (req, reply) => {
    const id = tagId(req.params.id);
    if (id === null || !(await getStore().tags.remove(req.userId, id))) return reply.status(404).send({ error: 'not found' });
    return reply.send({ removed: true });
  });

  // Providers are the clinic or laboratory names on documents, as extraction wrote them.
  app.get('/api/providers', async (req, reply) => {
    return reply.send(await getStore().documents.providers(req.userId));
  });

  // Every document with provider `from` gets `to`. An empty `to` clears it. A name another provider has makes the two one.
  app.post<{ Body: { from?: unknown; to?: unknown } }>('/api/providers/rename', async (req, reply) => {
    const { from, to } = req.body ?? {};
    if (typeof from !== 'string' || from === '' || from.length > MAX_PROVIDER_LENGTH) return reply.status(400).send({ error: 'from must be a provider name' });
    if (to !== null && to !== undefined && (typeof to !== 'string' || to.length > MAX_PROVIDER_LENGTH)) {
      return reply.status(400).send({ error: `to must be a name of at most ${MAX_PROVIDER_LENGTH} characters, or empty` });
    }
    const name = typeof to === 'string' ? to.trim().replace(/\s+/g, ' ') : '';
    const changed = await getStore().documents.renameProvider(req.userId, from, name === '' ? null : name);
    if (changed === 0) return reply.status(404).send({ error: 'not found' });
    return reply.send({ changed });
  });
}
