import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Notice } from './AuthCard';
import { useI18n } from '../i18n';

type Row = Awaited<ReturnType<typeof api.admin.accounts>>['pending'][number];

/**
 * The accounts that asked for one and wait (SPINE_REGISTRATION=approval), for an address in SPINE_ADMIN_EMAILS. Nothing is drawn for anyone else:
 * the server refuses them, and a refusal is read as "not an administrator". Refusing removes the request and nothing else; it holds no records.
 */
export default function AdminAccounts() {
  const { t, tn } = useI18n();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => { api.admin.accounts().then(r => setRows(r.pending)).catch(() => setRows(null)); }, []);
  useEffect(load, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); load(); } catch (err) { setError(err instanceof Error ? err.message : t('Could not change the request')); }
  };

  if (rows === null) return null;
  return (
    <section className="bg-white border border-gray-200 rounded-xl p-5 mt-6">
      <h2 className="font-medium text-gray-900 mb-1">{t('Accounts waiting for approval')}</h2>
      <p className="text-sm text-gray-500 mb-4">{rows.length === 0 ? t('No one is waiting.') : tn(rows.length, '{n} person is waiting.', '{n} people are waiting.')}</p>
      {error && <Notice kind="error">{error}</Notice>}
      <ul className="divide-y divide-gray-100">
        {rows.map(row => (
          <li key={row.id} className="py-3 flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm text-gray-900 break-all">{row.email}</div>
              <div className="text-xs text-gray-500">{new Date(row.created_at).toLocaleString()}{row.email_confirmed ? '' : ` · ${t('address not confirmed')}`}</div>
            </div>
            <button type="button" onClick={() => void act(() => api.admin.approve(row.id))} className="text-sm rounded-lg bg-brand-600 text-white px-3 py-1.5 hover:bg-brand-700">{t('Approve')}</button>
            <button type="button" onClick={() => void act(() => api.admin.refuse(row.id))} className="text-sm rounded-lg border border-gray-300 px-3 py-1.5 text-gray-700 hover:bg-gray-50">{t('Refuse')}</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
