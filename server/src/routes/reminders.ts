import type { FastifyInstance } from 'fastify';
import { getAccountsStore } from 'spine-core/store/index.js';
import { requireAuth } from 'spine-core/routes/middleware.js';
import { MAX_REMINDERS, validDay } from 'spine-core/reminders/index.js';
import { OBJECT_ID } from '../vault-files.js';
import { getMailer } from '../mail/index.js';
import { remindersDueMail } from '../accounts.js';

/**
 * The dates of follow-up reminders (SECURITY.md **M-53**). A device tells the server the day each confirmed reminder is due, under a random id and the
 * profile it is of, and nothing else: the words of a reminder are sealed in the records, which the server cannot read. On the day the server mails the
 * account, and whoever looks after the profile, a line that says a reminder is due and nothing of what it is about. Every plan has them.
 */
const ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Makes the dates held for one profile of an account these, or says why not. Shared by the account's own route and a guardian's (`delegation.ts`). */
export async function tellDates(userId: string, profileId: string, body: { items?: unknown } | undefined): Promise<{ status: number; body: object }> {
  const items = body?.items;
  if (!Array.isArray(items) || items.length > MAX_REMINDERS) return { status: 400, body: { error: `items must be a list of at most ${MAX_REMINDERS}` } };
  const clean: Array<{ id: string; dueOn: string }> = [];
  for (const i of items as Array<{ id?: unknown; due_on?: unknown }>) {
    if (typeof i?.id !== 'string' || !ID.test(i.id) || !validDay(i.due_on)) return { status: 400, body: { error: 'each item needs an id and a due_on date, YYYY-MM-DD' } };
    clean.push({ id: i.id, dueOn: i.due_on });
  }
  if (new Set(clean.map(i => i.id)).size !== clean.length) return { status: 400, body: { error: 'an id is named twice' } };
  const result = await getAccountsStore().reminderDates.replace(userId, profileId, clean, MAX_REMINDERS);
  if (result === 'too_many') return { status: 409, body: { error: `an account keeps at most ${MAX_REMINDERS} reminders`, code: 'too_many' } };
  return { status: 200, body: { ok: true } };
}

export async function reminderRoutes(app: FastifyInstance) {
  app.put<{ Body: { profile?: unknown; items?: unknown } }>('/api/reminder-dates', { preHandler: [requireAuth, app.rateLimit({ max: 120, timeWindow: '10 minutes' })] }, async (req, reply) => {
    const profile = req.body?.profile;
    if (typeof profile !== 'string' || !OBJECT_ID.test(profile)) return reply.status(400).send({ error: 'profile must be the id of one of the account’s people' });
    const held = await getAccountsStore().vault.get(req.userId, profile);
    if (!held || held.kind !== 'profile' || held.deleted) return reply.status(404).send({ error: 'not found' });
    const done = await tellDates(req.userId, profile, req.body);
    return reply.status(done.status).header('Cache-Control', 'no-store').send(done.body);
  });
}

/**
 * Mails whoever has a reminder due: the account the profile belongs to and every account let in to it as a guardian or as the person themselves,
 * once for the day however many are due, with no word of what for. Claimed before it is sent, so two instances do not both mail it, and taken back if a
 * mail fails, so the next run tries again. Off where there is no mailer. Run at start and hourly.
 */
export async function remindDue(now = new Date()): Promise<number> {
  const mailer = getMailer();
  if (!mailer.enabled) return 0;
  const store = getAccountsStore();
  const at = now.toISOString();
  const claimed = await store.maintenance.claimDueReminders(at.slice(0, 10), at);
  let sent = 0;
  let failed = false;
  for (const c of claimed) {
    const user = await store.users.findById(c.recipient);
    if (!user) continue;
    await mailer.send(remindersDueMail(user.email, c.n)).then(() => { sent++; }, () => { failed = true; });
  }
  if (failed) await store.maintenance.releaseReminders(at);
  return sent;
}
