import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { buttonClass, inputClass, Notice } from '../components/AuthCard';
import TwoFactor from '../components/TwoFactor';
import Sessions from '../components/Sessions';
import YourData from '../components/YourData';
import AdminAccounts from '../components/AdminAccounts';
import PlanCard from '../components/PlanCard';
import Passkeys from '../components/Passkeys';
import AddDevice from '../components/AddDevice';
import RecoveryKitSettings from '../components/RecoveryKitSettings';
import EmailRecovery from '../components/EmailRecovery';
import { checkPasswordPolicy } from '../crypto/password-policy';
import { useI18n } from '../i18n';

export default function Account() {
  const { t } = useI18n();
  const { email } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setDone(false);
    if (next !== again) return setError(t('The two new passwords do not match'));
    const problem = checkPasswordPolicy(next, { email });
    if (problem) return setError(problem === 'short' ? t('The password must be at least 12 characters.') : problem === 'long' ? t('The password is too long.') : t('That password is too easy to guess: use a longer phrase that is not a common word, a pattern or part of your address.'));
    try {
      await api.auth.changePassword(current, next);
      setDone(true);
      setCurrent(''); setNext(''); setAgain('');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not change the password'));
    }
  };

  // Four groups, each a heading of its own, with an index beside them on a wide screen: the page was eight cards in one column.
  const groups = [
    { id: 'plan', label: t('Plan and people') },
    { id: 'security', label: t('Sign-in and security') },
    { id: 'devices', label: t('Devices') },
    { id: 'data', label: t('Data and privacy') },
  ];
  // Each card below keeps its own top margin, so a heading has none below it.
  const heading = 'text-xs font-medium uppercase tracking-wide text-gray-500 mt-10 scroll-mt-6';

  return (
    <div className="max-w-4xl mx-auto lg:grid lg:grid-cols-[11rem_minmax(0,28rem)] lg:gap-10 lg:justify-center">
      <nav aria-label={t('Account')} className="hidden lg:block">
        <ul className="sticky top-6 space-y-1 text-sm">
          {groups.map(g => <li key={g.id}><a href={`#${g.id}`} className="block rounded-lg px-3 py-1.5 text-gray-600 hover:bg-white hover:text-gray-900">{g.label}</a></li>)}
        </ul>
      </nav>

      <div className="max-w-md mx-auto w-full lg:max-w-none">
        <h1 className="text-[1.75rem] leading-tight font-light tracking-tight text-gray-900 mb-1">{t('Account')}</h1>
        <p className="text-sm text-gray-500 mb-6">{email}</p>

        <h2 id="plan" className={`${heading} !mt-0`}>{t('Plan and people')}</h2>
        <PlanCard />
        <section className="bg-white border border-gray-200 rounded-xl p-5 mt-6">
          <h3 className="font-medium text-gray-900 mb-1">{t('People')}</h3>
          <p className="text-sm text-gray-500 mb-3">{t('Keep the records of someone you look after, such as a child or a parent, apart from your own.')}</p>
          <Link to="/profiles" className="text-sm text-brand-600 hover:underline">{t('See and add people')}</Link>
        </section>

        <h2 id="security" className={heading}>{t('Sign-in and security')}</h2>
        <form onSubmit={submit} className="bg-white border border-gray-200 rounded-xl p-5 mt-6">
          <h3 className="font-medium text-gray-900 mb-1">{t('Change your master password')}</h3>
          <p className="text-sm text-gray-500 mb-4">{t('The one you sign in with and that opens your records.')}</p>
          <input type="password" placeholder={t('Current password')} autoComplete="current-password"
            value={current} onChange={e => setCurrent(e.target.value)} className={inputClass} />
          <input type="password" placeholder={t('New password (at least 12 characters)')} autoComplete="new-password"
            value={next} onChange={e => setNext(e.target.value)} className={inputClass} />
          <input type="password" placeholder={t('New password again')} autoComplete="new-password"
            value={again} onChange={e => setAgain(e.target.value)} className={inputClass} />
          {error && <Notice kind="error">{error}</Notice>}
          {done && <Notice kind="ok">{t('Password changed. Your other sessions have been signed out.')}</Notice>}
          <button type="submit" className={buttonClass}>{t('Change password')}</button>
        </form>
        <TwoFactor />
        <Passkeys />
        <RecoveryKitSettings />
        <EmailRecovery />

        <h2 id="devices" className={heading}>{t('Devices')}</h2>
        <AddDevice />
        <Sessions />
        <AdminAccounts />

        <h2 id="data" className={heading}>{t('Data and privacy')}</h2>
        <YourData />
      </div>
    </div>
  );
}
