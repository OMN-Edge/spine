import type { Episode } from '../api';

type Translate = (english: string, values?: Record<string, string | number>) => string;

/** An episode's name: the owner's title, or else what its documents give — the provider and the dates. Nothing else is ever written. */
export function episodeName(ep: Pick<Episode, 'title' | 'provider' | 'first_date' | 'last_date'>, t: Translate): string {
  if (ep.title) return ep.title;
  const dates = ep.first_date && ep.last_date && ep.first_date !== ep.last_date ? `${ep.first_date} – ${ep.last_date}` : ep.first_date ?? '';
  return [ep.provider, dates].filter(Boolean).join(' · ') || t('Episode');
}
