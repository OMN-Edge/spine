/**
 * Tags: one place for what a tag name is and what a new account starts with. The extraction prompt offers the model
 * the person's own tags (`ingestion/document-reading.ts`), and these are what an empty vocabulary begins as.
 */
export const STARTER_TAGS = [
  'allergy',
  'chronic',
  'vaccine',
  'medication',
  'imaging',
  'follow-up-needed',
  'cardiology',
  'oncology',
  'lab',
] as const;

export const MAX_TAG_LENGTH = 60;

/**
 * A tag as it is kept: trimmed, spaces collapsed, lower case. "Allergy" and "allergy " are one tag, so the model or a
 * typo cannot split a category in two. Null for a name with nothing in it.
 */
export function cleanTag(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const cleaned = name.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, MAX_TAG_LENGTH).trim();
  return cleaned === '' ? null : cleaned;
}
