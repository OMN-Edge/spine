import { useState } from 'react';
import { api } from '../api';
import { buttonClass, inputClass, Notice } from './AuthCard';
import RecoveryKit from './RecoveryKit';
import { newRecoveryKit } from '../crypto/keys';
import { vaultState } from '../crypto/vault-state';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';

/**
 * Making a new recovery kit. The old one stops working the moment the new one is stored, and the new one is shown before it is
 * stored, so a kit the person never saw is never the only way in. The password is typed to open the vault if this page has no key.
 */
export default function RecoveryKitSettings() {
  const { t } = useI18n();
  const { email } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [fresh, setFresh] = useState<{ recoveryKey: Uint8Array; keys: Awaited<ReturnType<typeof newRecoveryKit>>['keys'] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [open, setOpen] = useState(false);

  const make = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const session = await vaultState.unlock(password);
      setFresh(await newRecoveryKit(session.unlocked, session.keys));
      setPassword('');
    } catch {
      setError(t('That did not match'));
    } finally {
      setBusy(false);
    }
  };

  const store = async () => {
    if (!fresh) return;
    setBusy(true);
    setError('');
    try {
      await api.auth.rewrap({ keys: fresh.keys });
      const session = vaultState.session();
      if (session) session.keys = fresh.keys;
      setFresh(null);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Something went wrong. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5 mt-6">
      <h2 className="font-medium text-gray-900 mb-1">{t('Recovery kit')}</h2>
      <p className="text-sm text-gray-500 mb-4">{t('The recovery kit is the only way back into your records if you forget your password. Make a new one if you have lost yours or shared it; the old one stops working.')}</p>
      {done && <Notice kind="ok">{t('Your new recovery kit is stored. The old one no longer works.')}</Notice>}
      {fresh ? (
        <>
          <RecoveryKit recoveryKey={fresh.recoveryKey} email={email} onDone={store} busy={busy} />
          {error && <Notice kind="error">{error}</Notice>}
        </>
      ) : !open ? (
        <button type="button" onClick={() => { setOpen(true); setDone(false); }} className="border border-gray-300 rounded-lg px-4 py-2 text-gray-700 hover:bg-gray-50">{t('Make a new recovery kit')}</button>
      ) : (
        <form onSubmit={make}>
          <input type="password" placeholder={t('Your password')} autoComplete="current-password"
            value={password} onChange={e => setPassword(e.target.value)} className={inputClass} />
          {error && <Notice kind="error">{error}</Notice>}
          <button type="submit" disabled={busy || !password} className={`${buttonClass} disabled:opacity-50`}>{busy ? t('Making your keys…') : t('Continue')}</button>
        </form>
      )}
    </div>
  );
}
