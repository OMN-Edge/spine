import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import AuthCard, { buttonClass, inputClass, Notice } from '../components/AuthCard';
import { useI18n } from '../i18n';

export default function Forgot() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      setDone((await api.auth.forgot(email)).message);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not send the link'));
    }
  };

  return (
    <AuthCard title={t('Reset your password')} footer={<p><Link to="/login" className="text-brand-600">{t('Back to sign in')}</Link></p>}>
      {done ? (
        <Notice kind="ok">{done}</Notice>
      ) : (
        <form onSubmit={submit}>
          <input type="email" placeholder={t('Email')} autoComplete="username" autoFocus
            value={email} onChange={e => setEmail(e.target.value)} className={inputClass} />
          {error && <Notice kind="error">{error}</Notice>}
          <button type="submit" className={buttonClass}>{t('Send a link')}</button>
        </form>
      )}
    </AuthCard>
  );
}
