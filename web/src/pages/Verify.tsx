import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { takeTokenFromUrl } from '../auth';
import AuthCard, { Notice } from '../components/AuthCard';
import { useI18n } from '../i18n';

export default function Verify() {
  const { t } = useI18n();
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const [error, setError] = useState('');
  // React's StrictMode runs effects twice in development; the link works once, so
  // the second run would turn a success into "invalid link".
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const token = takeTokenFromUrl();
    if (!token) {
      setError(t('This link is incomplete.'));
      return setState('failed');
    }
    api.auth.verify(token)
      .then(() => setState('done'))
      .catch(err => { setError(err instanceof Error ? err.message : t('Could not confirm')); setState('failed'); });
  }, []);

  return (
    <AuthCard title={t('Confirm your email')} footer={<p><Link to="/login" className="text-brand-600">{t('Go to sign in')}</Link></p>}>
      {state === 'working' && <p className="text-gray-500">{t('Confirming…')}</p>}
      {state === 'done' && <Notice kind="ok">{t('Your address is confirmed. You can sign in now.')}</Notice>}
      {state === 'failed' && <Notice kind="error">{error} {t('Sign in to request a new link.')}</Notice>}
    </AuthCard>
  );
}
