import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BillingDetails } from 'spine-core/billing/billing-details';
import { api, ApiError } from '../api';
import { planChanged, useBilling } from '../billing';
import { useI18n } from '../i18n';
import { useFormat } from '../format';
import { buttonClass, Notice } from './AuthCard';
import ArchiveProgress from './ArchiveProgress';
import BillingDetailsForm from './BillingDetailsForm';
import InviteLink from './InviteLink';
import InvoiceList, { type InvoiceRow } from './InvoiceList';
import { offerPlans, trialDaysLeft } from '../plan-offer';
import { extraPages, importLeft } from '../reading-estimate';

/** How many invoices the plan card lists; the rest are on their own page. */
const RECENT_INVOICES = 5;

/** The account's plan: what it is, what has been used, and the ways to change it. Shows nothing on an instance with no plans. */
export default function PlanCard() {
  const { t, tn } = useI18n();
  const format = useFormat();
  const billing = useBilling();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // The billing details, asked for before a purchase where the operator issues the invoices (and the purchase to go on with once they are kept), or to change them.
  // The account's invoices (where the operator issues them), and the confirmation of a withdrawal from the purchase.
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [invoiceTotal, setInvoiceTotal] = useState(0);
  const [withdrawing, setWithdrawing] = useState(false);
  const [asking, setAsking] = useState<{ start: (() => Promise<{ url: string }>) | null; initial: BillingDetails | null } | null>(null);
  // The card, the cancelling and the invoices are on the provider's page, and the person comes back from it by the browser's way back or another tab: what the
  // plan says is read again then, since it is the provider's message to this server (not the person's return) that changes it.
  useEffect(() => {
    const back = () => { if (document.visibilityState === 'visible') planChanged(); };
    const shown = (e: PageTransitionEvent) => { if (e.persisted) planChanged(); };
    document.addEventListener('visibilitychange', back);
    window.addEventListener('pageshow', shown);
    return () => { document.removeEventListener('visibilitychange', back); window.removeEventListener('pageshow', shown); };
  }, []);
  const hasInvoices = !!billing?.billing_details;
  useEffect(() => { if (hasInvoices) api.billing.invoices(1, RECENT_INVOICES).then(r => { setInvoices(r.invoices); setInvoiceTotal(r.total); }).catch(() => undefined); }, [hasInvoices]);
  if (!billing?.enabled || !billing.plan) return null;

  const day = (iso: string) => format.date(iso);
  const go = async (start: () => Promise<{ url: string }>) => {
    setError('');
    setBusy(true);
    try {
      // The provider's page, not ours: the card is typed there, and nothing of it ever reaches this server.
      window.location.assign((await start()).url);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'billing_details_required') {
        const initial = await api.billing.details().then(r => r.details).catch(() => null);
        setAsking({ start, initial });
        setBusy(false);
        return;
      }
      setError(err instanceof Error ? err.message : t('Could not open the payment page'));
      setBusy(false);
    }
  };
  const withdraw = async () => {
    setError('');
    setBusy(true);
    try { await api.billing.withdraw(); setWithdrawing(false); planChanged(); } catch (err) { setError(err instanceof Error ? err.message : t('Could not send the withdrawal request')); }
    setBusy(false);
  };
  const changeDetails = async () => {
    setError('');
    setAsking({ start: null, initial: await api.billing.details().then(r => r.details).catch(() => null) });
  };

  const { plan, subscription, ai, vault, shares, prices, founding_left: foundingLeft, family } = billing;
  const sub = subscription;
  const name = plan === 'family' ? t('Family') : plan === 'premium' ? t('Premium') : plan === 'essential' ? t('Essential') : plan === 'trial' ? t('Free trial') : t('Free');
  // The amounts are Stripe's, in the currency of its prices; where it cannot say what they are, nothing is offered for sale.
  const money = (n: number) => format.amount(n, prices?.currency ?? 'EUR');
  const paid = plan === 'essential' || plan === 'premium' || plan === 'family';
  // The trial's questions and translated pages are totals for the whole trial, shown from the first day.
  const chat = ai?.chat.allowance != null ? ai.chat : null;
  const translation = ai?.translation.allowance != null ? ai.translation : null;
  const trialUsedUp = (!!chat && chat.used >= chat.allowance!) || (!!translation && translation.used >= translation.allowance!) || (!!ai && ai.reading.allowance !== null && plan === 'trial' && ai.reading.used >= ai.reading.allowance);
  // Only adding has an allowance (the pages read); using is not limited, so questions, translation and link traffic are not shown here (the "Your archive" section says what was done).
  const bar = (used: number, of: number) => (
    <span className="block h-1.5 mt-1 rounded bg-gray-200" role="presentation"><span className="block h-1.5 rounded bg-brand-500" style={{ width: `${of > 0 ? Math.min(100, Math.max(1.5, Math.round((used / of) * 100))) : 0}%` }} /></span>
  );
  const r = ai?.reading;
  const reading = {
    left: r && r.allowance !== null ? Math.max(0, r.allowance - r.used) : 0,
    nearly: !!r && r.allowance !== null && r.allowance > 0 && Math.max(r.used / r.allowance, r.own_cap ? (r.own_used ?? 0) / r.own_cap : 0) >= 0.8,
    ownNearly: !!r && !!r.own_cap && (r.own_used ?? 0) / r.own_cap >= 0.8,
  };
  // The trial's own totals, each as a share used: the plans are offered late in the trial or when one is nearly used (`plan-offer.ts`).
  const shares_ = [r && r.allowance !== null && r.allowance > 0 ? r.used / r.allowance : 0, chat ? chat.used / chat.allowance! : 0, translation ? translation.used / translation.allowance! : 0];
  const offer = offerPlans({ plan, trialEndsAt: billing.trial_ends_at, used: plan === 'trial' ? shares_ : [] });
  if (asking) {
    return (
      <section className="bg-white border border-gray-200 rounded-xl p-5 mt-6">
        <BillingDetailsForm initial={asking.initial} onCancel={() => setAsking(null)} onSaved={() => { const next = asking.start; setAsking(null); if (next) void go(next); }} />
      </section>
    );
  }
  return (
    <section className="bg-white border border-gray-200 rounded-xl p-5 mt-6">
      <h2 className="font-medium text-gray-900 mb-1">{t('Your plan')}: {name}</h2>
      {plan === 'trial' && billing.trial_ends_at && <p className="text-sm text-gray-500 mb-1">{tn(trialDaysLeft(billing.trial_ends_at), 'Your trial: {n} day left.', 'Your trial: {n} days left.')}</p>}
      {plan === 'trial' && billing.trial_ends_at && <p className="text-sm text-gray-500 mb-3">{t('Everything is included until {when}, up to the totals below. After that your archive stays visible and you can export it, and you keep the free plan unless you upgrade.', { when: day(billing.trial_ends_at) })}</p>}
      {plan === 'free' && <p className="text-sm text-gray-500 mb-3">{t('The free plan keeps your records, the timeline, search, export, the emergency card and one share link. Questions, connections and approving visitors are part of Essential and Premium, and translation of Premium.')}</p>}
      {sub && (
        <p className="text-sm text-gray-500 mb-3">
          {sub.provider === 'operator'
            ? t('Granted to your account until {when}.', { when: day(sub.ends_at ?? '') })
            : sub.ends_at
              ? t('Your subscription ends on {when}; you keep {plan} until then.', { when: day(sub.ends_at), plan: name })
              : t('Renews on {when}.', { when: sub.renews_at ? day(sub.renews_at) : '' })}
          {sub.founding && ` ${t('Founding member price, kept for as long as you stay subscribed.')}`}
        </p>
      )}
      {sub?.status === 'past_due' && <p className="text-sm text-amber-700 mb-3">{t('Your last payment did not go through. Your plan continues for a few days while it is tried again; update your payment method to keep it.')}</p>}

      <ul className="text-sm text-gray-700 space-y-3 mb-4">
        {ai && ai.reading.allowance !== null && (
          <li className={reading.nearly ? 'text-amber-700' : undefined}>
            {ai.reading.own_cap !== undefined
              ? t('Shared with your household: you can add {left} pages {when}', { left: reading.left, when: ai.period === 'month' ? t('this month') : t('in the trial') })
              : t('You can add {left} pages {when}', { left: reading.left, when: ai.period === 'month' ? t('this month') : t('in the trial') })}
            {ai.reading.own_cap !== undefined && reading.ownNearly && ` · ${t('your part: {left} of {cap} left', { left: Math.max(0, ai.reading.own_cap - (ai.reading.own_used ?? 0)), cap: ai.reading.own_cap })}`}
            {ai.reading.monthly !== undefined && <span className="block text-xs text-gray-500">{t('{n} more every month; what you do not use is kept for up to three months.', { n: ai.reading.monthly })}</span>}
            {reading.nearly && <span className="block text-xs">{t('You can add more next month, or upgrade.')}</span>}
            {bar(ai.reading.used, ai.reading.allowance)}
          </li>
        )}
        {chat && <li className={chat.used >= chat.allowance! ? 'text-amber-700' : undefined}>{t('Questions in the trial: {used} of {allowance}', { used: chat.used, allowance: chat.allowance! })}{bar(chat.used, chat.allowance!)}</li>}
        {translation && <li className={translation.used >= translation.allowance! ? 'text-amber-700' : undefined}>{t('Translated pages in the trial: {used} of {allowance}', { used: translation.used, allowance: translation.allowance! })}{bar(translation.used, translation.allowance!)}</li>}
        {extraPages(billing) > 0 && (
          <li>
            {t('Extra pages: {n} left', { n: extraPages(billing) })}
            {importLeft(billing) > 0 && <span className="block text-xs text-gray-500">{t('{n} of them are the one-off allowance for your archive that comes with the yearly plan. They are used after this month’s pages.', { n: importLeft(billing) })}</span>}
          </li>
        )}
        {!!billing.limits?.pages_bonus && <li>{t('Pages you can keep: {n}, with {bonus} from invitations', { n: billing.limits.pages!, bonus: billing.limits.pages_bonus })}</li>}
        {vault && <li>{t('Storage: {used} of {limit} used', { used: format.bytes(vault.used_bytes), limit: format.bytes(vault.limit_bytes) })}{bar(vault.used_bytes, vault.limit_bytes)}</li>}
        {billing.people && <li>{t('People: up to {n}', { n: billing.people.limit })}</li>}
        {/* Share links are limited only on the free plan; on a paid plan nothing about them is a limit to show. */}
        {billing.links && billing.links.views.allowance !== null && <li>{t('Share link views: {used} of {allowance}', { used: billing.links.views.used, allowance: billing.links.views.allowance })} {t('this month')}</li>}
        {shares && shares.limit !== null && <li>{t('Share links: {live} live of {limit}', { live: shares.live, limit: shares.limit })}</li>}
      </ul>
      <ArchiveProgress />

      {error && <Notice kind="error">{error}</Notice>}
      {billing.addons?.page_topup.buyable && prices?.addons?.page_topup !== undefined && (reading.nearly || billing.addons.page_topup.pages_left > 0) && (
        <div className="space-y-1 mb-3">
          <p className="text-sm text-gray-700">{t('Running out of pages? A top-up adds 250 pages that do not expire with the month.')}</p>
          <button disabled={busy} onClick={() => go(() => api.billing.addon('page_topup'))} className={buttonClass}>{t('Add 250 pages for {price}', { price: money(prices.addons.page_topup) })}</button>
        </div>
      )}
      {trialUsedUp && <p className="text-sm text-amber-700 mb-3">{t('You have used up one of the trial’s totals. Your archive stays visible and you can export it; to add, ask or translate more, become a Founding member or choose a plan.')}</p>}
      {!paid && prices && !offer && (
        <p className="mb-3 text-sm"><Link to="/pricing" className="rounded-full border border-gray-300 px-4 py-1.5 text-gray-700 hover:bg-gray-50">{t('Compare plans')}</Link></p>
      )}
      {!paid && prices && offer && (
        <div className="space-y-3 mb-3">
          {billing.essential && prices.essential && (
            <div className="space-y-1">
              <p className="text-sm text-gray-700">{t('Essential: five pages a month and questions about your records; with the yearly plan, 150 extra pages once, for your medical archive.')}</p>
              <button disabled={busy} onClick={() => go(() => api.billing.checkout('year', 'essential'))} className={buttonClass}>{t('Essential for {price} a year', { price: money(prices.essential.year) })}</button>
              <button disabled={busy} onClick={() => go(() => api.billing.checkout('month', 'essential'))} className="block text-sm text-brand-600 hover:underline">{t('or {price} a month', { price: money(prices.essential.month) })}</button>
            </div>
          )}
          <div className="space-y-2">
            <button disabled={busy} onClick={() => go(() => api.billing.checkout('year'))} className={buttonClass}>
              {foundingLeft ? t('Premium for {price} a year (founding price, {regular} after)', { price: money(prices.founding.year), regular: money(prices.premium.year) }) : t('Premium for {price} a year', { price: money(prices.premium.year) })}
            </button>
            <button disabled={busy} onClick={() => go(() => api.billing.checkout('month'))} className="block text-sm text-brand-600 hover:underline">
              {t('or {price} a month', { price: money(prices.premium.month) })}
            </button>
          </div>
          {family && prices.family && (
            <div className="space-y-1">
              <p className="text-sm text-gray-700">{t('For a family, with up to six people, children and teenagers among them:')}</p>
              <button disabled={busy} onClick={() => go(() => api.billing.checkout('year', 'family'))} className={buttonClass}>{t('Family for {price} a year', { price: money(prices.family.year) })}</button>
              <button disabled={busy} onClick={() => go(() => api.billing.checkout('month', 'family'))} className="block text-sm text-brand-600 hover:underline">{t('or {price} a month', { price: money(prices.family.month) })}</button>
            </div>
          )}
          <p className="text-xs text-gray-500">{t('Renews until you cancel, and you can cancel at any time. In the first 14 days you can have your money back.')} <Link to="/pricing" className="underline">{t('What is included')}</Link></p>
        </div>
      )}
      {billing.invite && (
        <div className="space-y-1 mb-3">
          <p className="text-sm text-gray-700">{t('Invite someone: when they make an account with your link they get {n} more pages, and you get {reward} when they choose a plan.', { n: billing.invite.pages, reward: billing.invite.reward_pages })}</p>
          <InviteLink url={`${window.location.origin}/register?ref=invite&by=${billing.invite.token}`} />
          <p className="text-xs text-gray-500">{t('You can be rewarded for {max} invitations; {done} so far.', { max: billing.invite.max, done: billing.invite.rewarded })}</p>
        </div>
      )}
      {billing.can_manage && (
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
          <button disabled={busy} onClick={() => go(() => api.billing.portal('payment_method'))} className={sub?.status === 'past_due' ? buttonClass : 'text-brand-600 hover:underline'}>{t('Update payment method')}</button>
          {!sub?.ends_at && <button disabled={busy} onClick={() => go(() => api.billing.portal('cancel'))} className="text-brand-600 hover:underline">{t('Cancel subscription')}</button>}
          <button disabled={busy} onClick={() => go(() => api.billing.portal())} className="text-brand-600 hover:underline">{t('Manage billing, invoices and cancellation')}</button>
          {billing.billing_details && <button disabled={busy} onClick={() => void changeDetails()} className="text-brand-600 hover:underline">{t('Change billing details')}</button>}
          {billing.withdrawal?.allowed && <button disabled={busy} onClick={() => setWithdrawing(true)} className="text-brand-600 hover:underline">{t('Withdraw from this purchase')}</button>}
        </div>
      )}
      {billing.withdrawal?.requested && <p className="text-sm text-gray-700 mt-3">{t('Your withdrawal request was sent. We will answer within 14 days.')}</p>}
      {withdrawing && (
        <div className="mt-3 border border-gray-200 rounded-lg p-3 space-y-2">
          <p className="text-sm text-gray-700">{t('You can withdraw from this purchase within 14 days of buying it. We confirm by email at once and answer within 14 days. If we accept, your plan ends and we pay back what is due, to the way you paid.')}</p>
          {billing.withdrawal?.until && <p className="text-xs text-gray-500">{t('You can ask until {date}.', { date: day(billing.withdrawal.until) })}</p>}
          <button disabled={busy} onClick={() => void withdraw()} className={buttonClass}>{t('Send my withdrawal request')}</button>
          <button type="button" disabled={busy} onClick={() => setWithdrawing(false)} className="text-sm text-brand-600 hover:underline">{t('Cancel')}</button>
        </div>
      )}
      {invoices.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-medium text-gray-900 mb-1">{t('Invoices')}</h3>
          <InvoiceList invoices={invoices} />
          {invoiceTotal > invoices.length && <Link to="/account/invoices" className="mt-2 inline-block text-sm text-brand-600 hover:underline">{t('All invoices ({count})', { count: invoiceTotal })}</Link>}
        </div>
      )}
    </section>
  );
}
