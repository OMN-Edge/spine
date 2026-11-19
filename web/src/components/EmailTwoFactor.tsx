import { useEffect, useState } from 'react';
import { api } from '../api';
import { inputClass, Notice, secondaryButtonClass } from './AuthCard';
import { useI18n } from '../i18n';

type Step =
  | { name: 'loading' }
  | { name: 'hidden' }
  | { name: 'off' }
  | { name: 'sent' }
  | { name: 'on'; required: boolean }
  | { name: 'turning-off'; required: boolean };

/**
 * A code sent to the address as the second step, for an account with no authenticator app (SECURITY.md S-20). The server holds the rules (the password
 * starts it, the code typed back finishes it, the operator may require it); this collects what it asks for. It is shown beside the authenticator's
 * card only while there is no authenticator, which takes its place.
 */
export default function EmailTwoFactor({ onState }: { onState?: (on: boolean) => void }) {
  const { t } = useI18n();
  const [step, setStep] = useState<Step>({ name: 'loading' });
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  const refresh = async () => {
    const status = await api.auth.emailSecondFactor.status();
    onState?.(status.enabled);
    if (status.enabled) setStep({ name: 'on', required: status.required });
    else setStep(status.available ? { name: 'off' } : { name: 'hidden' });
  };
  useEffect(() => { refresh().catch(() => setStep({ name: 'hidden' })); }, []);

  const reset = () => { setPassword(''); setCode(''); setError(''); };
  const fail = (err: unknown, fallback: string) => setError(err instanceof Error ? err.message : fallback);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api.auth.emailSecondFactor.start(password);
      setPassword('');
      setStep({ name: 'sent' });
    } catch (err) {
      fail(err, t('The code could not be sent. Try again in a moment.'));
    }
  };

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api.auth.emailSecondFactor.enable(code);
      reset();
      await refresh();
    } catch (err) {
      fail(err, t('That code was not accepted'));
    }
  };

  const turnOff = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api.auth.emailSecondFactor.disable(password);
      reset();
      await refresh();
    } catch (err) {
      fail(err, t('Could not change it'));
    }
  };

  const card = 'bg-white border border-gray-200 rounded-xl p-5 mt-6';
  if (step.name === 'loading' || step.name === 'hidden') return null;

  if (step.name === 'off') {
    return (
      <form onSubmit={send} className={card}>
        <h2 className="font-medium text-gray-900 mb-1">{t('Code by email')}</h2>
        <p className="text-sm text-gray-500 mb-4">
          {t('Off. With it on, signing in also needs a code we send to your email address, so a stolen password alone is not enough.')}
        </p>
        <input type="password" placeholder={t('Your password')} autoComplete="current-password"
          value={password} onChange={e => setPassword(e.target.value)} className={inputClass} />
        {error && <Notice kind="error">{error}</Notice>}
        <button type="submit" className={secondaryButtonClass}>{t('Send me a code')}</button>
      </form>
    );
  }

  if (step.name === 'sent') {
    return (
      <form onSubmit={confirm} className={card}>
        <h2 className="font-medium text-gray-900 mb-1">{t('Code by email')}</h2>
        <p className="text-sm text-gray-500 mb-3">{t('We sent a six-digit code to your email address. Type it here to turn this on.')}</p>
        <input type="text" inputMode="numeric" placeholder={t('6-digit code')} autoComplete="one-time-code" autoFocus
          value={code} onChange={e => setCode(e.target.value)} className={inputClass} />
        {error && <Notice kind="error">{error}</Notice>}
        <button type="submit" className={secondaryButtonClass}>{t('Turn on')}</button>
        <button type="button" className="mt-2 text-sm text-gray-500 underline" onClick={() => { reset(); refresh(); }}>{t('Cancel')}</button>
      </form>
    );
  }

  if (step.name === 'on') {
    return (
      <div className={card}>
        <h2 className="font-medium text-gray-900 mb-1">{t('Code by email')}</h2>
        <p className="text-sm text-gray-500 mb-4">
          {t('On. Signing in also asks for a code we send to your email address.')}
          {step.required && ` ${t('This service requires it, so it stays on.')}`}
        </p>
        {!step.required && (
          <button type="button" className="text-sm text-red-600 underline" onClick={() => { reset(); setStep({ name: 'turning-off', required: false }); }}>
            {t('Turn off')}
          </button>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={turnOff} className={card}>
      <h2 className="font-medium text-gray-900 mb-3">{t('Code by email')}</h2>
      <input type="password" placeholder={t('Your password')} autoComplete="current-password" autoFocus
        value={password} onChange={e => setPassword(e.target.value)} className={inputClass} />
      {error && <Notice kind="error">{error}</Notice>}
      <button type="submit" className={secondaryButtonClass}>{t('Turn off')}</button>
      <button type="button" className="mt-2 text-sm text-gray-500 underline" onClick={() => { reset(); refresh(); }}>{t('Cancel')}</button>
    </form>
  );
}
