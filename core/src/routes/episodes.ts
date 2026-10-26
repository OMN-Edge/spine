import type { HttpApp } from '../http.js';
import { v4 as uuidv4 } from 'uuid';
import { getStore, type EpisodeState } from '../store/index.js';
import { proposeEpisodes } from '../episodes/index.js';
import { requireAuth } from './middleware.js';

const MAX_TITLE = 120;
const MAX_DOCUMENTS = 200;

/** Control characters out, whitespace collapsed; a title is the owner's own words and is shown as text. */
const cleanTitle = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const title = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return title.length <= MAX_TITLE ? title : null;
};

const ids = (value: unknown): string[] | null =>
  Array.isArray(value) && value.length > 0 && value.length <= MAX_DOCUMENTS && value.every(v => typeof v === 'string' && v.length > 0) ? [...new Set(value as string[])] : null;

export async function episodeRoutes(app: HttpApp) {
  app.addHook('preHandler', requireAuth);

  // The owner's episodes, with their documents' ids and dates. Dismissed ones are left out unless asked for.
  app.get<{ Querystring: { state?: string } }>('/api/episodes', async (req, reply) => {
    const wanted = req.query.state === 'all' ? undefined : (['proposed', 'confirmed', 'dismissed'] as EpisodeState[]).filter(s => (req.query.state ? s === req.query.state : s !== 'dismissed'));
    return reply.header('Cache-Control', 'no-store').send(await getStore().episodes.list(req.userId, wanted));
  });

  // The owner groups documents themselves: confirmed at once, and the documents leave any other episode they were in.
  app.post<{ Body: { title?: unknown; document_ids?: unknown } }>('/api/episodes', async (req, reply) => {
    const title = req.body?.title === undefined ? '' : cleanTitle(req.body.title);
    const documentIds = ids(req.body?.document_ids);
    if (title === null) return reply.status(400).send({ error: `title must be text of at most ${MAX_TITLE} characters` });
    if (!documentIds) return reply.status(400).send({ error: 'document_ids must name 1 to 200 documents' });
    const id = uuidv4();
    if (!(await getStore().episodes.create(req.userId, { id, title, state: 'confirmed', source: 'owner', documentIds }, new Date().toISOString()))) {
      return reply.status(404).send({ error: 'one or more documents were not found' });
    }
    return reply.status(201).send(await getStore().episodes.find(req.userId, id));
  });

  // Rename it, or change which documents it holds.
  app.patch<{ Params: { id: string }; Body: { title?: unknown; document_ids?: unknown } }>('/api/episodes/:id', async (req, reply) => {
    const body = req.body ?? {};
    const unknown = Object.keys(body).filter(k => k !== 'title' && k !== 'document_ids');
    if (unknown.length > 0) return reply.status(400).send({ error: `unknown field(s): ${unknown.join(', ')}` });
    const store = getStore();
    if (!(await store.episodes.find(req.userId, req.params.id))) return reply.status(404).send({ error: 'not found' });
    if (body.title !== undefined) {
      const title = cleanTitle(body.title);
      if (title === null) return reply.status(400).send({ error: `title must be text of at most ${MAX_TITLE} characters` });
      await store.episodes.rename(req.userId, req.params.id, title);
    }
    if (body.document_ids !== undefined) {
      const documentIds = ids(body.document_ids);
      if (!documentIds) return reply.status(400).send({ error: 'document_ids must name 1 to 200 documents' });
      if (!(await store.episodes.setDocuments(req.userId, req.params.id, documentIds))) return reply.status(404).send({ error: 'one or more documents were not found' });
    }
    return reply.send(await store.episodes.find(req.userId, req.params.id));
  });

  // Confirm what the app proposed, or say it is not an episode (it is then not proposed again).
  app.post<{ Params: { id: string }; Body: { state?: unknown } }>('/api/episodes/:id/state', async (req, reply) => {
    const state = req.body?.state;
    if (state !== 'confirmed' && state !== 'dismissed') return reply.status(400).send({ error: 'state must be confirmed or dismissed' });
    if (!(await getStore().episodes.setState(req.userId, req.params.id, state))) return reply.status(404).send({ error: 'not found' });
    return reply.send({ ok: true, state });
  });

  app.delete<{ Params: { id: string } }>('/api/episodes/:id', async (req, reply) => {
    if (!(await getStore().episodes.remove(req.userId, req.params.id))) return reply.status(404).send({ error: 'not found' });
    return reply.send({ ok: true });
  });

  // Look again at what could be grouped; replaces the app's earlier proposals, never what the owner decided.
  app.post('/api/episodes/propose', async (req, reply) => {
    return reply.send({ proposed: await proposeEpisodes(req.userId) });
  });
}
