import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Notice } from './AuthCard';
import { useI18n } from '../i18n';
import { useFormat } from '../format';
import Pager, { usePage } from './Pager';

type Row = Awaited<ReturnType<typeof api.admin.accounts>>['pending'][number];

/**
 * The accounts that asked for one and wait (SPINE_REGISTRATION=approval), for an address in SPINE_ADMIN_EMAILS. Nothing is drawn for anyone else:
 * the server refuses them, and a refusal is read as "not an administrator". Refusing removes the request and nothing else; it holds no records.
 */
export default function AdminAccounts() {
  const { t, tn } = useI18n();
  const format = useFormat();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  const [paging, setPaging] = useState({ total: 0, limit: 25 });
  const [page, setPage] = usePage();

  const load = useCallback(() => { api.admin.accounts(page).then(r => { setRows(r.pending); setPaging({ total: r.total, limit: r.limit }); }).catch(() => setRows(null)); }, [page]);
  useEffect(load, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); load(); } catch (err) { setError(err instanceof Error ? err.message : t('Could not change the request')); }
  };

  if (rows === null) return null;
  return (
    <section>
      <h2 className="font-display text-[clamp(1.5rem,2.6vw,2rem)] font-normal leading-tight">{t('Accounts waiting for approval')}</h2>
      <div className="mt-5 rounded-2xl border border-ink/10 bg-surface p-5">
      <p className="text-sm text-ink/60 mb-4">{paging.total === 0 ? t('No one is waiting.') : tn(paging.total, '{n} person is waiting.', '{n} people are waiting.')}</p>
      {error && <Notice kind="error">{error}</Notice>}
      <ul className="divide-y divide-ink/10">
        {rows.map(row => (
          <li key={row.id} className="py-3 flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm text-ink break-all">{row.email}</div>
              <div className="text-xs text-ink/60">{format.dateTime(row.created_at)}{row.email_confirmed ? '' : ` · ${t('address not confirmed')}`}</div>
            </div>
            <button type="button" onClick={() => void act(() => api.admin.approve(row.id))} className="rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-paper hover:bg-accent/90">{t('Approve')}</button>
            <button type="button" onClick={() => void act(() => api.admin.refuse(row.id))} className="rounded-full border border-ink/20 px-4 py-1.5 text-sm text-ink/80 hover:bg-ink/5">{t('Refuse')}</button>
          </li>
        ))}
      </ul>
      <Pager page={page} total={paging.total} limit={paging.limit} onPage={setPage} />
    </div>
    </section>
  );
}
