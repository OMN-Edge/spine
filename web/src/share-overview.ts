import type { ShareOverview } from 'spine-core/share-overview';
import type { CardContent } from 'spine-core/emergency';

/** What the owner chose to tell the doctor, as the link carries it: their name only if they leave it on, the note, and what they take now only if they ticked it and have written it on their card. */
export function buildOverview(about: { showName: boolean; name: string; note: string; includeNow: boolean }, card: CardContent | null, writtenOn?: string): ShareOverview | null {
  const by = about.showName && about.name.trim() ? about.name.trim() : null;
  const note = about.note.trim() || null;
  const now = about.includeNow && card && card.medications.length + card.allergies.length + card.conditions.length > 0
    ? { medications: card.medications, allergies: card.allergies, conditions: card.conditions, written_on: writtenOn ?? '' }
    : null;
  return by || note || now ? { by, note, now } : null;
}
