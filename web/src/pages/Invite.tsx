import { useEffect } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { Wordmark } from '../components/Logo';
import { keepInvite } from '../invite';
import { useI18n } from '../i18n';

/**
 * Where a link to an invitation lands (`/invite#<code>`): the code is taken out of the address and kept for this tab, and the person is
 * sent on to sign in or make an account (counted as coming from an invitation) or, if already signed in, to the page where it is used.
 */
export default function Invite() {
  const { t } = useI18n();
  const { authenticated } = useAuth();
  const code = window.location.hash.replace(/^#/, '');
  useEffect(() => {
    if (/^[A-Za-z0-9-]{18,30}$/.test(code)) {
      keepInvite(code);
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, [code]);
  if (authenticated) return <Navigate to="/profiles" replace />;
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-md mx-auto px-4 py-8">
        <Link to="/" aria-label={t('Spine, home')} className="inline-block mb-6"><Wordmark /></Link>
        <article className="bg-white border border-gray-200 rounded-xl p-6 space-y-4 text-sm text-gray-700">
          <h1 className="text-xl font-semibold text-gray-900">{t('You have been invited')}</h1>
          <p>{t('Someone has let you open the records of a person they look after. Sign in, or make an account, and you will be offered to join.')}</p>
          <p className="flex gap-4">
            <Link to="/login" className="text-brand-600 hover:underline">{t('Sign in')}</Link>
            <Link to="/register?ref=invite" className="text-brand-600 hover:underline">{t('Create an account')}</Link>
          </p>
        </article>
      </div>
    </div>
  );
}
