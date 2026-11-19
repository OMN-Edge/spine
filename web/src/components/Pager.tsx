import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useI18n } from '../i18n';

/** The page of a list a screen is on, kept in the address (`?page=3`, or another name where a screen has two lists) so the back button and a reload keep it. From 1. */
export function usePage(name = 'page'): [number, (page: number) => void] {
  const [params, setParams] = useSearchParams();
  const raw = Number(params.get(name));
  const page = Number.isInteger(raw) && raw >= 1 ? raw : 1;
  const set = useCallback((next: number) => {
    setParams(prev => {
      const copy = new URLSearchParams(prev);
      if (next <= 1) copy.delete(name); else copy.set(name, String(next));
      return copy;
    }, { replace: false });
  }, [name, setParams]);
  return [page, set];
}

/**
 * Previous and Next with "1–25 of 312" between them, under a list that is one page of many (T-31): the pages replace each other, so the list is never taller than a page and
 * never pushes what is under it away. Nothing is drawn while everything fits on one page.
 */
export default function Pager({ page, total, limit, onPage }: { page: number; total: number; limit: number; onPage: (page: number) => void }) {
  const { t } = useI18n();
  if (total <= limit) return null;
  const pages = Math.ceil(total / limit);
  const from = (page - 1) * limit + 1;
  const to = Math.min(total, page * limit);
  const button = 'rounded-full border border-ink/20 px-4 py-1.5 text-sm text-ink/80 hover:bg-ink/5 disabled:opacity-40 disabled:hover:bg-transparent max-sm:flex-1';
  return (
    <nav aria-label={t('Pages')} className="mt-4 flex items-center justify-between gap-3 text-sm">
      <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)} className={button}>{t('Previous')}</button>
      <span className="text-ink/60" aria-live="polite">{t('{from}–{to} of {total}', { from, to, total })}</span>
      <button type="button" disabled={page >= pages} onClick={() => onPage(page + 1)} className={button}>{t('Next')}</button>
    </nav>
  );
}
