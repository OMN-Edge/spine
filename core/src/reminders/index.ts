import { v4 as uuidv4 } from 'uuid';
import { getStore, type Store } from '../store/index.js';
import { reminderHost } from '../reminder-host.js';
import { logger } from '../logger.js';
import type { ExtractionResult } from '../types.js';

/**
 * Follow-up reminders (FR-REM, CR-REM-01, SECURITY.md **M-53**). A document that says, in so many words, to come back ("control peste 3 luni") is
 * read once, and the instruction becomes a *proposed* reminder: nothing is inferred from guidelines or results, and nothing exists as a reminder until
 * the owner has confirmed its date and words. The words are the document's, restated. The server is told only the date of each confirmed
 * reminder, so it can mail the person (and whoever looks after them) on the day, with no word of what it is about.
 */

/** The most reminders an account keeps, so a loop or a hostile app cannot make the mail or the table grow without end. */
export const MAX_REMINDERS = 500;

const DAY = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** `date` plus whole months, the day kept (or the month's last day when it has none, as 31 January plus a month is 28 or 29 February). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(Date.UTC(y!, m! - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d!, last));
  return isoDay(target);
}

/** A real calendar day within what a person could mean (not a year 1900 or 3000 typo). */
export function validDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && isoDay(d) === value && value >= '2000-01-01' && value <= '2100-12-31';
}

/**
 * When a follow-up is due: the date the document gives, or the months it gives counted from the document's date (from today when it has none). A
 * date already past by more than a day is not proposed (an old document's "in 3 months" is behind the person), and neither is one with neither.
 */
export function dueDate(followUp: NonNullable<ExtractionResult['follow_ups']>[number], docDate: string | null, today: Date = new Date()): string | null {
  const now = isoDay(today);
  const due = followUp.on_date && validDay(followUp.on_date) ? followUp.on_date
    : followUp.after_months ? addMonths(docDate && validDay(docDate) ? docDate : now, followUp.after_months)
      : null;
  if (!due || !validDay(due)) return null;
  return due < isoDay(new Date(today.getTime() - DAY)) ? null : due;
}

/** Proposes a reminder for each follow-up a reading found, in the transaction that stores the reading. Answers how many were new. */
export async function proposeReminders(tx: Store, userId: string, documentId: string, extraction: ExtractionResult, now: Date = new Date()): Promise<number> {
  const items = (extraction.follow_ups ?? []).flatMap(f => {
    const text = f.text.trim().slice(0, 300);
    const dueOn = dueDate(f, extraction.doc_date, now);
    return text && dueOn ? [{ id: uuidv4(), text, dueOn, sourcePage: f.page_number ?? null }] : [];
  });
  if (items.length === 0) return 0;
  return tx.reminders.propose(userId, documentId, items, now.toISOString());
}

/** What was last told to the server, so a change is told and nothing else is. */
let told = '';

/**
 * Tells the server which confirmed reminders are due when, if what it holds is not what this device has. A reminder whose document is gone, set aside or
 * whose reminder was changed, dismissed or deleted is simply not in the list, which is how the server forgets it. Best effort: a failure is logged and tried
 * again at the next call.
 */
export async function syncReminders(userId: string, force = false): Promise<void> {
  const host = reminderHost();
  if (!host) return;
  try {
    const items = (await getStore().reminders.confirmed(userId)).slice(0, MAX_REMINDERS).map(r => ({ id: r.id, dueOn: r.due_on }));
    const fingerprint = JSON.stringify(items);
    if (!force && fingerprint === told) return;
    await host.replace(items);
    told = fingerprint;
  } catch (err) {
    logger.warn('the dates of the reminders could not be sent', { reason: err instanceof Error ? err.message : String(err) });
  }
}

/** Forgets what was told, as when other records are opened: the next sync tells the server whatever it now holds. */
export function forgetTold(): void { told = ''; }
