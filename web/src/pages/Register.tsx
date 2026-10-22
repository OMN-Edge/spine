import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import AuthCard, { buttonClass, inputClass, Notice } from '../components/AuthCard';
import { useI18n } from '../i18n';

export default function Register() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  // Two separate acts: consent to the use of health data is not the same as accepting the terms (GDPR Art. 9(2)(a)).
  const [health, setHealth] = useState(false);
  const [terms, setTerms] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== again) return setError(t('The two passwords do not match'));
    if (!health || !terms) return setError(t('Both boxes below need to be ticked.'));
    try {
      setDone((await api.auth.register(email, password, { health_data: health, terms })).message);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not create the account'));
    }
  };

  return (
    <AuthCard title={t('Create an account')} footer={<p><Link to="/login" className="text-blue-600">{t('Back to sign in')}</Link></p>}>
      {done ? (
        <Notice kind="ok">{done}</Notice>
      ) : (
        <form onSubmit={submit}>
          <input type="email" placeholder={t('Email')} autoComplete="username" autoFocus
            value={email} onChange={e => setEmail(e.target.value)} className={inputClass} />
          <input type="password" placeholder={t('Password (at least 12 characters)')} autoComplete="new-password"
            value={password} onChange={e => setPassword(e.target.value)} className={inputClass} />
          <input type="password" placeholder={t('Password again')} autoComplete="new-password"
            value={again} onChange={e => setAgain(e.target.value)} className={inputClass} />
          <label className="flex items-start gap-2 text-sm text-gray-700 mb-2">
            <input type="checkbox" checked={health} onChange={e => setHealth(e.target.checked)} className="mt-1" />
            <span>{t('I consent to Spine processing the health data I upload, as the privacy notice describes. I can withdraw this at any time by deleting my account.')} <Link to="/privacy" target="_blank" className="text-blue-600 hover:underline">{t('Privacy notice')}</Link></span>
          </label>
          <label className="flex items-start gap-2 text-sm text-gray-700 mb-3">
            <input type="checkbox" checked={terms} onChange={e => setTerms(e.target.checked)} className="mt-1" />
            <span>{t('I accept the terms of use.')} <Link to="/terms" target="_blank" className="text-blue-600 hover:underline">{t('Terms of use')}</Link> · <Link to="/purpose" target="_blank" className="text-blue-600 hover:underline">{t('What Spine is for')}</Link></span>
          </label>
          {error && <Notice kind="error">{error}</Notice>}
          <button type="submit" className={buttonClass}>{t('Create account')}</button>
        </form>
      )}
    </AuthCard>
  );
}
