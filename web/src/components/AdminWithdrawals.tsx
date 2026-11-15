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
    <section className="bg-white border border-gray-200 rounded-xl p-5">
      <h2 className="font-medium text-gray-900 mb-1">{t('Withdrawal requests')}</h2>
      {error && <Notice kind="error">{error}</Notice>}
      {rows && <p className="text-sm text-gray-500 mb-3">{rows.length === 0 ? t('No one has asked to withdraw.') : tn(rows.length, '{n} request is waiting.', '{n} requests are waiting.')}</p>}
      <ul className="divide-y divide-gray-100">
        {rows?.map(row => {
          const amount = Number(amounts[row.id]);
          return (
            <li key={row.id} className="py-3 space-y-2">
              <div className="text-sm text-gray-900 break-all">{row.email ?? '—'}{row.plan ? ` · ${row.plan}${row.interval ? ` (${row.interval})` : ''}` : ''}</div>
              <div className="text-xs text-gray-500">{t('Requested {date}', { date: new Date(row.requested_at).toLocaleDateString() })}{row.first_payment ? ` · ${t('First payment {date}', { date: new Date(row.first_payment).toLocaleDateString() })}` : ''}</div>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => void decide(row.id, 'refund')} className="text-sm rounded-lg bg-brand-600 text-white px-3 py-1.5 hover:bg-brand-700">{t('Refund in full and end the plan')}</button>
                <input aria-label={t('Amount')} inputMode="decimal" placeholder={t('Amount')} value={amounts[row.id] ?? ''} onChange={e => setAmounts(a => ({ ...a, [row.id]: e.target.value }))} className="w-24 border border-gray-300 rounded-lg px-2 py-1.5 text-sm" />
                <button type="button" disabled={!(amount > 0)} onClick={() => void decide(row.id, 'refund', { amount })} className="text-sm rounded-lg border border-gray-300 px-3 py-1.5 text-gray-700 hover:bg-gray-50 disabled:opacity-50">{t('Refund this amount and end the plan')}</button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input aria-label={t('Reason for declining (the buyer is told)')} placeholder={t('Reason for declining (the buyer is told)')} value={reasons[row.id] ?? ''} onChange={e => setReasons(r => ({ ...r, [row.id]: e.target.value }))} className="flex-1 min-w-[12rem] border border-gray-300 rounded-lg px-2 py-1.5 text-sm" />
                <button type="button" onClick={() => void decide(row.id, 'decline', reasons[row.id]?.trim() ? { note: reasons[row.id]!.trim() } : {})} className="text-sm rounded-lg border border-gray-300 px-3 py-1.5 text-gray-700 hover:bg-gray-50">{t('Decline')}</button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
