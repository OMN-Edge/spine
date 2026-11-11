import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getStore } from 'spine-core/store/index.js';
import { addMonths, dueDate, proposeReminders, syncReminders, forgetTold, validDay } from 'spine-core/reminders/index.js';
import { useReminderHost } from 'spine-core/reminder-host.js';
import { EXTRACTION_FALLBACK } from 'spine-core/llm/types.js';
import { buildTestApp, loginSession } from './helpers/app.js';
import { OWNER_ID, seedDocument } from './helpers/seed.js';

/** Follow-up reminders: proposed from what a document says, confirmed by the owner, told to the server as dates only. docs/scenarios.md 16.x. */
describe('follow-up reminders', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let cookie: string;
  const dir = mkdtempSync(path.join(tmpdir(), 'spine-reminders-'));
  const told: Array<Array<{ id: string; dueOn: string }>> = [];

  beforeAll(async () => {
    process.env.DATA_DIR = dir;
    app = await buildTestApp();
    cookie = await loginSession(app);
  });
  afterAll(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  afterEach(() => { useReminderHost(null); forgetTold(); told.length = 0; });

  const extraction = (followUps: NonNullable<typeof EXTRACTION_FALLBACK['follow_ups']>, docDate: string | null = '2026-11-01') => ({ ...EXTRACTION_FALLBACK, doc_date: docDate, follow_ups: followUps });
  const call = (method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: unknown) => app.inject({ method, url, headers: { cookie }, payload: payload as never });
  const propose = async (followUps: Parameters<typeof extraction>[0], docDate?: string | null) => {
    const { id } = await seedDocument();
    await proposeReminders(getStore(), OWNER_ID, id, extraction(followUps, docDate), new Date('2026-11-11T12:00:00Z'));
    return id;
  };

  describe('when one is due', () => {
    it('adds months to a date, keeping the day or the month’s last', () => {
      expect(addMonths('2026-11-11', 3)).toBe('2027-02-11');
      expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
      expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
      expect(addMonths('2026-11-30', 14)).toBe('2028-01-30');
    });

    it('is the date the document gives, or the months it gives from its own date, and never a guess', () => {
      const now = new Date('2026-11-11T12:00:00Z');
      expect(dueDate({ text: 't', on_date: '2027-03-01' }, '2026-11-01', now)).toBe('2027-03-01');
      expect(dueDate({ text: 't', after_months: 3 }, '2026-11-01', now)).toBe('2027-02-01');
      expect(dueDate({ text: 't', after_months: 3 }, null, now)).toBe('2027-02-11');
      expect(dueDate({ text: 't' }, '2026-11-01', now)).toBeNull();
      // Already behind the person: an old document’s "in 3 months".
      expect(dueDate({ text: 't', after_months: 3 }, '2025-01-01', now)).toBeNull();
      expect(dueDate({ text: 't', on_date: '2026-11-10' }, null, now)).toBe('2026-11-10');
      expect(dueDate({ text: 't', on_date: '2026-02-31' }, null, now)).toBeNull();
    });

    it('is a real day of a plausible year', () => {
      expect(validDay('2027-02-28')).toBe(true);
      for (const bad of ['2027-02-30', '1999-12-31', '2101-01-01', 'soon', '', 5, null]) expect(validDay(bad), String(bad)).toBe(false);
    });
  });

  describe('proposing', () => {
    it('proposes one for each instruction a document gives, with its words restated as the document has them, and none that is not asked', async () => {
      const id = await propose([
        { text: ' control peste 3 luni ', after_months: 3, source_snippet: 'control peste 3 luni', page_number: 1 },
        { text: 'a recommendation with no time', after_months: null },
      ]);
      const mine = (await getStore().reminders.list(OWNER_ID)).filter(r => r.document_id === id);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ text: 'control peste 3 luni', due_on: '2027-02-01', status: 'proposed', on_page: 1 });
    });

    it('proposes nothing twice when a document is read again, and keeps what became of the first', async () => {
      const id = await propose([{ text: 'control peste 6 luni', after_months: 6 }]);
      const [first] = (await getStore().reminders.list(OWNER_ID)).filter(r => r.document_id === id);
      await getStore().reminders.update(OWNER_ID, first!.id, { status: 'dismissed' }, new Date().toISOString());
      await proposeReminders(getStore(), OWNER_ID, id, extraction([{ text: 'control peste 6 luni', after_months: 6 }]), new Date('2026-11-11T12:00:00Z'));
      const again = (await getStore().reminders.list(OWNER_ID)).filter(r => r.document_id === id);
      expect(again).toHaveLength(1);
      expect(again[0]!.status).toBe('dismissed');
    });
  });

  describe('the owner’s say', () => {
    it('lists them with the document they come from, and confirms a proposal with the date and words the owner chose', async () => {
      const id = await propose([{ text: 'control peste 3 luni', after_months: 3 }]);
      const listed = (await call('GET', '/api/reminders')).json().reminders as Array<{ id: string; document_id: string; status: string; document_title: string | null }>;
      const mine = listed.find(r => r.document_id === id)!;
      expect(mine.status).toBe('proposed');
      const put = await call('PUT', `/api/reminders/${mine.id}`, { status: 'confirmed', text: 'Control cardiologie', due_on: '2027-05-04' });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toMatchObject({ status: 'confirmed', text: 'Control cardiologie', due_on: '2027-05-04' });
    });

    it('refuses what is not a date, not a state, or not words, and what is not the owner’s', async () => {
      const id = await propose([{ text: 'control peste 2 luni', after_months: 2 }]);
      const mine = (await getStore().reminders.list(OWNER_ID)).find(r => r.document_id === id)!;
      expect((await call('PUT', `/api/reminders/${mine.id}`, { due_on: 'tomorrow' })).statusCode).toBe(400);
      expect((await call('PUT', `/api/reminders/${mine.id}`, { status: 'snoozed' })).statusCode).toBe(400);
      expect((await call('PUT', `/api/reminders/${mine.id}`, { text: '   ' })).statusCode).toBe(400);
      expect((await call('PUT', `/api/reminders/${mine.id}`, { text: 'x'.repeat(301) })).statusCode).toBe(400);
      expect((await call('PUT', '/api/reminders/not-there', { status: 'done' })).statusCode).toBe(404);
      expect((await call('DELETE', '/api/reminders/not-there')).statusCode).toBe(404);
    });

    it('deletes one, and a document’s deletion takes its reminders with it', async () => {
      const id = await propose([{ text: 'control peste 1 luni', after_months: 1 }]);
      const mine = (await getStore().reminders.list(OWNER_ID)).find(r => r.document_id === id)!;
      expect((await call('DELETE', `/api/reminders/${mine.id}`)).statusCode).toBe(200);
      expect((await getStore().reminders.get(OWNER_ID, mine.id))).toBeNull();
      const other = await propose([{ text: 'control peste 5 luni', after_months: 5 }]);
      await getStore().documents.delete(OWNER_ID, other);
      expect((await getStore().reminders.list(OWNER_ID)).some(r => r.document_id === other)).toBe(false);
    });
  });

  describe('what the server is told', () => {
    it('is a date for each confirmed reminder and nothing else, and not what is only proposed, dismissed or done', async () => {
      useReminderHost({ replace: async items => { told.push(items); } });
      const a = await propose([{ text: 'control peste 3 luni', after_months: 3 }]);
      const b = await propose([{ text: 'control peste 4 luni', after_months: 4 }]);
      const c = await propose([{ text: 'control peste 5 luni', after_months: 5 }]);
      const by = async (doc: string) => (await getStore().reminders.list(OWNER_ID)).find(r => r.document_id === doc)!;
      const now = new Date().toISOString();
      await getStore().reminders.update(OWNER_ID, (await by(a)).id, { status: 'confirmed' }, now);
      await getStore().reminders.update(OWNER_ID, (await by(b)).id, { status: 'dismissed' }, now);
      await getStore().reminders.update(OWNER_ID, (await by(c)).id, { status: 'done' }, now);
      await syncReminders(OWNER_ID, true);
      const last = told.at(-1)!;
      // A date for the confirmed one (and for any other confirmed earlier in this archive), none for the proposed, dismissed or done.
      expect(last).toContainEqual({ id: (await by(a)).id, dueOn: (await by(a)).due_on });
      const [bId, cId] = [(await by(b)).id, (await by(c)).id];
      expect(last.some(i => i.id === bId || i.id === cId)).toBe(false);
      expect(Object.keys(last[0]!).sort()).toEqual(['dueOn', 'id']);
      expect(JSON.stringify(last)).not.toMatch(/control/);
    });

    it('is told again only when it changed, and by the routes after every change', async () => {
      useReminderHost({ replace: async items => { told.push(items); } });
      const doc = await propose([{ text: 'control peste 7 luni', after_months: 7 }]);
      const mine = (await getStore().reminders.list(OWNER_ID)).find(r => r.document_id === doc)!;
      await syncReminders(OWNER_ID);
      const before = told.length;
      await syncReminders(OWNER_ID);
      expect(told.length).toBe(before);
      await call('PUT', `/api/reminders/${mine.id}`, { status: 'confirmed' });
      await new Promise(r => setTimeout(r, 50));
      expect(told.at(-1)!.some(i => i.id === mine.id)).toBe(true);
      await call('DELETE', `/api/reminders/${mine.id}`);
      await new Promise(r => setTimeout(r, 50));
      expect(told.at(-1)!.some(i => i.id === mine.id)).toBe(false);
    });

    it('tells nothing where there is no host, and survives one that fails', async () => {
      await expect(syncReminders(OWNER_ID, true)).resolves.toBeUndefined();
      useReminderHost({ replace: async () => { throw new Error('offline'); } });
      await expect(syncReminders(OWNER_ID, true)).resolves.toBeUndefined();
    });
  });
});
