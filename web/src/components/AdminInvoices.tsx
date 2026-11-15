import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Notice } from './AuthCard';
import { useI18n } from '../i18n';

type View = Awaited<ReturnType<typeof api.admin.invoices>>;

/**
 * The invoices the operator owes for payments the provider is not the seller of (docs/billing.md, "Invoices"): what stopped and why, in the service's own words,
 * with a way to try each again or settle it by hand, and the sales to consumers in other EU countries against the yearly threshold. References and numbers, never a
 * buyer. Only an administrator changes anything; a refusal of the buttons is shown as it is.
 */
export default function AdminInvoices() {
  const { t, tn } = useI18n();
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => { api.admin.invoices().then(setView).catch(() => setError(t('Could not load the invoices.'))); }, [t]);
  useEffect(load, [load]);

  const act = async (ref: string, action: 'retry' | 'settle') => {
    setError('');
    try { await api.admin.mendInvoice(ref, action); load(); } catch (err) { setError(err instanceof Error ? err.message : t('Could not change the invoice')); }
  };
  if (!view && !error) return null;
  const money = (n: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
  const counts = view?.counts;
  const waiting = counts ? counts.pending + counts.issued : 0;
  return (
    <section className="bg-white border border-gray-200 rounded-xl p-5">
      <h2 className="font-medium text-gray-900 mb-1">{t('Invoices')}</h2>
      {error && <Notice kind="error">{error}</Notice>}
      {view && counts && (
        <>
          <p className="text-sm text-gray-500 mb-3">{t('Invoices done: {done}. Waiting to be made or sent: {waiting}.', { done: counts.done, waiting })}</p>
          <p className="text-sm text-gray-700 mb-2">{view.stopped.length === 0 ? t('Nothing is waiting for you.') : tn(view.stopped.length, '{n} invoice needs a look.', '{n} invoices need a look.')}</p>
          <ul className="divide-y divide-gray-100">
            {view.stopped.map(row => (
              <li key={row.ref} className="py-3 flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-gray-900 break-all">{row.ref}{row.invoice ? ` · ${row.invoice}` : ''}</div>
                  {row.reason && <div className="text-xs text-gray-600 break-words">{row.reason}</div>}
                  <div className="text-xs text-gray-500">{t('Tried: {n}', { n: row.attempts })} · {new Date(row.at).toLocaleString()}</div>
                </div>
                {row.can_retry && <button type="button" onClick={() => void act(row.ref, 'retry')} className="text-sm rounded-lg bg-brand-600 text-white px-3 py-1.5 hover:bg-brand-700">{t('Try again')}</button>}
                <button type="button" onClick={() => void act(row.ref, 'settle')} className="text-sm rounded-lg border border-gray-300 px-3 py-1.5 text-gray-700 hover:bg-gray-50">{t('Mark as done by hand')}</button>
              </li>
            ))}
          </ul>
          <p className="text-sm text-gray-700 mt-4">{t('Sales to consumers in other EU countries: {thisYear} this year, {lastYear} last year, against the {limit} limit.', { thisYear: money(view.eu.this_year), lastYear: money(view.eu.last_year), limit: money(view.eu.limit) })}</p>
          <p className="text-xs text-gray-500">{t('Past the limit the buyer’s country’s VAT applies: talk to the accountant first.')}</p>
        </>
      )}
    </section>
  );
}
