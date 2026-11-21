import { summaryOf, type ShareOverview } from 'spine-core/share-overview';
import type { CardContent } from 'spine-core/emergency';

/** The name the link starts with: the emergency card's (which is the profile's unless it was written over), else the open person's, and none for "Me", which is what an account calls its own first records and is not a name a doctor knows anyone by. */
export const defaultShareName = (cardName: string | undefined, personName: string): string => cardName?.trim() || (personName === 'Me' ? '' : personName);

/**
 * What the owner chose to tell the doctor, as the link carries it: their name only if they leave it on, the note, and, if they ticked it and there is something on their profile, the health
 * summary. The summary is shown here as it is now (for the owner's preview) and sent as `summary: true`: the copy reads it from the profile each time it is made.
 */
export function buildOverview(about: { showName: boolean; name: string; note: string; includeNow: boolean }, card: CardContent | null, writtenOn?: string): ShareOverview | null {
  const by = about.showName && about.name.trim() ? about.name.trim() : null;
  const note = about.note.trim() || null;
  const now = about.includeNow ? summaryOf(card, writtenOn ?? '') : null;
  return by || note || now ? { by, note, now, summary: now !== null } : null;
}
