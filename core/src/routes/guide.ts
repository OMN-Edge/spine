import type { HttpApp } from '../http.js';
import { getStore } from '../store/index.js';
import { requireAuth } from './middleware.js';
import { HELP_TOPICS } from '../help.js';

/**
 * What helps a person start: the chat's welcome, a tip the first time something happens, and the "Get started" checklist. The page decides
 * when to show each; this keeps what was shown (so a tip is not repeated, a second device does not greet again, and a welcome ignored a few
 * times stops) and says how far the person has got, from their records. Owner only; nothing here reaches a model.
 */
export const GUIDE_KEYS = ['welcome', 'tip.grouping', 'tip.read', 'tip.share', 'tip.results', 'tip.doctors', 'tip.connections', 'checklist'] as const;

export async function guideRoutes(app: HttpApp) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/guide', async (req, reply) => {
    const store = getStore();
    const all = await store.sourceFiles.listFor(req.userId);
    const uploads = all.filter(u => !u.sample);
    const samples = new Set(all.filter(u => u.sample).map(u => u.id));
    const marks = Object.fromEntries((await store.guide.list(req.userId)).map(m => [m.key, { shown: m.shown, last_shown_at: m.last_shown_at, done_at: m.done_at }]));
    return reply.header('Cache-Control', 'no-store').send({
      marks,
      progress: {
        // The person's own uploads: sample records are not a first step taken.
        uploads: uploads.length,
        grouping_confirmed: uploads.filter(u => u.status === 'done' && u.grouping_confirmed).length,
        grouping_waiting: uploads.filter(u => u.status === 'done' && !u.grouping_confirmed).length,
        // Documents the person has looked over and marked reviewed (which needs the grouping confirmed first). The checklist only asks
        // whether there is one, so the count stops at a page.
        reviewed: (await store.documents.listFor(req.userId, { reviewed: true, limit: 100, offset: 0 })).filter(d => !samples.has(d.source_file_id)).length,
        shares: (await store.shareLinks.listFor(req.userId)).length,
      },
      topics: HELP_TOPICS.map(t => t.id),
    });
  });

  const known = (key: string) => (GUIDE_KEYS as readonly string[]).includes(key);

  app.post<{ Params: { key: string } }>('/api/guide/:key/shown', async (req, reply) => {
    if (!known(req.params.key)) return reply.status(404).send({ error: 'not found' });
    await getStore().guide.shown(req.userId, req.params.key, new Date().toISOString());
    return reply.send({ ok: true });
  });

  app.post<{ Params: { key: string } }>('/api/guide/:key/done', async (req, reply) => {
    if (!known(req.params.key)) return reply.status(404).send({ error: 'not found' });
    await getStore().guide.done(req.userId, req.params.key, new Date().toISOString());
    return reply.send({ ok: true });
  });
}
