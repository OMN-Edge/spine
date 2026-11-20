import { z } from 'zod';
import type { CardContent } from './emergency.js';

/**
 * What the person who makes a share link tells the doctor about it, on top of the documents (T-02): who the records are of, a note for the doctor, and, if they tick it, what they take
 * now, their allergies and their conditions as they wrote them on their emergency card. All of it is the owner's own words, chosen one by one; nothing is taken from the documents (a
 * prescription from March does not say what is taken in November, and for a whole history a list from the documents is a long list of the past). It is kept with the link and goes in
 * the sealed copy, so it is part of what the recipient reads and nothing else is.
 *
 * The health summary (`now`) is the owner's own, written on the profile page. A link made now carries `summary: true` and no lists: the lists are read from the profile each time the
 * copy is made (`resolveOverview`), so a link that follows the records follows the summary too. A link made before this holds its lists as they were written, and shows them as such.
 */
const line = (max: number) => z.string().trim().max(max);
const items = (max: number, count: number) => z.array(line(max)).max(count).default([]).transform(list => list.filter(item => item.length > 0));

export const overviewSchema = z.object({
  /** Whose records these are, as the owner chose to say it: absent where the owner left their name out. */
  by: line(120).nullable().default(null).transform(v => (v ? v : null)),
  /** A note for the doctor: why the records are sent. */
  note: line(300).nullable().default(null).transform(v => (v ? v : null)),
  /** The owner's health summary as the recipient reads it, with the day it was last written. Set when the copy is made from `summary`; an earlier link holds it as it was written. */
  now: z.object({
    medications: items(120, 30),
    allergies: items(120, 20),
    conditions: items(120, 20),
    blood_type: line(5).default(''),
    notes: line(500).default(''),
    written_on: line(10).default(''),
  }).nullable().default(null),
  /** The link includes the owner's health summary as it is when the copy is made. */
  summary: z.boolean().default(false),
}).strict();

export type ShareOverview = z.infer<typeof overviewSchema>;
export type ShareSummary = NonNullable<ShareOverview['now']>;

/** The health summary of a profile, from what is written on its card record (the lists, the blood type and the notes), or null where none of it is. `writtenOn` is the day it was last saved. */
export function summaryOf(card: Pick<CardContent, 'medications' | 'allergies' | 'conditions' | 'blood_type' | 'notes'> | null | undefined, writtenOn = ''): ShareSummary | null {
  if (!card) return null;
  const any = card.medications.length + card.allergies.length + card.conditions.length > 0 || !!card.blood_type.trim() || !!card.notes.trim();
  return any ? { medications: card.medications, allergies: card.allergies, conditions: card.conditions, blood_type: card.blood_type.trim(), notes: card.notes.trim(), written_on: writtenOn } : null;
}

/** The stored text of an overview, or null where it says nothing. */
export function overviewText(overview: ShareOverview | null | undefined): string | null {
  if (!overview) return null;
  // A link that includes the summary keeps no lists of its own: they are read from the profile when the copy is made.
  const now = !overview.summary && overview.now && (overview.now.medications.length + overview.now.allergies.length + overview.now.conditions.length > 0 || overview.now.blood_type || overview.now.notes) ? overview.now : null;
  if (!overview.by && !overview.note && !now && !overview.summary) return null;
  return JSON.stringify({ by: overview.by, note: overview.note, now, summary: overview.summary });
}

/**
 * The overview as the copy carries it: for a link that includes the summary, the summary as the profile has it now (the lists, the blood type and the notes, with the day they were
 * written), else what the link holds. The owner's stored text is not changed; the recipient reads this one.
 */
export function resolveOverview(stored: string | null | undefined, current: ShareSummary | null): string | null {
  const overview = parseOverview(stored);
  if (!overview) return stored ?? null;
  if (!overview.summary) return stored ?? null;
  return JSON.stringify({ by: overview.by, note: overview.note, now: current, summary: true });
}

/** What a request said, checked: the overview, or an error naming what is wrong. `null` and `undefined` are no overview. */
export function readOverview(value: unknown): { overview: ShareOverview | null } | { error: string } {
  if (value === null || value === undefined) return { overview: null };
  const parsed = overviewSchema.safeParse(value);
  if (!parsed.success) return { error: `overview is not valid: ${parsed.error.issues[0]?.message ?? 'wrong shape'}` };
  return { overview: parsed.data };
}

/** What a stored overview says, or null for none or one that cannot be read (an earlier link has none). */
export function parseOverview(text: string | null | undefined): ShareOverview | null {
  if (!text) return null;
  try {
    const parsed = overviewSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
