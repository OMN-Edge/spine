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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== again) return setError(t('The two passwords do not match'));
    try {
      setDone((await api.auth.register(email, password)).message);
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
          {error && <Notice kind="error">{error}</Notice>}
          <button type="submit" className={buttonClass}>{t('Create account')}</button>
        </form>
      )}
    </AuthCard>
  );
}
