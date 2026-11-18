import type { Episode } from '../api';

type Translate = (english: string, values?: Record<string, string | number>) => string;

/** An episode's name: the owner's title, or else what its documents give — the provider and the dates. Nothing else is ever written. */
export function episodeName(ep: Pick<Episode, 'title' | 'provider' | 'first_date' | 'last_date'>, t: Translate, date: (iso: string) => string = iso => iso): string {
  if (ep.title) return ep.title;
  const dates = ep.first_date && ep.last_date && ep.first_date !== ep.last_date ? `${date(ep.first_date)} – ${date(ep.last_date)}` : ep.first_date ? date(ep.first_date) : '';
  return [ep.provider, dates].filter(Boolean).join(' · ') || t('Episode');
}

/** What an episode is without the owner's own title, which is in the language they wrote it in: the provider and the dates, or just "Episode". */
export function episodeDates(ep: Pick<Episode, 'provider' | 'first_date' | 'last_date'>, t: Translate, date?: (iso: string) => string): string {
  return episodeName({ ...ep, title: '' }, t, date);
}
