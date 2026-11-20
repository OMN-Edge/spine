import type { ShareOverview } from 'spine-core/share-overview';
import type { CardContent } from 'spine-core/emergency';

/** The name the link starts with: the emergency card's, else the open person's, and none for "Me", which is what an account calls its own first records and is not a name a doctor knows anyone by. */
export const defaultShareName = (cardName: string | undefined, personName: string, remembered = ''): string => cardName?.trim() || remembered.trim() || (personName === 'Me' ? '' : personName);

const NAME_KEY = 'spine.share-name.';

/** The name the owner last showed on a link for this person, kept in this browser so it is not typed again (the card is not written to: it may be published). Nothing where storage is not allowed. */
export const rememberedShareName = (personId: string): string => { try { return localStorage.getItem(NAME_KEY + personId) ?? ''; } catch { return ''; } };
export const rememberShareName = (personId: string, name: string): void => { try { if (name.trim()) localStorage.setItem(NAME_KEY + personId, name.trim()); } catch { /* typed again next time */ } };

/** What the owner chose to tell the doctor, as the link carries it: their name only if they leave it on, the note, and what they take now only if they ticked it and have written it on their card. */
export function buildOverview(about: { showName: boolean; name: string; note: string; includeNow: boolean }, card: CardContent | null, writtenOn?: string): ShareOverview | null {
  const by = about.showName && about.name.trim() ? about.name.trim() : null;
  const note = about.note.trim() || null;
  const now = about.includeNow && card && card.medications.length + card.allergies.length + card.conditions.length > 0
    ? { medications: card.medications, allergies: card.allergies, conditions: card.conditions, written_on: writtenOn ?? '' }
    : null;
  return by || note || now ? { by, note, now } : null;
}
