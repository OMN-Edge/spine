import type { HttpApp } from '../http.js';
import { getStore } from '../store/index.js';
import { requireAuth } from './middleware.js';
import { MAX_REMINDERS, syncReminders, validDay } from '../reminders/index.js';
import type { ReminderRow } from '../store/types.js';

/**
 * Follow-up reminders (FR-REM, SECURITY.md **M-53**): the ones proposed from what documents say, to confirm, change, dismiss, mark done or delete. The
 * owner's, answered from the owner's own device. A reminder exists for the server only once it is confirmed, and then as a date and nothing else
 * (`syncReminders`, after every change here).
 */
const STATES = ['proposed', 'confirmed', 'dismissed', 'done'] as const;

export async function reminderRoutes(app: HttpApp) {
  app.addHook('preHandler', requireAuth);

  const view = async (userId: string, rows: ReminderRow[]) => {
    const store = getStore();
    const titles = new Map<string, { title: string | null; doc_date: string | null }>();
    for (const id of new Set(rows.map(r => r.document_id))) {
      const doc = await store.documents.findFor(userId, id);
      if (doc) titles.set(id, { title: doc.title, doc_date: doc.doc_date });
    }
    // A reminder of a document that is no longer there is not shown (it goes with the document).
    return rows.filter(r => titles.has(r.document_id)).map(r => ({ ...r, document_title: titles.get(r.document_id)!.title, document_date: titles.get(r.document_id)!.doc_date }));
  };

  app.get('/api/reminders', async (req, reply) => {
    const rows = await getStore().reminders.list(req.userId);
    return reply.header('Cache-Control', 'no-store').send({ reminders: await view(req.userId, rows), max: MAX_REMINDERS });
  });

  app.put<{ Params: { id: string }; Body: { status?: unknown; text?: unknown; due_on?: unknown } }>('/api/reminders/:id', async (req, reply) => {
    const store = getStore();
    const row = await store.reminders.get(req.userId, req.params.id);
    if (!row) return reply.status(404).send({ error: 'not found' });
    const { status, text, due_on: dueOn } = req.body ?? {};
    if (status !== undefined && !(STATES as readonly unknown[]).includes(status)) return reply.status(400).send({ error: 'status must be proposed, confirmed, dismissed or done' });
    if (text !== undefined && (typeof text !== 'string' || text.trim().length === 0 || text.length > 300)) return reply.status(400).send({ error: 'the words must be between 1 and 300 characters' });
    if (dueOn !== undefined && !validDay(dueOn)) return reply.status(400).send({ error: 'due_on must be a date, YYYY-MM-DD' });
    const next = (status as ReminderRow['status'] | undefined) ?? row.status;
    if (next === 'confirmed' && row.status !== 'confirmed' && (await store.reminders.list(req.userId)).filter(r => r.status === 'confirmed').length >= MAX_REMINDERS) {
      return reply.status(409).send({ error: `an account keeps at most ${MAX_REMINDERS} reminders`, code: 'too_many' });
    }
    const updated = await store.reminders.update(req.userId, row.id, { ...(text !== undefined ? { text: (text as string).trim() } : {}), ...(dueOn !== undefined ? { dueOn: dueOn as string } : {}), ...(status !== undefined ? { status: status as ReminderRow['status'] } : {}) }, new Date().toISOString());
    void syncReminders(req.userId);
    return reply.header('Cache-Control', 'no-store').send((await view(req.userId, updated ? [updated] : []))[0] ?? null);
  });

  app.delete<{ Params: { id: string } }>('/api/reminders/:id', async (req, reply) => {
    if (!(await getStore().reminders.remove(req.userId, req.params.id))) return reply.status(404).send({ error: 'not found' });
    void syncReminders(req.userId);
    return reply.send({ ok: true });
  });
}
