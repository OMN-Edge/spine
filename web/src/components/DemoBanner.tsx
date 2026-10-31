import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, type UploadSummary } from '../api';
import { useAuth } from '../auth';
import { deviceFetch } from '../core/client';
import { keepForAccount } from '../demo-carry';
import { useI18n } from '../i18n';

/**
 * The line above every page of the demo: that it is one and keeps nothing. Once the visitor has read files of their own (SECURITY.md M-39),
 * it offers to keep them in an account: the demo's export, without the sample records, waits in this browser (`demo-carry.ts`) and is added
 * when they have signed in. Until then, leaving the page asks first, since what they uploaded would be gone.
 */
export default function DemoBanner() {
  const { t, tn } = useI18n();
  const { leaveDemo, demoUploads } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [own, setOwn] = useState<UploadSummary[]>([]);
  const [registration, setRegistration] = useState<'open' | 'operator' | 'approval'>('operator');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { api.auth.options().then(o => setRegistration(o.registration)).catch(() => {}); }, []);
  const refresh = useCallback(() => { api.sourceFiles.list().then(list => setOwn(list.filter(u => !u.sample))).catch(() => {}); }, []);
  useEffect(() => {
    if (!demoUploads) return;
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => window.clearInterval(timer);
  }, [demoUploads, refresh, location.pathname]);

  // What they uploaded is only in this page: a reload or a closed tab would lose it, so the browser asks.
  useEffect(() => {
    if (own.length === 0) return;
    const ask = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [own.length]);

  const reading = own.some(u => u.status === 'pending' || u.status === 'processing');
  const keep = async () => {
    setBusy(true); setError('');
    try {
      // The sample records are invented and every account can have its own: only the visitor's files go along.
      await api.demo.remove().catch(() => undefined);
      const res = await deviceFetch('/api/export');
      if (!res.ok) throw new Error('export');
      await keepForAccount(await res.blob(), own.length);
      await leaveDemo();
      navigate(registration === 'operator' ? '/login' : '/register');
    } catch {
      setError(t('Your files could not be kept in this browser. Try again.'));
      setBusy(false);
    }
  };

  return (
    <div role="status" className="bg-brand-50 border-b border-brand-200 px-4 sm:px-6 py-2.5 text-sm text-brand-900 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <span>
        {t('This is a demo with invented records. Nothing you do here is saved, and it ends when you leave or reload the page.')}
        {own.length > 0 && <> {tn(own.length, 'Your {n} file is kept only in this page until you keep it in an account.', 'Your {n} files are kept only in this page until you keep them in an account.')}</>}
        {error && <span className="block text-red-700">{error}</span>}
      </span>
      {own.length > 0 ? (
        <button
          type="button" onClick={() => void keep()} disabled={busy || reading} title={reading ? t('Wait until your files have been read') : undefined}
          className="shrink-0 rounded-full bg-brand-600 px-3 py-1 font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {registration === 'open' ? t('Create an account to keep them') : registration === 'approval' ? t('Ask for an account to keep them') : t('Sign in to keep them')}
        </button>
      ) : (
        <Link to="/login" className="shrink-0 font-medium text-brand-700 hover:underline">{t('Sign in')}</Link>
      )}
    </div>
  );
}
