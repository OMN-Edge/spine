import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, type Pricing as PricingData } from '../api';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { useFormat } from '../format';
import { Actions, PublicPage, usePublicOptions, type PublicOptions } from '../components/PublicPage';
import { FamilySpines } from '../components/PublicDrawings';
import { TRIAL_TOTALS } from 'spine-core/billing/plans';
import { FOUNDING_PLACES, foundingStage } from '../founding';

/**
 * What the plans are and cost, read before an account exists (CR-PAY-01: the price, the renewal and how to cancel are shown before any
 * purchase), in the public pages' look (`PublicPage`: paper and ink, Literata headings, the teal accent, the honey highlight). The amounts are
 * the payment provider's, read by the server from the prices the checkout charges, so the page and the checkout cannot disagree about what is on offer;
 * where the provider cannot say, the page shows none. The operator sells. What each plan includes is `core/src/billing/plans.ts`; change one only with the other.
 */
type Period = 'year' | 'month';

export default function Pricing() {
  const options = usePublicOptions();
  const { authenticated } = useAuth();
  const [pricing, setPricing] = useState<PricingData | null>(null);
  useEffect(() => { api.billing.pricing().then(setPricing).catch(() => setPricing({ enabled: false })); }, []);
  return <PricingPage pricing={pricing} authenticated={authenticated} options={options} />;
}

