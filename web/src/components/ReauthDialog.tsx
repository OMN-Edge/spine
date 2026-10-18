import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { registerReauthAsker } from '../reauth';
import { buttonClass, inputClass, Notice } from './AuthCard';
import { useI18n } from '../i18n';

/** Asks for the password again (and a code, if two-factor is on) before something that could give away the whole archive. */
export default function ReauthDialog() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const settle = useRef<((ok: boolean) => void) | null>(null);

  const close = useCallback((ok: boolean) => {
    setOpen(false);
    setPassword(''); setCode(''); setNeedsCode(false); setError('');
    settle.current?.(ok);
    settle.current = null;
  }, []);

  useEffect(() => {
    registerReauthAsker(() => new Promise<boolean>(resolve => {
      settle.current?.(false);
      settle.current = resolve;
      setOpen(true);
    }));
    return () => registerReauthAsker(null);
  }, []);

  if (!open) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.auth.reauth(password, needsCode ? code : undefined);
      close(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'code_required') setNeedsCode(true);
      else setError(err instanceof ApiError && err.status === 429 ? t('Too many attempts, try again in a few minutes') : t('That did not match'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" role="dialog" aria-modal="true">
      <form onSubmit={submit} className="bg-white rounded-xl shadow-lg border border-gray-200 w-full max-w-sm p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-2">{t('Confirm it is you')}</h2>
        <p className="text-sm text-gray-500 mb-4">{t('Type your password again to continue. This is asked before the whole archive is taken or a link shows page images.')}</p>
        <input type="password" autoFocus placeholder={t('Password')} autoComplete="current-password"
          value={password} onChange={e => setPassword(e.target.value)} className={inputClass} />
        {needsCode && (
          <input type="text" inputMode="numeric" placeholder={t('6-digit code')} autoComplete="one-time-code"
            value={code} onChange={e => setCode(e.target.value)} className={inputClass} />
        )}
        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex gap-2">
          <button type="button" onClick={() => close(false)} className="flex-1 border border-gray-300 rounded-lg px-4 py-2 text-gray-700 hover:bg-gray-50">{t('Cancel')}</button>
          <button type="submit" disabled={busy || !password} className={buttonClass}>{t('Continue')}</button>
        </div>
      </form>
    </div>
  );
}
