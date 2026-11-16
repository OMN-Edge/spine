import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Notice } from './AuthCard';
import { useI18n } from '../i18n';

type Row = Awaited<ReturnType<typeof api.admin.withdrawals>>['requests'][number];

/**
 * The buyers who asked to withdraw from a purchase (the fourteen days), for the operator to decide: refund in full or an amount, which also ends the plan, or decline with
 * a reason the buyer is told. Only an administrator's buttons work; a refusal is shown as the server words it. A request that could not be done at the payment provider stays here to be tried again.
 */
export default function AdminWithdrawals() {
  const { t, tn } = useI18n();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const load = useCallback(() => { api.admin.withdrawals().then(r => setRows(r.requests)).catch(() => setError(t('Could not load the withdrawal requests.'))); }, [t]);
  useEffect(load, [load]);

  const decide = async (id: string, action: 'refund' | 'decline', extra: { amount?: number; note?: string } = {}) => {
    setError('');
    try { await api.admin.decideWithdrawal(id, action, extra); load(); } catch (err) { setError(err instanceof Error ? err.message : t('Could not decide the request')); }
  };
  if (rows === null && !error) return null;
  return (
    <section>
      <h2 className="font-display text-[clamp(1.5rem,2.6vw,2rem)] font-normal leading-tight">{t('Withdrawal requests')}</h2>
      <div className="mt-5 rounded-2xl border border-ink/10 bg-surface p-5">
      {error && <Notice kind="error">{error}</Notice>}
      {rows && <p className="text-sm text-ink/60 mb-3">{rows.length === 0 ? t('No one has asked to withdraw.') : tn(rows.length, '{n} request is waiting.', '{n} requests are waiting.')}</p>}
      <ul className="divide-y divide-ink/10">
        {rows?.map(row => {
          const amount = Number(amounts[row.id]);
          return (
            <li key={row.id} className="py-3 space-y-2">
              <div className="text-sm text-ink break-all">{row.email ?? '—'}{row.plan ? ` · ${row.plan}${row.interval ? ` (${row.interval})` : ''}` : ''}</div>
              <div className="text-xs text-ink/60">{t('Requested {date}', { date: new Date(row.requested_at).toLocaleDateString() })}{row.first_payment ? ` · ${t('First payment {date}', { date: new Date(row.first_payment).toLocaleDateString() })}` : ''}</div>
              <div className="text-xs text-ink/80">
                {row.used === null ? t('What was used since the purchase is not known.') : row.used.pages + row.used.questions + row.used.translated === 0
                  ? t('Nothing used since the purchase.')
                  : t('Used since the purchase: {pages} pages read, {questions} questions, {translated} pages translated.', row.used)}
                {row.earlier_refunds > 0 ? ` ${t('Paid back before: {n}.', { n: row.earlier_refunds })}` : ''}
              </div>
              {row.suggested && (() => {
                const sg = row.suggested;
                const money = (minor: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: sg.currency }).format(minor / 100);
                return (
                  <div className="flex flex-wrap items-center gap-2 text-sm text-ink">
                    <span>{sg.basis === 'unused'
                      ? t('Suggested: pay back {amount}, the whole payment, as nothing was used.', { amount: money(sg.refundMinor) })
                      : t('Suggested: pay back {amount} and keep {kept}, for {days} of {period} days.', { amount: money(sg.refundMinor), kept: money(sg.keptMinor), days: sg.days, period: sg.periodDays })}</span>
                    {sg.refundMinor > 0 && <button type="button" onClick={() => void decide(row.id, 'refund', { amount: sg.refundMinor / 100 })} className="rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-paper hover:bg-accent/90">{t('Pay back the suggested amount and end the plan')}</button>}
                  </div>
                );
              })()}
              <div className="flex flex-wrap items-center gap-2">
                {/* With nothing used the suggestion is the whole payment, which this button would pay back too. */}
                {row.suggested?.basis !== 'unused' && <button type="button" onClick={() => void decide(row.id, 'refund')} className="rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-paper hover:bg-accent/90">{t('Refund in full and end the plan')}</button>}
                <input aria-label={t('Amount')} inputMode="decimal" placeholder={t('Amount')} value={amounts[row.id] ?? ''} onChange={e => setAmounts(a => ({ ...a, [row.id]: e.target.value }))} className="w-24 rounded-full border border-ink/20 bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent" />
                <button type="button" disabled={!(amount > 0)} onClick={() => void decide(row.id, 'refund', { amount })} className="rounded-full border border-ink/20 px-4 py-1.5 text-sm text-ink/80 hover:bg-ink/5 disabled:opacity-50">{t('Refund this amount and end the plan')}</button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input aria-label={t('Reason for declining (the buyer is told)')} placeholder={t('Reason for declining (the buyer is told)')} value={reasons[row.id] ?? ''} onChange={e => setReasons(r => ({ ...r, [row.id]: e.target.value }))} className="flex-1 min-w-[12rem] rounded-full border border-ink/20 bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent" />
                <button type="button" onClick={() => void decide(row.id, 'decline', reasons[row.id]?.trim() ? { note: reasons[row.id]!.trim() } : {})} className="rounded-full border border-ink/20 px-4 py-1.5 text-sm text-ink/80 hover:bg-ink/5">{t('Decline')}</button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
    </section>
  );
}
