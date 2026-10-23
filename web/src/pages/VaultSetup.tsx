import { useState } from 'react';
import { api } from '../api';
import AuthCard, { buttonClass, inputClass, Notice } from '../components/AuthCard';
import RecoveryKit from '../components/RecoveryKit';
import { checkPasswordPolicy } from '../crypto/password-policy';
import { createAccountKeys, type NewAccount } from '../crypto/keys';
import { VaultSession } from '../crypto/vault-client';
import { vaultState } from '../crypto/vault-state';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';

/**
 * What an account sees when it has no vault yet: one the operator made, or one from before records were sealed on the device. It
 * chooses a master password, which is new to the server by design, and gets its recovery kit. The kit is shown before anything is
 * sent.
 */
export default function VaultSetup({ done }: { done: () => void }) {
  const { t } = useI18n();
  const { email, setAuthenticated } = useAuth();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [account, setAccount] = useState<NewAccount | null>(null);
  const [busy, setBusy] = useState(false);

  const message = (problem: 'short' | 'long' | 'easy') =>
    problem === 'short' ? t('The password must be at least 12 characters.')
      : problem === 'long' ? t('The password is too long.')
      : t('That password is too easy to guess: use a longer phrase that is not a common word, a pattern or part of your address.');

  const choose = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== again) return setError(t('The two passwords do not match'));
    const problem = checkPasswordPolicy(password, { email });
    if (problem) return setError(message(problem));
    setBusy(true);
    try { setAccount(await createAccountKeys(password)); } catch (err) { setError(err instanceof Error ? err.message : t('Something went wrong. Try again.')); } finally { setBusy(false); }
  };

  const save = async () => {
    if (!account) return;
    setError('');
    setBusy(true);
    try {
      await api.auth.createVault(account);
      vaultState.adopt(VaultSession.adopt(account.unlocked, account.keys));
      done();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Something went wrong. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => { await api.auth.logout(); setAuthenticated(false); };

  return (
    <AuthCard title={t('Protect your records')} footer={<button type="button" onClick={signOut} className="text-blue-600">{t('Sign out')}</button>}>
      {account ? (
        <>
          <RecoveryKit recoveryKey={account.recoveryKey} email={email} onDone={save} busy={busy} />
          {error && <Notice kind="error">{error}</Notice>}
        </>
      ) : (
        <form onSubmit={choose}>
          <p className="text-sm text-gray-600 mb-4">{t('Your records will be locked with a key made from a master password. Spine never receives that password and cannot reset it for you. Choose a new one; it replaces the password you signed in with.')}</p>
          <input type="password" placeholder={t('Master password (at least 12 characters)')} autoComplete="new-password" autoFocus
            value={password} onChange={e => setPassword(e.target.value)} className={inputClass} />
          <input type="password" placeholder={t('Master password again')} autoComplete="new-password"
            value={again} onChange={e => setAgain(e.target.value)} className={inputClass} />
          {error && <Notice kind="error">{error}</Notice>}
          <button type="submit" disabled={busy} className={`${buttonClass} disabled:opacity-50`}>{busy ? t('Making your keys…') : t('Continue')}</button>
        </form>
      )}
    </AuthCard>
  );
}
