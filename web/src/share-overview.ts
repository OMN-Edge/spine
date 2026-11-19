import type { ShareOverview } from 'spine-core/share-overview';
import type { CardContent } from 'spine-core/emergency';

/** The name the link starts with: the emergency card's, else the open person's, and none for "Me", which is what an account calls its own first records and is not a name a doctor knows anyone by. */
export const defaultShareName = (cardName: string | undefined, personName: string): string => cardName?.trim() || (personName === 'Me' ? '' : personName);

/** What the owner chose to tell the doctor, as the link carries it: their name only if they leave it on, the note, and what they take now only if they ticked it and have written it on their card. */
export function buildOverview(about: { showName: boolean; name: string; note: string; includeNow: boolean }, card: CardContent | null, writtenOn?: string): ShareOverview | null {
  const by = about.showName && about.name.trim() ? about.name.trim() : null;
  const note = about.note.trim() || null;
  const now = about.includeNow && card && card.medications.length + card.allergies.length + card.conditions.length > 0
    ? { medications: card.medications, allergies: card.allergies, conditions: card.conditions, written_on: writtenOn ?? '' }
    : null;
  return by || note || now ? { by, note, now } : null;
}
