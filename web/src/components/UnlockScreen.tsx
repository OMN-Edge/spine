import { useEffect, useState, type FormEvent } from 'react';
import { useI18n } from '../i18n';
import { vaultState, OpenError } from '../crypto/vault-state';
import { coreStep } from '../core/client';
import { classifyOpenFailure, type OpenFailure } from '../core/open-failure';
import CopyDetails from './CopyDetails';
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
  // Why the records did not open when the password was not the reason: the sign-in's attempt, or the one made here.
  const [failure, setFailure] = useState<OpenFailure | null>(() => vaultState.openFailure());
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
      if (err instanceof OpenError) { setError(t('That is not the master password.')); return; }
      console.error('could not open the records', err);
      const found = classifyOpenFailure(err, coreStep());
      if (found.kind === 'key') setError(t('That is not the master password.'));
      else setFailure(found);
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

  // Tried again from the sign-in's key when there is one, else with the password typed here.
  const tryAgain = async () => {
    setBusy(true);
    try {
      if (await vaultState.startDevice() === 'open') { vaultState.forgetOpenFailure(); opened(); return; }
      if (password) { setFailure(null); await submit({ preventDefault() {} } as FormEvent); return; }
      setFailure(null);
    } catch (err) {
      setFailure(classifyOpenFailure(err, coreStep()));
    } finally {
      setBusy(false);
    }
  };

  if (failure && failure.kind !== 'key') {
    return (
      <AuthCard
        title={t('Your records did not open')}
        footer={<button type="button" onClick={() => { void api.auth.logout().then(signOut); }} className="text-brand-600">{t('Sign out')}</button>}
      >
        <p className="text-sm text-gray-900 mb-2">{failure.kind === 'vault' ? t('We can’t reach your vault right now.') : t('We couldn’t load your records on this device.')}</p>
        <p className="text-sm text-gray-600 mb-4">{t('Your password was accepted, so there is no need to change it. Try again, and if it keeps happening, copy the details and send them to support.')}</p>
        <button type="button" onClick={() => void tryAgain()} disabled={busy} className={buttonClass}>{busy ? t('Opening…') : t('Try again')}</button>
        <div className="mt-3"><CopyDetails report={failure.report} /></div>
      </AuthCard>
    );
  }

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
