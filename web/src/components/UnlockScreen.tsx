import { useEffect, useState, type FormEvent } from 'react';
import { useI18n } from '../i18n';
import { vaultState, OpenError } from '../crypto/vault-state';
import { api } from '../api';
import { prfSupported } from '../crypto/passkey-prf';
import AuthCard, { Notice, buttonClass, inputClass } from './AuthCard';

/**
 * Shown when someone is signed in but the records are not open: after a reload, the page has forgotten the master key, and the
 * records can only be opened with it. Nothing is sent: the password is turned into the key here.
 */
export default function UnlockScreen({ opened, signOut }: { opened: () => void; signOut: () => void }) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // While the password is typed: the core loads, and the server is asked for what opening the records will need.
  useEffect(() => { vaultState.prefetch(); }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await vaultState.unlock(password);
      opened();
    } catch (err) {
      if (!(err instanceof OpenError)) console.error('could not open the records', err);
      setError(err instanceof OpenError ? t('That is not the master password.') : t('Something went wrong. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  // The passkey signs in again (a fresh session) and, if it opens the vault, hands over the key to do so.
  const withPasskey = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api.auth.passkeys.signIn();
      if (!result.unlock) { setError(t('This passkey does not open your records. Use the master password.')); return; }
      await vaultState.unlockWithPasskey(result.unlock);
      opened();
    } catch (err) {
      if (!(err instanceof Error && err.name === 'NotAllowedError')) setError(t('Something went wrong. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title={t('Open your records')}
      footer={<button type="button" onClick={() => { void api.auth.logout().then(signOut); }} className="text-brand-600">{t('Sign out')}</button>}
    >
      <form onSubmit={submit}>
        <p className="text-sm text-gray-600 mb-4">{t('Your records are encrypted on this device. Type your master password to open them.')}</p>
        <input
          type="password" autoFocus autoComplete="current-password" aria-label={t('Master password')} placeholder={t('Master password')}
          value={password} onChange={e => setPassword(e.target.value)} className={inputClass}
        />
        {error && <Notice kind="error">{error}</Notice>}
        <button type="submit" disabled={busy || password.length === 0} className={buttonClass}>{busy ? t('Opening…') : t('Open')}</button>
        {prfSupported() && api.auth.passkeys.supported() && (
          <button type="button" onClick={() => void withPasskey()} disabled={busy} className="mt-3 w-full rounded-full border border-gray-300 px-4 py-2 text-gray-700 hover:bg-gray-50 disabled:opacity-50">{t('Open with a passkey')}</button>
        )}
      </form>
    </AuthCard>
  );
}
