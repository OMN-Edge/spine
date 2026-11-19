import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Notice } from './AuthCard';
import { useI18n } from '../i18n';
import { useFormat } from '../format';
import Pager, { usePage } from './Pager';

type View = Awaited<ReturnType<typeof api.admin.invoices>>;

/**
 * The invoices the operator owes for payments the provider is not the seller of (docs/billing.md, "Invoices"): what stopped and why, in the service's own words,
 * with a way to try each again or settle it by hand, and the sales to consumers in other EU countries against the yearly threshold. References and numbers, never a
 * buyer. Only an administrator changes anything; a refusal of the buttons is shown as it is.
 */
export default function AdminInvoices() {
  const { t, tn } = useI18n();
  const format = useFormat();
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [page, setPage] = usePage('stopped');
  const load = useCallback(() => { api.admin.invoices(page).then(setView).catch(() => setError(t('Could not load the invoices.'))); }, [t, page]);
  useEffect(load, [load]);

  const act = async (ref: string, action: 'retry' | 'settle') => {
    setError('');
    try { await api.admin.mendInvoice(ref, action); load(); } catch (err) { setError(err instanceof Error ? err.message : t('Could not change the invoice')); }
  };
  if (!view && !error) return null;
  const money = (n: number) => format.amount(Math.round(n), 'EUR');
  const counts = view?.counts;
  const waiting = counts ? counts.pending + counts.issued : 0;
  return (
    <section>
      <h2 className="font-display text-[clamp(1.5rem,2.6vw,2rem)] font-normal leading-tight">{t('Invoices')}</h2>
      <div className="mt-5 rounded-2xl border border-ink/10 bg-surface p-5">
      {error && <Notice kind="error">{error}</Notice>}
      {view && counts && (
        <>
          <p className="text-sm text-ink/60 mb-3">{t('Invoices done: {done}. Waiting to be made or sent: {waiting}.', { done: counts.done, waiting })}</p>
          <p className="text-sm text-ink/80 mb-2">{view.total === 0 ? t('Nothing is waiting for you.') : tn(view.total, '{n} invoice needs a look.', '{n} invoices need a look.')}</p>
          <ul className="divide-y divide-ink/10">
            {view.stopped.map(row => (
              <li key={row.ref} className="py-3 flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-ink break-all">{row.ref}{row.invoice ? ` · ${row.invoice}` : ''}</div>
                  {row.reason && <div className="text-xs text-ink/65 break-words">{row.reason}</div>}
                  <div className="text-xs text-ink/60">{t('Tried: {n}', { n: row.attempts })} · {format.dateTime(row.at)}</div>
                </div>
                {row.can_retry && <button type="button" onClick={() => void act(row.ref, 'retry')} className="rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-paper hover:bg-accent/90">{t('Try again')}</button>}
                <button type="button" onClick={() => void act(row.ref, 'settle')} className="rounded-full border border-ink/20 px-4 py-1.5 text-sm text-ink/80 hover:bg-ink/5">{t('Mark as done by hand')}</button>
              </li>
            ))}
          </ul>
          <Pager page={page} total={view.total} limit={view.limit} onPage={setPage} />
          <p className="text-sm text-ink/80 mt-4">{t('Sales to consumers in other EU countries: {thisYear} this year, {lastYear} last year, against the {limit} limit.', { thisYear: money(view.eu.this_year), lastYear: money(view.eu.last_year), limit: money(view.eu.limit) })}</p>
          <p className="text-xs text-ink/60">{t('Past the limit the buyer’s country’s VAT applies: talk to the accountant first.')}</p>
        </>
      )}
    </div>
    </section>
  );
}
