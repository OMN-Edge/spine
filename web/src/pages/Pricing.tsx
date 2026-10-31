import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Pricing as PricingData } from '../api';
import { Wordmark } from '../components/Logo';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';

/**
 * What the plans are and cost, read before an account exists (CR-PAY-01: the price, the renewal and how to cancel are shown before any
 * purchase). The amounts come from the server, which takes them from `billing/plans.ts`, so the page and the checkout cannot disagree about
 * what is on offer. On an instance with no plans (self-hosted, private) it says so.
 */
export default function Pricing() {
  const { t } = useI18n();
  const { authenticated } = useAuth();
  const [pricing, setPricing] = useState<PricingData | null>(null);
  useEffect(() => { api.billing.pricing().then(setPricing).catch(() => setPricing({ enabled: false })); }, []);
  const prices = pricing?.prices;
  const money = (n: number) => `€${n}`;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8">
        <Link to="/" aria-label={t('Spine, home')} className="inline-block mb-6"><Wordmark /></Link>
        <article className="bg-white border border-gray-200 rounded-xl p-6 space-y-4 text-sm text-gray-700 leading-relaxed">
          <h1 className="text-xl font-semibold text-gray-900">{t('Plans and prices')}</h1>
          {pricing && !pricing.enabled && <p>{t('This Spine has no paid plans. Everything in it is available to the people who have an account.')}</p>}
          {pricing?.enabled && prices && (
            <>
              <p>{t('Every new account starts with six months of everything, including 150 pages of AI reading. After that you keep the free plan, or you choose Premium.')}</p>

              <h2 className="text-base font-semibold text-gray-900 pt-2">{t('Free')} · {money(0)}</h2>
              <ul className="list-disc pl-5 space-y-1">
                <li>{t('Your records, the timeline, search on your device, export and the emergency card')}</li>
                <li>{t('1 GB of storage')}</li>
                <li>{t('One live share link, without translation')}</li>
                <li>{t('About 30 pages of AI reading a month')}</li>
              </ul>

              <h2 className="text-base font-semibold text-gray-900 pt-2">{t('Premium')} · {t('{year} a year or {month} a month', { year: money(prices.premium.year), month: money(prices.premium.month) })}</h2>
              <ul className="list-disc pl-5 space-y-1">
                <li>{t('AI reading without a monthly limit, within fair use')}</li>
                <li>{t('Translation of your documents and of what a doctor opens')}</li>
                <li>{t('Questions about your records, connections between documents, and related documents')}</li>
                <li>{t('Any number of share links, and approving visitors before they see one')}</li>
              </ul>

              {pricing.family && (
                <>
                  <h2 className="text-base font-semibold text-gray-900 pt-2">{t('Family')} · {t('{year} a year or {month} a month', { year: money(prices.family.year), month: money(prices.family.month) })}</h2>
                  <ul className="list-disc pl-5 space-y-1">
                    <li>{t('Everything in Premium, for up to six people')}</li>
                    <li>{t('Records for children, kept by their guardians, with other guardians let in')}</li>
                    <li>{t('A teenager from sixteen can have an account of their own, and at eighteen the records can become theirs')}</li>
                  </ul>
                </>
              )}

              {pricing.founding_left ? (
                <p className="rounded-lg bg-gray-50 border border-gray-200 p-3">
                  {t('The first 500 paying members pay {price} a year, kept for as long as they stay subscribed. {left} places are left.', { price: money(prices.founding.year), left: pricing.founding_left })}
                </p>
              ) : null}

              <h2 className="text-base font-semibold text-gray-900 pt-2">{t('How paying works')}</h2>
              <ul className="list-disc pl-5 space-y-1">
                <li>{t('A subscription renews every month or every year until you cancel. You cancel from your account, on the payment provider’s page, and keep Premium until the end of what you paid for.')}</li>
                <li>{t('In the first 14 days you can have your money back.')}</li>
                <li>{t('Paddle sells Premium to you: it takes the payment, sends the invoice and adds any tax, which you see before you pay. Spine never sees your card, only which plan you have.')}</li>
                <li>{t('Spine is open-source software. Running your own copy is free, and has no plans.')}</li>
              </ul>
              <p>
                {authenticated
                  ? <Link to="/account" className="text-brand-600 hover:underline">{t('Choose a plan on your account page')}</Link>
                  : <Link to="/register" className="text-brand-600 hover:underline">{t('Create an account')}</Link>}
              </p>
            </>
          )}
        </article>
        <nav className="mt-4 flex gap-4 text-xs text-gray-500" aria-label={t('Legal')}>
          <Link to="/privacy" className="hover:underline">{t('Privacy notice')}</Link>
          <Link to="/terms" className="hover:underline">{t('Terms of use')}</Link>
        </nav>
      </div>
    </div>
  );
}