/** The page for what the server said (`null` while it has not): drawn from its arguments alone, so a test can give each case. */
export function PricingPage({ pricing, authenticated, options, initialPeriod = 'year' }: { pricing: PricingData | null; authenticated: boolean; options: PublicOptions; initialPeriod?: Period }) {
  const { t } = useI18n();
  const [period, setPeriod] = useState<Period>(initialPeriod);
  const format = useFormat();
  const prices = pricing?.prices;
  // A whole amount without its cents (€49, not €49.00); any other with them, written as the reader's language writes money.
  const money = (n: number) => format.amount(n, prices?.currency ?? 'EUR');
  // Every account starts on the trial; a plan is chosen from the account page.
  const cta = authenticated
    ? { to: '/account', label: t('Choose a plan on your account page') }
    : { to: '/register', label: t('Start with three months free') };
  // The trial is the one way in, and says so once, above the plans. A plan's own button says what it is: where it goes with the plan named, to be found on the account page.
  const toPlan = (plan: 'free' | 'essential' | 'premium' | 'family', label: string) => ({ to: authenticated ? '/account' : `/register?plan=${plan}`, label });

  return (
    <PublicPage options={options}>
      <section className="landing-grid border-b border-ink/10">
        <div className="mx-auto max-w-6xl px-4 pb-12 pt-14 sm:px-6 sm:pt-20">
          <p className="text-sm font-medium uppercase tracking-[0.14em] text-accent">{t('Plans and prices')}</p>
          <h1 className="mt-4 max-w-3xl font-display text-[clamp(2.3rem,5vw,3.6rem)] font-normal leading-[1.06] tracking-[-0.015em]">
            {t('Pay for what you add. Everything you keep stays yours to use.')}
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-ink/75">
            {t('What differs is how many pages you add. Asking about your records, translating them, sharing and exporting are not counted on the plans that include them.')}
          </p>
          {pricing && !pricing.enabled && <p className="mt-6 max-w-2xl text-ink/80">{t('This Spine has no paid plans. Everything in it is available to the people who have an account.')}</p>}
          {pricing?.enabled && !prices && <p className="mt-6 max-w-2xl text-ink/80">{t('The prices cannot be shown right now. Try again in a moment.')}</p>}
        </div>
      </section>

      {pricing?.enabled && prices && (
        <>
          <p className="mx-auto max-w-6xl px-4 pt-6 text-sm text-ink/60 sm:px-6">{t('Prices include VAT where it applies.')}</p>
          <Trial cta={cta} />

          {pricing.founding_left ? <Founding price={money(prices.founding.year)} regular={money(prices.premium.year)} left={pricing.founding_left} /> : null}

          <section className="mx-auto max-w-6xl px-4 pt-14 sm:px-6">
            <div className="flex flex-wrap items-end justify-between gap-6">
              <h2 className="max-w-xl font-display text-[clamp(1.7rem,3.2vw,2.4rem)] font-normal leading-tight">{t('Then keep the plan that fits')}</h2>
              <PeriodSwitch period={period} onChange={setPeriod} />
            </div>
            {pricing.family && prices.family && (
              <p className="mt-4 text-ink/75">
                {t('Sharing with family?')} <a href="#family" className="font-medium text-accent underline underline-offset-4 hover:text-ink">{t('See the Family plan')}</a>
              </p>
            )}

            <div className="mt-8 grid gap-5 lg:grid-cols-3">
              <PlanCard
                name={t('Free')} tagline={t('To keep your records and show them')}
                price={money(0)} per={t('for as long as you like')} cta={toPlan('free', t('Stay free after the trial'))}
                features={[
                  [true, t('Your records, the timeline, search on your device and export')],
                  [true, t('The emergency card')],
                  [true, t('Up to 50 pages kept')],
                  [true, t('About 3 pages of AI reading a month, kept for up to three months')],
                  [true, t('1 GB of storage')],
                  [true, t('One live share link, without translation')],
                  [false, t('No questions and no translation')],
                ]}
              />
              {pricing.essential && prices.essential && (
                <PlanCard
                  name={t('Essential')} tagline={t('To ask about a history that has grown')}
                  {...amounts(prices.essential, period, money, t)} cta={toPlan('essential', t('Choose Essential'))}
                  bonus={period === 'year' ? t('Includes {n} extra pages, once, to read your medical archive', { n: 150 }) : null}
                  features={[
                    [true, t('The emergency card')],
                    [true, t('About 5 pages of AI reading a month, kept for up to three months')],
                    [true, t('2 GB of storage, and no limit on the pages you keep')],
                    [true, t('Questions about your records, connections between documents, and related documents')],
                    [true, t('Share links, and approving visitors before they see one: no monthly limit for normal use')],
                    [false, t('No translation of documents: that is part of Premium')],
                  ]}
                />
              )}
              <PlanCard
                featured name={t('Premium')} tagline={t('For a doctor in another country')}
                {...amounts(prices.premium, period, money, t)} cta={toPlan('premium', t('Choose Premium'))}
                bonus={period === 'year' ? t('Includes {n} extra pages, once, to read your medical archive', { n: 250 }) : null}
                note={period === 'year' && pricing.founding_left ? t('Founding members pay {price} a year', { price: money(prices.founding.year) }) : null}
                features={[
                  [true, t('Translation of your documents and of what a doctor opens')],
                  [true, t('AI reading within fair use: about 30 pages a month, and what you do not use is kept for up to three months')],
                  [true, t('Questions about your records, connections between documents, and related documents')],
                  [true, t('The emergency card')],
                  [true, t('5 GB of storage, and no limit on the pages you keep')],
                  [true, t('Share links, and approving visitors before they see one: no monthly limit for normal use')],
                ]}
              />
            </div>
            <p className="mt-5 max-w-3xl text-sm leading-relaxed text-ink/60">
              {t('We may slow or pause automated or abusive use. This never affects normal use of your own records.')} {t('Translations help a doctor read your history. They are not certified translations.')}
            </p>
          </section>

          {pricing.family && prices.family && (
            <section id="family" className="mx-auto max-w-6xl scroll-mt-6 px-4 pt-14 sm:px-6">
              <div className="grid items-center gap-10 rounded-3xl border border-ink/10 bg-honey/[0.09] p-6 sm:p-10 lg:grid-cols-[1.1fr_1fr]">
                <div>
                  <p className="text-sm font-medium uppercase tracking-[0.14em] text-accent">{t('Family')}</p>
                  <h2 className="mt-3 font-display text-[clamp(1.7rem,3.2vw,2.4rem)] font-normal leading-tight">{t('Premium for up to six people')}</h2>
                  <PriceLine {...amounts(prices.family, period, money, t)} />
                  <ul className="mt-6 space-y-3">
                    <Check ok>{t('Every Premium feature, for each person')}</Check>
                    <Check ok>{t('Each person has their own account, records, password and emergency card')}</Check>
                    <Check ok>{t('Shared by all: 25 GB of storage and 60 pages of AI reading a month, with each account held to 30')}</Check>
                    {period === 'year' && <Check ok>{t('Includes {n} extra pages, once, to read your medical archive', { n: 500 })}</Check>}
                    <Check ok>{t('Records for children, kept by their guardians, with other guardians let in')}</Check>
                    <Check ok>{t('A teenager from sixteen can have an account of their own, and at eighteen the records can become theirs')}</Check>
                  </ul>
                  <Link to={toPlan('family', t('Choose Family')).to} className="mt-8 inline-block rounded-full bg-ink px-6 py-3 font-medium text-paper hover:bg-ink/85">{t('Choose Family')}</Link>
                </div>
                <figure><FamilySpines /></figure>
              </div>
            </section>
          )}

          <section className="mx-auto max-w-6xl px-4 pt-16 sm:px-6">
            <h2 className="max-w-3xl font-display text-[clamp(1.7rem,3.2vw,2.4rem)] font-normal leading-tight">{t('What counts, and what does not')}</h2>
            <dl className="mt-8 grid gap-x-12 gap-y-8 border-t border-ink/10 pt-8 md:grid-cols-3">
              <Point title={t('Only adding counts')}>{t('A page counts when Spine reads it into your archive. Unused pages are kept for up to three months, so a visit with a full set of tests fits.')}</Point>
              <Point title={t('Using is not counted')}>{t('Asking, translating, searching, sharing and exporting what is already in your archive never use up pages.')}</Point>
              <Point title={t('Nothing is ever deleted')}>{t('When a trial or a plan ends, your archive stays visible and you can export it. Only adding more, and the features of the paid plans, stop.')}</Point>
            </dl>
          </section>

          <section className="mx-auto max-w-6xl px-4 pt-16 sm:px-6">
            <h2 className="max-w-3xl font-display text-[clamp(1.7rem,3.2vw,2.4rem)] font-normal leading-tight">{t('How paying works')}</h2>
            <dl className="mt-8 grid gap-x-12 gap-y-8 border-t border-ink/10 pt-8 md:grid-cols-2">
              <Point title={t('Cancel whenever you like')}>{t('A subscription renews every month or every year until you cancel. You cancel from your account, on the payment provider’s page, and keep your plan until the end of what you paid for.')}</Point>
              <Point title={t('Your money back')}>{t('In the first 14 days you can withdraw and have your money back. For a yearly plan we refund what you paid, minus the part of the year you already used.')}</Point>
              <Point title={pricing?.seller_name ? t('Sold by {seller}', { seller: pricing.seller_name }) : t('Sold by the operator of this Spine')}>{t('Card payments are handled by Stripe. Spine never sees your card, only which plan you have. A price includes any VAT that is due on it.')}</Point>
              <Point title={t('Or run your own')}>{t('Spine is open-source software. Running your own copy is free, and has no plans.')}</Point>
            </dl>
          </section>
        </>
      )}

      <section className="mt-16 border-t border-ink/10">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-8 px-4 py-16 sm:px-6 lg:flex-row lg:items-end">
          <h2 className="max-w-xl font-display text-[clamp(2rem,4.2vw,3.2rem)] font-normal leading-[1.08]">{t('See it with invented records first.')}</h2>
          <Actions options={options} />
        </div>
      </section>
    </PublicPage>
  );
}

