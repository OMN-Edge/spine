import { useCallback, useEffect, useState } from 'react';
import { api, type FamilyView } from '../api';
import { planChanged } from '../billing';
import { seatLink, pendingSeatInvite, forgetSeatInvite } from '../seat';
import { useI18n } from '../i18n';
import { buttonClass, Notice } from './AuthCard';

/**
 * The accounts that share one plan (SECURITY.md M-52): for the account that pays, who holds the seats and the way to invite another; for
 * one that holds a seat, whose plan it is and the way to give it up; and, for either, an invitation waiting to be taken. Shows nothing on an
 * instance with no plans or for an account with nothing to share and nothing offered.
 */
export default function SeatsCard() {
  const { t } = useI18n();
  const [view, setView] = useState<FamilyView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const [offer, setOffer] = useState<{ organizer_email: string; cooldown_days: number } | null>(null);
  const [offerError, setOfferError] = useState('');
  const [offered, setOffered] = useState(() => pendingSeatInvite());

  const load = useCallback(() => api.family.get().then(setView).catch(() => setView({ enabled: false })), []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!offered) { setOffer(null); return; }
    let live = true;
    api.family.preview(offered.id, offered.secret)
      .then(v => live && setOffer(v))
      .catch(err => { if (live) { setOfferError(err instanceof Error ? err.message : t('This invitation is not valid')); forgetSeatInvite(); } });
    return () => { live = false; };
  }, [offered, t]);

  const run = async (work: () => Promise<unknown>) => {
    setError('');
    setBusy(true);
    try { await work(); await load(); planChanged(); } catch (err) { setError(err instanceof Error ? err.message : t('That did not work')); } finally { setBusy(false); }
  };
  const take = () => run(async () => {
    if (!offered) return;
    await api.family.join(offered.id, offered.secret);
    forgetSeatInvite();
    setOffered(null);
  });
  const decline = () => { forgetSeatInvite(); setOffered(null); setOfferError(''); };

  if (!view?.enabled) return null;
  if (view.role === 'none' && !offered && !offerError) return null;
  const day = (iso: string) => new Date(iso).toLocaleDateString();

  return (
    <section id="shared" className="bg-white border border-gray-200 rounded-xl p-5 mt-6 scroll-mt-6">
      <h3 className="font-medium text-gray-900 mb-1">{t('Shared plan')}</h3>
      {error && <Notice kind="error">{error}</Notice>}

      {offerError && <Notice kind="error">{offerError}</Notice>}
      {offered && offer && (
        <div className="rounded-lg bg-brand-50 border border-brand-100 p-3 mb-3 text-sm text-brand-900 space-y-2">
          <p>{t('{email} has offered you a seat in their plan.', { email: offer.organizer_email })}</p>
          <p>{t('You would have the features of their plan and share its AI reading. They would see that you hold a seat and how many people the plan has, and nothing you keep.')}</p>
          <p>{t('If you give the seat up, or it is ended, you can take a seat in another plan only after {days} days.', { days: offer.cooldown_days })}</p>
          <div className="flex gap-3 items-center">
            <button disabled={busy} onClick={() => void take()} className={buttonClass}>{t('Take the seat')}</button>
            <button disabled={busy} onClick={decline} className="text-sm underline">{t('Not now')}</button>
          </div>
        </div>
      )}

      {view.role === 'member' && (
        <>
          <p className="text-sm text-gray-500 mb-3">{t('You hold a seat in the plan of {email}.', { email: view.organizer_email })}</p>
          <ul className="text-sm text-gray-700 space-y-1 mb-3">
            <li>{t('People in the plan: {used} of {limit}', { used: view.profiles.used, limit: view.profiles.limit })}</li>
          </ul>
          {asking === 'leave' ? (
            <div className="text-sm space-y-2">
              <p>{t('Give up the seat? Your records stay with you and your account goes back to its own plan. You can take a seat in another plan only after {days} days.', { days: view.cooldown_days })}</p>
              <button disabled={busy} onClick={() => void run(async () => { await api.family.leave(); setAsking(null); })} className={buttonClass}>{t('Yes, give it up')}</button>
              <button onClick={() => setAsking(null)} className="ml-3 underline">{t('No')}</button>
            </div>
          ) : (
            <button onClick={() => setAsking('leave')} className="text-sm text-brand-600 hover:underline">{t('Give up this seat')}</button>
          )}
        </>
      )}

      {view.role === 'organizer' && (
        <>
          <p className="text-sm text-gray-500 mb-3">{t('Other accounts can hold a seat in your plan. They have its features and share its AI reading. A seat gives you no access to what they keep: to see a person’s records, they let you into that person.')}</p>
          <ul className="text-sm text-gray-700 space-y-1 mb-3">
            <li>{t('Seats: {used} of {limit}', { used: view.seats.used, limit: view.seats.limit })}</li>
            <li>{t('People in the plan: {used} of {limit}', { used: view.profiles.used, limit: view.profiles.limit })}</li>
          </ul>
          {view.members.length > 0 && (
            <ul className="divide-y divide-gray-100 border border-gray-100 rounded-lg mb-3">
              {view.members.map(m => (
                <li key={m.id} className="p-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate">{m.email} <span className="text-gray-400">· {day(m.joined_at)}</span></span>
                    {asking !== m.id && <button onClick={() => setAsking(m.id)} className="shrink-0 text-xs text-brand-600 hover:underline">{t('Remove')}</button>}
                  </div>
                  {asking === m.id && (
                    <p className="mt-2 text-xs text-gray-600">
                      {t('Their records stay with them.')}{' '}
                      <button disabled={busy} onClick={() => void run(async () => { await api.family.remove(m.id); setAsking(null); })} className="underline">{t('Yes, remove')}</button>{' '}
                      <button onClick={() => setAsking(null)} className="underline">{t('No')}</button>
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
          {view.invites.length > 0 && (
            <ul className="text-sm text-gray-600 space-y-1 mb-3">
              {view.invites.map(i => (
                <li key={i.id} className="flex items-center justify-between gap-2">
                  <span>{t('An invitation waits until {when}', { when: day(i.expires_at) })}</span>
                  <button disabled={busy} onClick={() => void run(() => api.family.cancelInvite(i.id))} className="text-xs text-brand-600 hover:underline">{t('Cancel')}</button>
                </li>
              ))}
            </ul>
          )}
          {link && (
            <div className="rounded-lg bg-gray-50 border border-gray-200 p-3 mb-3 text-sm space-y-2">
              <p>{t('Send this link to the person. It is shown only now, works once, and lasts {days} days: whoever opens it first, signed in, takes the seat.', { days: view.invite_days })}</p>
              <input readOnly value={link} onFocus={e => e.currentTarget.select()} className="w-full text-xs font-mono border border-gray-200 rounded px-2 py-1 bg-white" />
              <button onClick={() => { void navigator.clipboard?.writeText(link).then(() => setCopied(true)).catch(() => undefined); }} className="text-sm text-brand-600 hover:underline">{copied ? t('Copied') : t('Copy the link')}</button>
            </div>
          )}
          {view.seats.used < view.seats.limit
            ? <button disabled={busy} onClick={() => void run(async () => { const made = await api.family.invite(); setLink(seatLink(window.location.origin, made.id, made.secret)); setCopied(false); })} className={buttonClass}>{t('Invite an account')}</button>
            : <p className="text-sm text-gray-500">{t('Every seat is taken.')}</p>}
        </>
      )}
    </section>
  );
}
