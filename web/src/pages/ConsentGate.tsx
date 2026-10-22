import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import AuthCard, { buttonClass, inputClass, Notice } from '../components/AuthCard';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';

/**
 * What an account sees until it has agreed to the current texts: an operator-made account on its first sign-in, and everyone when a
 * text changes. Two separate boxes, because agreeing to the terms is not consent to the use of health data (GDPR Art. 9(2)(a)); and
 * a way out, because declining has to mean something.
 */
export default function ConsentGate({ need, done }: { need: { health: boolean; terms: boolean }; done: () => void }) {
  const { t } = useI18n();
  const { email, setAuthenticated } = useAuth();
  const [health, setHealth] = useState(!need.health);
  const [terms, setTerms] = useState(!need.terms);
  const [error, setError] = useState('');
  const [leaving, setLeaving] = useState(false);
  const [confirm, setConfirm] = useState('');

  const agree = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try { await api.account.consent(need.health ? health : true, need.terms ? terms : true); done(); } catch (err) { setError(err instanceof Error ? err.message : t('Something went wrong. Try again.')); }
  };
  const leave = async () => {
    setError('');
    try {
      await api.account.remove(confirm);
      setAuthenticated(false);
    } catch (err) { setError(err instanceof Error ? err.message : t('Something went wrong. Try again.')); }
  };
  const signOut = async () => { await api.auth.logout(); setAuthenticated(false); };

  return (
    <AuthCard title={t('Before you start')} footer={<button type="button" onClick={signOut} className="text-blue-600">{t('Sign out')}</button>}>
      <p className="text-sm text-gray-600 mb-4">{t('Spine keeps health records. Two things need your agreement, separately, before you use it.')}</p>
      <form onSubmit={agree} className="space-y-3">
        {need.health && (
          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={health} onChange={e => setHealth(e.target.checked)} className="mt-1" />
            <span>{t('I consent to Spine processing the health data I upload, as the privacy notice describes. I can withdraw this at any time by deleting my account.')} <Link to="/privacy" target="_blank" className="text-blue-600 hover:underline">{t('Privacy notice')}</Link></span>
          </label>
        )}
        {need.terms && (
          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={terms} onChange={e => setTerms(e.target.checked)} className="mt-1" />
            <span>{t('I accept the terms of use.')} <Link to="/terms" target="_blank" className="text-blue-600 hover:underline">{t('Terms of use')}</Link> · <Link to="/purpose" target="_blank" className="text-blue-600 hover:underline">{t('What Spine is for')}</Link></span>
          </label>
        )}
        {error && <Notice kind="error">{error}</Notice>}
        <button type="submit" disabled={!health || !terms} className={`${buttonClass} disabled:opacity-50`}>{t('Agree and continue')}</button>
      </form>

      <div className="mt-6 border-t border-gray-100 pt-4 text-sm">
        {!leaving ? (
          <button type="button" onClick={() => setLeaving(true)} className="text-gray-500 hover:underline">{t('I do not agree: delete my account')}</button>
        ) : (
          <div className="space-y-2">
            <p className="text-gray-600">{t('This deletes the account {email} and everything in it, at once. Type the address to confirm.', { email })}</p>
            <input value={confirm} onChange={e => setConfirm(e.target.value)} placeholder={email} aria-label={t('Email')} className={inputClass} />
            <button type="button" onClick={leave} disabled={confirm.trim().toLowerCase() !== email.toLowerCase()} className="text-red-700 hover:underline disabled:opacity-50">{t('Delete my account')}</button>
          </div>
        )}
      </div>
    </AuthCard>
  );
}
