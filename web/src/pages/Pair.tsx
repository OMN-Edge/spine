import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import AuthCard, { buttonClass, inputClass, Notice } from '../components/AuthCard';
import { useI18n } from '../i18n';
import { vaultState } from '../crypto/vault-state';

/**
 * The new device's side of being let in by one that is signed in (SECURITY.md M-41): type the code it shows (or arrive by its QR, which
 * carries the code after the #), wait for the person to approve this device there, and the records open, as after a passkey sign-in.
 */
export default function Pair() {
  const { t } = useI18n();
  const { setAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [code, setCode] = useState(() => window.location.hash.slice(1));
  const [error, setError] = useState('');
  const [waiting, setWaiting] = useState(false);
  const stop = useRef<AbortController | null>(null);

  // The code is a secret for ten minutes: once read from the address it is taken out of it, and out of the history.
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
    return () => stop.current?.abort();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setWaiting(true);
    stop.current = new AbortController();
    try {
      const joined = await api.enrol.join(code, stop.current.signal);
      vaultState.setEmail(joined.email);
      await vaultState.unlockWithPasskey(joined.unlock);
      setCode('');
      setAuthenticated(true, joined.email);
      navigate('/');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setWaiting(false);
      const code = err instanceof ApiError ? err.code : '';
      setError(code === 'bad_code' ? t('The code is not right. Check each character.')
        : code === 'refused' ? t('The other device did not allow this one.')
        : code === 'expired' ? t('This code is not valid, or it has expired.')
        : t('Could not open your records with this code. Try again.'));
    }
  };

  return (
    <AuthCard title={t('Use a code from another device')} footer={<p><Link to="/login" className="text-brand-600">{t('Back to sign in')}</Link></p>}>
      {waiting ? (
        <>
          <p className="text-sm text-gray-600 mb-4" role="status">{t('Waiting for you to approve this device on the other one. Keep this page open.')}</p>
          <button type="button" onClick={() => { stop.current?.abort(); setWaiting(false); }} className="text-sm text-gray-500 hover:underline">{t('Cancel')}</button>
        </>
      ) : (
        <form onSubmit={submit}>
          <p className="text-sm text-gray-600 mb-3">{t('Open your records here without your master password. On a device where you are signed in, open Account, choose “Add a device” and enter the code it shows.')}</p>
          <input
            type="text" placeholder={t('Code')} autoComplete="off" autoFocus spellCheck={false} autoCapitalize="characters"
            value={code} onChange={e => setCode(e.target.value)} className={`${inputClass} font-mono tracking-wider`}
          />
          {error && <Notice kind="error">{error}</Notice>}
          <button type="submit" className={buttonClass} disabled={!code.trim()}>{t('Continue')}</button>
        </form>
      )}
    </AuthCard>
  );
}
