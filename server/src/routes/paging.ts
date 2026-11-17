/**
 * The pages of a list (T-31): every list a route gives has a size, newest first, so a page of the app never grows with the data and never pushes what is under it down. The
 * request says `page` (from 1) and `limit`; a missing or wrong value is the default, and `limit` is never more than `MAX_PAGE`. The answer carries what the screen needs to draw
 * "1-25 of 312" and Previous and Next: the `total` and the `page` and `limit` that were used.
 */
export const DEFAULT_PAGE = 25;
export const MAX_PAGE = 100;

export interface Paging { page: number; limit: number; offset: number }

const whole = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : typeof v === 'number' && Number.isInteger(v) ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

export function pagingOf(query: { page?: unknown; limit?: unknown } | undefined, fallback = DEFAULT_PAGE): Paging {
  const limit = Math.min(Math.max(whole(query?.limit) ?? fallback, 1), MAX_PAGE);
  const page = Math.max(whole(query?.page) ?? 1, 1);
  return { page, limit, offset: (page - 1) * limit };
}

/** What every list answers beside its rows. */
export const pageInfo = (paging: Paging, total: number): { total: number; page: number; limit: number } => ({ total, page: paging.page, limit: paging.limit });
