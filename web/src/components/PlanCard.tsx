import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { formatBytes, useBilling } from '../billing';
import { useI18n } from '../i18n';
import { buttonClass, Notice } from './AuthCard';

/** The account's plan: what it is, what has been used, and the ways to change it. Shows nothing on an instance with no plans. */
export default function PlanCard() {
  const { t } = useI18n();
  const billing = useBilling();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!billing?.enabled || !billing.plan) return null;

  const day = (iso: string) => new Date(iso).toLocaleDateString();
  const go = async (start: () => Promise<{ url: string }>) => {
    setError('');
    setBusy(true);
    try {
      // The provider's page, not ours: the card is typed there, and nothing of it ever reaches this server.
      window.location.assign((await start()).url);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not open the payment page'));
      setBusy(false);
    }
  };

  const { plan, subscription, ai, vault, shares, prices, founding_left: foundingLeft } = billing;
  const sub = subscription;
  const name = plan === 'premium' ? t('Premium') : plan === 'trial' ? t('Free trial') : t('Free');
  const money = (n: number) => `€${n}`;

  return (
    <section className="bg-white border border-gray-200 rounded-xl p-5 mt-6">
      <h2 className="font-medium text-gray-900 mb-1">{t('Your plan')}: {name}</h2>
      {plan === 'trial' && billing.trial_ends_at && <p className="text-sm text-gray-500 mb-3">{t('Everything is included until {when}. After that you keep the free plan unless you upgrade.', { when: day(billing.trial_ends_at) })}</p>}
      {plan === 'free' && <p className="text-sm text-gray-500 mb-3">{t('The free plan keeps your records, the timeline, search, export and one share link. Translation, questions, connections and approving visitors are part of Premium.')}</p>}
      {sub && (
        <p className="text-sm text-gray-500 mb-3">
          {sub.provider === 'operator'
            ? t('Granted to your account until {when}.', { when: day(sub.ends_at ?? '') })
            : sub.ends_at
              ? t('Your subscription ends on {when}; you keep Premium until then.', { when: day(sub.ends_at) })
              : t('Renews on {when}.', { when: sub.renews_at ? day(sub.renews_at) : '' })}
          {sub.founding && ` ${t('Founding member price, kept for as long as you stay subscribed.')}`}
        </p>
      )}

      <ul className="text-sm text-gray-700 space-y-1 mb-4">
        {ai && <li>{t('AI reading: {used} of {allowance} pages', { used: ai.used, allowance: ai.allowance })} {ai.period === 'month' ? t('this month') : t('in the trial')}</li>}
        {vault && <li>{t('Storage: {used} of {limit}', { used: formatBytes(vault.used_bytes), limit: formatBytes(vault.limit_bytes) })}</li>}
        {shares && <li>{t('Share links: {live} live of {limit}', { live: shares.live, limit: shares.limit })}</li>}
      </ul>

      {error && <Notice kind="error">{error}</Notice>}
      {plan !== 'premium' && prices && (
        <div className="space-y-2">
          <button disabled={busy} onClick={() => go(() => api.billing.checkout('year'))} className={buttonClass}>
            {foundingLeft ? t('Premium for {price} a year (founding price)', { price: money(prices.founding.year) }) : t('Premium for {price} a year', { price: money(prices.premium.year) })}
          </button>
          <button disabled={busy} onClick={() => go(() => api.billing.checkout('month'))} className="text-sm text-brand-600 hover:underline">
            {t('or {price} a month', { price: money(prices.premium.month) })}
          </button>
          <p className="text-xs text-gray-500">{t('Renews until you cancel, and you can cancel at any time. In the first 14 days you can have your money back.')} <Link to="/pricing" className="underline">{t('What is included')}</Link></p>
        </div>
      )}
      {billing.can_manage && <button disabled={busy} onClick={() => go(() => api.billing.portal())} className="text-sm text-brand-600 hover:underline">{t('Manage billing, invoices and cancellation')}</button>}
    </section>
  );
}
