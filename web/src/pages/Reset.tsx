import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { takeTokenFromUrl } from '../auth';
import AuthCard, { buttonClass, inputClass, Notice } from '../components/AuthCard';
import RecoveryKit from '../components/RecoveryKit';
import { useI18n } from '../i18n';
import { checkPasswordPolicy } from '../crypto/password-policy';
import { createAccountKeys, resetWithRecovery, type NewAccount, type VaultKeyPayload } from '../crypto/keys';
import { OpenError } from '../crypto/seal';
import { readRecoveryKey } from '../crypto/recovery-kit';

type Stored = Pick<VaultKeyPayload, 'wrapped_by_recovery' | 'public_key' | 'wrapped_private_key'>;
type Mode = { kind: 'loading' } | { kind: 'legacy' } | { kind: 'vault'; stored: Stored } | { kind: 'bad' };

/**
 * A reset link. For an account with a vault the password alone cannot be reset: the recovery kit opens the account key, which is then
 * sealed under the new password, and the records stay readable. Without the kit the only way on is to erase the records and start empty,
 * and the page says so before it does (TR-CRY-04).
 */
export default function Reset() {
  const { t } = useI18n();
  // Read once, on first render. StrictMode renders twice, but the second read would
  // find the fragment already removed, so keep the first.
  const token = useRef<string | null>(null);
  if (token.current === null) token.current = takeTokenFromUrl();

  const [mode, setMode] = useState<Mode>({ kind: 'loading' });
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [kit, setKit] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [fresh, setFresh] = useState<NewAccount | null>(null);

  useEffect(() => {
    if (!token.current) { setMode({ kind: 'bad' }); return; }
    api.auth.resetKeys(token.current)
      .then(r => setMode(r.vault ? { kind: 'vault', stored: r as unknown as Stored } : { kind: 'legacy' }))
      .catch(() => setMode({ kind: 'bad' }));
  }, []);

  const message = (problem: 'short' | 'long' | 'easy') =>
    problem === 'short' ? t('The password must be at least 12 characters.')
      : problem === 'long' ? t('The password is too long.')
      : t('That password is too easy to guess: use a longer phrase that is not a common word, a pattern or part of your address.');

  const failed = (err: unknown) => setError(err instanceof Error ? err.message : t('Could not reset the password'));

  const submitLegacy = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== again) return setError(t('The two passwords do not match'));
    try {
      await api.auth.reset(token.current ?? '', password);
      setDone(true);
    } catch (err) { failed(err); }
  };

  const checkNew = (): boolean => {
    if (password !== again) { setError(t('The two passwords do not match')); return false; }
    const problem = checkPasswordPolicy(password);
    if (problem) { setError(message(problem)); return false; }
    return true;
  };

  const submitWithKit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (mode.kind !== 'vault' || !checkNew()) return;
    const read = await readRecoveryKey(kit);
    if (!read.ok) {
      return setError(read.reason === 'check' ? t('That recovery kit has a typing error. Check it against the sheet.') : t('That is not a complete recovery kit.'));
    }
    setBusy(true);
    try {
      const reset = await resetWithRecovery(read.key, mode.stored, password);
      await api.auth.resetVault(token.current ?? '', reset);
      setDone(true);
    } catch (err) {
      if (err instanceof OpenError) setError(t('That recovery kit does not open this account.'));
      else failed(err);
    } finally { setBusy(false); }
  };

  const startOver = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!understood || !checkNew()) return;
    setBusy(true);
    try { setFresh(await createAccountKeys(password)); } catch (err) { failed(err); } finally { setBusy(false); }
  };

  const eraseAndSave = async () => {
    if (!fresh) return;
    setBusy(true);
    setError('');
    try {
      await api.auth.resetVault(token.current ?? '', fresh, true);
      setDone(true);
    } catch (err) { failed(err); } finally { setBusy(false); }
  };

  return (
    <AuthCard title={t('Choose a new password')} footer={<p><Link to="/login" className="text-brand-600">{t('Go to sign in')}</Link></p>}>
      {done ? (
        <Notice kind="ok">{t('Your password is changed. You have been signed out everywhere; sign in with the new one.')}</Notice>
      ) : mode.kind === 'bad' ? (
        <Notice kind="error">{t('This link is incomplete. Use the link from the email in full.')}</Notice>
      ) : mode.kind === 'loading' ? (
        <p className="text-gray-400">{t('Loading…')}</p>
      ) : mode.kind === 'legacy' ? (
        <form onSubmit={submitLegacy}>
          <input type="password" placeholder={t('New password (at least 12 characters)')} autoComplete="new-password" autoFocus
            value={password} onChange={e => setPassword(e.target.value)} className={inputClass} />
          <input type="password" placeholder={t('New password again')} autoComplete="new-password"
            value={again} onChange={e => setAgain(e.target.value)} className={inputClass} />
          {error && <Notice kind="error">{error}</Notice>}
          <button type="submit" className={buttonClass}>{t('Change password')}</button>
        </form>
      ) : fresh ? (
        <>
          <RecoveryKit recoveryKey={fresh.recoveryKey} email="" onDone={eraseAndSave} busy={busy} />
          {error && <Notice kind="error">{error}</Notice>}
        </>
      ) : !erasing ? (
        <form onSubmit={submitWithKit}>
          <p className="text-sm text-gray-600 mb-3">{t('Enter your recovery kit and a new password. Your records stay as they are.')}</p>
          <input type="text" placeholder={t('Recovery kit')} autoComplete="off" autoCapitalize="characters" spellCheck={false} autoFocus
            value={kit} onChange={e => setKit(e.target.value)} className={`${inputClass} font-mono`} />
          <input type="password" placeholder={t('New password (at least 12 characters)')} autoComplete="new-password"
            value={password} onChange={e => setPassword(e.target.value)} className={inputClass} />
          <input type="password" placeholder={t('New password again')} autoComplete="new-password"
            value={again} onChange={e => setAgain(e.target.value)} className={inputClass} />
          {error && <Notice kind="error">{error}</Notice>}
          <button type="submit" disabled={busy} className={`${buttonClass} disabled:opacity-50`}>{busy ? t('Making your keys…') : t('Change password')}</button>
          <button type="button" onClick={() => { setErasing(true); setError(''); }} className="mt-4 text-sm text-gray-500 hover:underline">{t('I do not have my recovery kit')}</button>
        </form>
      ) : (
        <form onSubmit={startOver}>
          <Notice kind="error">{t('Without the recovery kit your records cannot be opened by anyone, including Spine. You can start again with an empty account; everything stored now will be erased.')}</Notice>
          <label className="flex items-start gap-2 text-sm text-gray-700 my-3">
            <input type="checkbox" checked={understood} onChange={e => setUnderstood(e.target.checked)} className="mt-1" />
            <span>{t('I understand that my records will be erased and cannot be brought back.')}</span>
          </label>
          <input type="password" placeholder={t('New password (at least 12 characters)')} autoComplete="new-password"
            value={password} onChange={e => setPassword(e.target.value)} className={inputClass} />
          <input type="password" placeholder={t('New password again')} autoComplete="new-password"
            value={again} onChange={e => setAgain(e.target.value)} className={inputClass} />
          {error && <Notice kind="error">{error}</Notice>}
          <button type="submit" disabled={!understood || busy} className={`${buttonClass} disabled:opacity-50`}>{t('Continue')}</button>
          <button type="button" onClick={() => { setErasing(false); setError(''); }} className="mt-4 text-sm text-gray-500 hover:underline">{t('I have my recovery kit')}</button>
        </form>
      )}
    </AuthCard>
  );
}
