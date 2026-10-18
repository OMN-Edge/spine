import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Notice } from './AuthCard';
import { useI18n } from '../i18n';

type Row = Awaited<ReturnType<typeof api.auth.sessions.list>>[number];

/** The browser name from a user-agent string, enough to tell a phone from a laptop; the full string proves nothing. */
function browserOf(agent: string): string {
  const a = agent.toLowerCase();
  const browser = a.includes('edg/') ? 'Edge' : a.includes('firefox') ? 'Firefox' : a.includes('chrome') ? 'Chrome' : a.includes('safari') ? 'Safari' : '';
  const system = a.includes('iphone') ? 'iPhone' : a.includes('ipad') ? 'iPad' : a.includes('android') ? 'Android' : a.includes('mac os') ? 'macOS' : a.includes('windows') ? 'Windows' : a.includes('linux') ? 'Linux' : '';
  return [browser, system].filter(Boolean).join(' · ');
}

/** Where the account is signed in, with a way to end each one (SECURITY.md S-33). */
export default function Sessions() {
  const { t } = useI18n();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.auth.sessions.list().then(setRows).catch(() => setError(t('Could not load your sign-ins')));
  }, [t]);
  useEffect(load, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); load(); } catch { setError(t('Could not end the sign-in')); }
  };

  const when = (iso: string) => new Date(iso).toLocaleString();
  const others = (rows ?? []).filter(r => !r.current).length;

  return (
    <section className="bg-white border border-gray-200 rounded-xl p-5 mt-6">
      <h2 className="font-medium text-gray-900 mb-1">{t('Where you are signed in')}</h2>
      <p className="text-sm text-gray-500 mb-4">{t('If you do not recognise one, end it and change your password.')}</p>
      {error && <Notice kind="error">{error}</Notice>}
      <ul className="divide-y divide-gray-100">
        {(rows ?? []).map(row => (
          <li key={row.id} className="py-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-gray-900">
                {browserOf(row.user_agent) || t('A browser')}
                {row.current && <span className="ml-2 text-xs text-green-700">{t('This browser')}</span>}
              </p>
              <p className="text-xs text-gray-500">{t('Signed in {when}', { when: when(row.created_at) })} · {t('last used {when}', { when: when(row.last_seen_at) })}</p>
              {row.address && <p className="text-xs text-gray-400 break-all">{row.address}</p>}
            </div>
            {!row.current && (
              <button onClick={() => act(() => api.auth.sessions.end(row.id))} className="text-sm text-red-600 hover:underline shrink-0">{t('End')}</button>
            )}
          </li>
        ))}
      </ul>
      {others > 0 && (
        <button onClick={() => act(() => api.auth.sessions.endOthers())} className="mt-3 text-sm text-red-600 hover:underline">{t('Sign out everywhere else')}</button>
      )}
    </section>
  );
}
