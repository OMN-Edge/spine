import { z } from 'zod';

/**
 * What the person who makes a share link tells the doctor about it, on top of the documents (T-02): who the records are of, a note for the doctor, and, if they tick it, what they take
 * now, their allergies and their conditions as they wrote them on their emergency card. All of it is the owner's own words, chosen one by one; nothing is taken from the documents (a
 * prescription from March does not say what is taken in November, and for a whole history a list from the documents is a long list of the past). It is kept with the link and goes in
 * the sealed copy, so it is part of what the recipient reads and nothing else is.
 */
const line = (max: number) => z.string().trim().max(max);
const items = (max: number, count: number) => z.array(line(max)).max(count).default([]).transform(list => list.filter(item => item.length > 0));

export const overviewSchema = z.object({
  /** Whose records these are, as the owner chose to say it: absent where the owner left their name out. */
  by: line(120).nullable().default(null).transform(v => (v ? v : null)),
  /** A note for the doctor: why the records are sent. */
  note: line(300).nullable().default(null).transform(v => (v ? v : null)),
  /** What the owner takes now and is allergic to, from their own card, with the day it was written. */
  now: z.object({
    medications: items(120, 30),
    allergies: items(120, 20),
    conditions: items(120, 20),
    written_on: line(10).default(''),
  }).nullable().default(null),
}).strict();

export type ShareOverview = z.infer<typeof overviewSchema>;

/** The stored text of an overview, or null where it says nothing. */
export function overviewText(overview: ShareOverview | null | undefined): string | null {
  if (!overview) return null;
  const now = overview.now && (overview.now.medications.length + overview.now.allergies.length + overview.now.conditions.length > 0) ? overview.now : null;
  if (!overview.by && !overview.note && !now) return null;
  return JSON.stringify({ by: overview.by, note: overview.note, now });
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