/**
 * The amounts of a plan for the chosen period: what is charged and what it is per, and for a year one short line, how much less than twelve months
 * of the monthly price. Rounded down, so the page never claims more than the prices give; where there is no saving, nothing is said.
 */
function amounts(p: { year: number; month: number }, period: Period, money: (n: number) => string, t: ReturnType<typeof useI18n>['t']) {
  const percent = Math.floor((1 - p.year / (p.month * 12)) * 100);
  return period === 'year'
    ? { price: money(p.year), per: t('a year'), sub: percent > 0 ? t('Save {percent}%', { percent }) : undefined }
    : { price: money(p.month), per: t('a month') };
}

/** Three months of everything, up to three totals, drawn as the three numbers they are. */
function Trial({ cta }: { cta: { to: string; label: string } }) {
  const { t } = useI18n();
  const items: Array<[number, string]> = [[TRIAL_TOTALS.pages, t('pages of AI reading')], [TRIAL_TOTALS.messages, t('questions about your records')], [TRIAL_TOTALS.translated, t('translated pages')]];
  return (
    <section className="bg-band text-band-fg">
      <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[1fr_1.3fr]">
        <div>
          <h2 className="font-display text-[clamp(1.8rem,3.4vw,2.6rem)] font-normal leading-tight">{t('Every account starts with three months of everything, free.')}</h2>
          <p className="mt-4 max-w-md text-lg leading-relaxed text-band-fg/75">{t('No card. Every feature of Premium, up to these totals for the whole three months. After that you keep the free plan or choose one.')}</p>
          <Link to={cta.to} className="mt-6 inline-block rounded-full bg-accent-light px-6 py-3 font-medium text-band hover:bg-accent-light/90">{cta.label}</Link>
        </div>
        <ul className="grid grid-cols-3 gap-3 sm:gap-5">
          {items.map(([n, label]) => (
            <li key={label} className="rounded-2xl border border-band-fg/15 bg-band-fg/[0.04] p-4 sm:p-6">
              <span className="block font-display text-[clamp(2.2rem,5vw,3.6rem)] leading-none text-accent-light">{n}</span>
              <span className="mt-3 block text-sm leading-snug text-band-fg/80">{label}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function PeriodSwitch({ period, onChange }: { period: Period; onChange: (p: Period) => void }) {
  const { t } = useI18n();
  const button = (p: Period, label: ReactNode) => (
    <button type="button" role="radio" aria-checked={period === p} onClick={() => onChange(p)}
      className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${period === p ? 'bg-ink text-paper' : 'text-ink/70 hover:text-ink'}`}>{label}</button>
  );
  return (
    <div role="radiogroup" aria-label={t('How often you pay')} className="inline-flex items-center gap-1 rounded-full border border-ink/15 bg-surface p-1">
      {button('year', <>{t('Yearly')} <span className={`ml-1 rounded-full px-2 py-0.5 text-xs ${period === 'year' ? 'bg-honey text-band' : 'bg-honey/30 text-ink'}`}>{t('extra pages for your archive')}</span></>)}
      {button('month', t('Monthly'))}
    </div>
  );
}

function PlanCard({ name, tagline, price, per, sub, bonus, note, features, cta, featured = false }: {
  name: string; tagline: string; price: string; per: string; sub?: string; bonus?: string | null; note?: string | null;
  features: Array<[boolean, string]>; cta: { to: string; label: string }; featured?: boolean;
}) {
  return (
    <article className={`relative flex flex-col rounded-3xl p-6 sm:p-7 ${featured ? 'bg-band text-band-fg ring-1 ring-accent/40 shadow-[0_24px_60px_-28px_rgb(var(--band)/0.7)] lg:-my-3 lg:py-10' : 'border border-ink/12 bg-surface'}`}>
      <h3 className="font-display text-2xl">{name}</h3>
      <p className={`mt-1 text-sm ${featured ? 'text-band-fg/70' : 'text-ink/60'}`}>{tagline}</p>
      <PriceLine price={price} per={per} sub={sub} inverted={featured} />
      {bonus && <p className={`mt-4 rounded-xl px-3 py-2 text-sm font-medium ${featured ? 'bg-accent-light/15 text-accent-light' : 'bg-honey/25 text-ink'}`}>{bonus}</p>}
      {note && <p className={`mt-2 text-sm ${featured ? 'text-band-fg/75' : 'text-ink/65'}`}>{note}</p>}
      <ul className="mt-6 flex-1 space-y-3">
        {features.map(([ok, text]) => <Check key={text} ok={ok} inverted={featured}>{text}</Check>)}
      </ul>
      <Link to={cta.to} className={`mt-8 rounded-full px-6 py-3 text-center font-medium ${featured ? 'bg-accent-light text-band hover:bg-accent-light/90' : 'border border-ink/25 hover:bg-ink/5'}`}>{cta.label}</Link>
    </article>
  );
}

function PriceLine({ price, per, sub, inverted = false }: { price: string; per: string; sub?: string; inverted?: boolean }) {
  return (
    <div className="mt-6">
      <p><span className="font-display text-[2.6rem] leading-none">{price}</span> <span className={inverted ? 'text-band-fg/70' : 'text-ink/60'}>{per}</span></p>
      {sub && <p className={`mt-1 text-sm ${inverted ? 'text-band-fg/60' : 'text-ink/55'}`}>{sub}</p>}
    </div>
  );
}

/** A line of what a plan includes (a tick) or does not (a dash, so it is not read by colour alone). */
function Check({ ok, inverted = false, children }: { ok: boolean; inverted?: boolean; children: ReactNode }) {
  const tone = inverted ? 'text-band-fg/85' : 'text-ink/80';
  return (
    <li className={`flex gap-3 text-[0.95rem] leading-snug ${ok ? tone : inverted ? 'text-band-fg/50' : 'text-ink/50'}`}>
      <svg viewBox="0 0 20 20" aria-hidden="true" className={`mt-0.5 h-5 w-5 shrink-0 ${ok ? (inverted ? 'text-accent-light' : 'text-accent') : 'opacity-60'}`} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        {ok ? <path d="M4.5 10.5l3.5 3.5 7.5-8" /> : <path d="M5.5 10h9" />}
      </svg>
      <span>{children}</span>
    </li>
  );
}

/** The founding offer, while places are left: the price kept for as long as the subscription runs, and what is said of the places by how many are taken (`founding.ts`). */
function Founding({ price, regular, left }: { price: string; regular: string; left: number }) {
  const { t } = useI18n();
  const taken = FOUNDING_PLACES - left;
  const stage = foundingStage(left);
  return (
    <section className="mx-auto max-w-6xl px-4 pt-14 sm:px-6">
      <div className="grid gap-8 rounded-3xl border border-accent/30 bg-accent/5 p-6 sm:p-10 md:grid-cols-[1.3fr_1fr] md:items-center">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.14em] text-accent">{t('Founding members')}</p>
          <h2 className="mt-3 font-display text-[clamp(1.7rem,3.2vw,2.4rem)] font-normal leading-tight">
            {t('Premium for {price} a year, for as long as you stay.', { price })}
          </h2>
          <p className="mt-4 max-w-xl leading-relaxed text-ink/75">{t('For the first 500 people only, instead of {regular}. The price stays yours for as long as your subscription runs, and you can take it during your free trial.', { regular })}</p>
        </div>
        <div>
          {stage === 'quiet' && <p className="text-sm font-medium text-ink/80">{t('Founding price for the first 500 members')}</p>}
          {stage === 'count' && <p className="flex items-baseline justify-between text-sm text-ink/70"><span>{t('{taken} of 500 taken', { taken })}</span><span className="font-medium text-ink">{t('{left} left', { left })}</span></p>}
          {stage === 'scarce' && <p className="text-sm font-medium text-ink">{t('Only {left} founding places left', { left })}</p>}
          {stage !== 'quiet' && (
            <span className="mt-2 block h-3 overflow-hidden rounded-full bg-ink/10" role="presentation">
              <span className="block h-3 rounded-full bg-accent" style={{ width: `${Math.max(2, Math.round((taken / FOUNDING_PLACES) * 100))}%` }} />
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

function Point({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-lg font-medium">{title}</dt>
      <dd className="mt-2 leading-relaxed text-ink/70">{children}</dd>
    </div>
  );
}

