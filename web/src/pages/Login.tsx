import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError, type AuthOptions } from '../api';
import { useAuth } from '../auth';
import AuthCard, { buttonClass, inputClass, Notice } from '../components/AuthCard';
import { useI18n } from '../i18n';
import { vaultState } from '../crypto/vault-state';
import { inAppPath } from '../safe-path';

export default function Login() {
  const { t } = useI18n();
  const { setAuthenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // Router state set by the app itself from the address it was opened at, which anyone can craft; only an in-app path is followed.
  const home = inAppPath((location.state as { from?: unknown } | null)?.from);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [unverified, setUnverified] = useState(false);
  // The password was right and the account has a second factor: ask for the code.
  const [needsCode, setNeedsCode] = useState(false);
  const [code, setCode] = useState('');
  const [resent, setResent] = useState('');
  const [options, setOptions] = useState<AuthOptions>({ registration: 'operator', recovery: false, instance: 'public' });

  useEffect(() => {
    api.auth.options().then(setOptions).catch(() => {});
  }, []);
  // The core loads while the address and password are typed, and the key is derived in it, not in the page.
  useEffect(() => { vaultState.prefetch(); }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setUnverified(false);
    setResent('');
    try {
      const result = await api.auth.login(email, password);
      if (result.second_factor_required) {
        setPassword(''); // it has done its job; do not keep it in the page
        setNeedsCode(true);
        return;
      }
      setAuthenticated(true, result.email ?? email);
      navigate(home);
    } catch (err) {
      // The server's own words: "incorrect email or password", a rate-limit
      // notice, or that the address is not confirmed yet. It deliberately does
      // not say which half of a wrong login was wrong.
      setUnverified(err instanceof ApiError && err.code === 'email_not_verified');
      setError(err instanceof ApiError && err.code === 'awaiting_approval'
        ? t('Your account is waiting for the administrator to approve it. You will be able to sign in once it has.')
        : err instanceof Error ? err.message : t('Could not sign in'));
    }
  };

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const result = await api.auth.secondFactor(code);
      setAuthenticated(true, result.email);
      navigate(home);
    } catch (err) {
      // Too many wrong codes, or too long since the password: start again.
      if (err instanceof ApiError && err.code === 'login_expired') {
        setNeedsCode(false);
        setCode('');
      }
      setError(err instanceof Error ? err.message : t('Could not sign in'));
    }
  };

  // Signing in with the device's fingerprint, face or PIN. The browser shows its own sheet; cancelling it is not an error.
  const withPasskey = async () => {
    setError('');
    try {
      const result = await api.auth.passkeys.signIn();
      vaultState.setEmail(result.email);
      // A passkey that opens the vault leaves the records open; otherwise the master password is asked for, as after a reload.
      if (result.unlock) await vaultState.unlockWithPasskey(result.unlock).catch(() => undefined);
      setAuthenticated(true, result.email);
      navigate(home);
    } catch (err) {
      if (err instanceof Error && err.name === 'NotAllowedError') return;
      setError(err instanceof Error ? err.message : t('Could not sign in'));
    }
  };

  const resend = async () => {
    try {
      setResent((await api.auth.resendVerification(email)).message);
    } catch (err) {
      setResent(err instanceof Error ? err.message : t('Could not send the link'));
    }
  };

  return (
    <AuthCard
      title="Spine"
      footer={
        <>
          {options.recovery && <p><Link to="/forgot" className="text-brand-600">{t('Forgot your password?')}</Link></p>}
          <p><Link to="/pair" className="text-brand-600">{t('Use a code from another device')}</Link></p>
          {options.registration !== 'operator' && <p>{t('No account?')} <Link to="/register" className="text-brand-600">{options.registration === 'approval' ? t('Ask for one') : t('Create one')}</Link></p>}
        </>
      }
    >
      {needsCode ? (
        <form onSubmit={submitCode}>
          <p className="text-sm text-gray-600 mb-3">
            {t('Enter the code from your authenticator app, or one of your recovery codes.')}
          </p>
          <input
            type="text" placeholder={t('Code')} autoComplete="one-time-code" autoFocus
            inputMode="text" autoCapitalize="characters" spellCheck={false}
            value={code} onChange={e => setCode(e.target.value)} className={inputClass}
          />
          {error && <Notice kind="error">{error}</Notice>}
          <button type="submit" className={buttonClass}>{t('Continue')}</button>
        </form>
      ) : (
      <form onSubmit={submit}>
        <input
          type="email" placeholder={t('Email')} autoComplete="username" autoFocus
          value={email} onChange={e => setEmail(e.target.value)} className={inputClass}
        />
        <input
          type="password" placeholder={t('Password')} autoComplete="current-password"
          value={password} onChange={e => setPassword(e.target.value)} className={inputClass}
        />
        {error && <Notice kind="error">{error}</Notice>}
        {unverified && (
          <p className="text-sm mb-3">
            <button type="button" onClick={resend} className="text-brand-600 underline">
              {t('Send the confirmation link again')}
            </button>
          </p>
        )}
        {resent && <Notice kind="ok">{resent}</Notice>}
        <button type="submit" className={buttonClass}>{t('Sign in')}</button>
        {api.auth.passkeys.supported() && (
          <button type="button" onClick={withPasskey} className="w-full mt-3 border border-gray-300 text-gray-700 rounded-full px-4 py-2 font-medium hover:bg-gray-50">
            {t('Sign in with a passkey')}
          </button>
        )}
      </form>
      )}
    </AuthCard>
  );
}
