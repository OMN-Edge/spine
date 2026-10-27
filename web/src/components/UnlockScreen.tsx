import { useState, type FormEvent } from 'react';
import { useI18n } from '../i18n';
import { vaultState, OpenError } from '../crypto/vault-state';
import { api } from '../api';
import { prfSupported } from '../crypto/passkey-prf';

/**
 * Shown when someone is signed in but the records are not open: after a reload, the page has forgotten the master key, and the
 * records can only be opened with it. Nothing is sent: the password is turned into the key here.
 */
export default function UnlockScreen({ opened, signOut }: { opened: () => void; signOut: () => void }) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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
    <div className="min-h-screen flex items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4">
        <h1 className="text-xl font-semibold text-gray-900">{t('Open your records')}</h1>
        <p className="text-sm text-gray-600">{t('Your records are encrypted on this device. Type your master password to open them.')}</p>
        <label className="block text-sm text-gray-700">
          {t('Master password')}
          <input type="password" autoFocus autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} className="mt-1 w-full rounded border border-gray-300 px-3 py-2" />
        </label>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <div className="flex items-center justify-between">
          <button type="submit" disabled={busy || password.length === 0} className="rounded bg-gray-900 px-4 py-2 text-sm text-white disabled:opacity-50">{busy ? t('Opening…') : t('Open')}</button>
          {prfSupported() && api.auth.passkeys.supported() && <button type="button" onClick={() => void withPasskey()} disabled={busy} className="text-sm text-brand-600 hover:underline">{t('Open with a passkey')}</button>}
          <button type="button" onClick={() => { void api.auth.logout().then(signOut); }} className="text-sm text-gray-500 hover:text-gray-700">{t('Sign out')}</button>
        </div>
      </form>
    </div>
  );
}
