import type { ReactNode } from 'react';
import type { AdminDashboard } from '../api';
import { useI18n } from '../i18n';
import { useFormat } from '../format';

/**
 * The operator's numbers, drawn for the page of its own (`pages/Admin.tsx`) in the public pages' look: Literata headings, paper and ink, the teal
 * accent for every bar (one series at a time, so one hue), and the state colours only for a guardrail's state, always with its icon and its word.
 * Nothing about a person. What the server says in English (a guardrail's name and note) is shown as it comes.
 */
export default function AdminDashboardView({ data }: { data: AdminDashboard }) {
  const { t } = useI18n();
  const format = useFormat();
  const n = (v: number | undefined) => v ?? 0;
  const w = data.windows;
  const f = data.funnel;
  const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
  const eur = (v: number) => format.amount(v, 'EUR');
  const LIMITS: Record<string, string> = {
    limit_pages: t('Pages for the month used up'),
    limit_messages: t('Trial questions used up'),
    limit_translated: t('Trial translations used up'),
    limit_import: t('Archive import used up'),
    limit_feature_translation: t('Tried to translate, not in the plan'),
    limit_feature_chat: t('Tried to ask, not in the plan'),
    limit_feature_linking: t('Tried connections, not in the plan'),
    limit_feature_related: t('Tried related documents, not in the plan'),
    fair_use: t('Hidden ceiling reached'),
  };
  const sources = Object.entries(data.sources).sort((a, b) => b[1] - a[1]);
  const limits = Object.entries(data.limits).sort((a, b) => b[1] - a[1]);
  const budget = data.costs.budget_euros;

  return (
    <div className="space-y-14">
      <section>
        <h1 className="font-display text-[clamp(2rem,4vw,3rem)] font-normal leading-tight">{t('How Spine is doing')}</h1>
        <p className="mt-2 text-ink/65">{t('Counts only, never who. The numbers are worked out again every minute.')}</p>
        <div className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Tile label={t('Sign-ups today')} value={n(w.today.signup)} sub={t('{week} in 7 days · {month} in 30 days', { week: n(w.days7.signup), month: n(w.days30.signup) })} />
          <Tile label={t('Payments today')} value={n(w.today.paid_event)} sub={t('{week} in 7 days · {month} in 30 days', { week: n(w.days7.paid_event), month: n(w.days30.paid_event) })} />
          <Tile label={t('Accounts')} value={data.accounts.total} sub={Object.entries(data.accounts.by_plan).map(([k, v]) => `${k} ${v}`).join(' · ')} />
          <Tile label={t('Founding places taken')} value={`${data.accounts.founding.held}`} sub={t('of {limit}', { limit: data.accounts.founding.limit })}>
            <Meter part={data.accounts.founding.held} whole={data.accounts.founding.limit} />
          </Tile>
        </div>
      </section>

      <Block title={t('Are we on track?')} lead={t('The targets of the marketing plan for the first 30 days, and the alerts that need a look.')}>
        <ul className="divide-y divide-ink/10 rounded-2xl border border-ink/10 bg-surface">
          {data.guardrails.map(g => {
            const shown = g.value === null ? '–' : g.unit === 'percent' ? `${g.value}%` : String(g.value);
            const target = g.unit === 'percent' ? `${g.target}%` : String(g.target);
            return (
              <li key={g.key} className="grid gap-3 px-5 py-4 sm:grid-cols-[8rem_1fr_auto] sm:items-center">
                <State state={g.state} />
                <div>
                  <p className="font-medium">{g.key}</p>
                  <p className="text-sm text-ink/60">{g.note}</p>
                  {g.target > 0 && g.value !== null && <div className="mt-2 max-w-md"><Meter part={g.value} whole={g.target} /></div>}
                </div>
                <p className="text-right"><span className="font-display text-2xl">{shown}</span> <span className="text-sm text-ink/60">{t('target {target}', { target })}</span></p>
              </li>
            );
          })}
        </ul>
      </Block>

      <div className="grid gap-14 lg:grid-cols-2 lg:gap-10">
        <Block title={t('From sign-up to use')} lead={t('How many accounts got to each step, and the share of all sign-ups.')}>
          <Bars rows={[
            [t('Signed up'), f.signups],
            [t('Read pages'), f.read],
            [t('Imported (5 pages or more)'), f.imported],
            [t('Asked a question'), f.asked],
            [t('Translated a page'), f.translated],
          ].map(([label, v]) => ({ label: label as string, value: v as number, note: `${pct(v as number, f.signups)}%` }))} max={f.signups} />
        </Block>

        <Block title={t('Where sign-ups came from')} lead={t('The last 30 days, from the word after ?ref= in the link they followed.')}>
          {sources.length === 0 ? <Empty /> : <Bars rows={sources.map(([k, v]) => ({ label: k, value: v }))} max={sources[0]![1]} />}
        </Block>
      </div>

      {data.cohorts.length > 0 && (
        <Block title={t('Week by week')} lead={t('Each week’s new accounts, and how many of them went on to read, ask and translate.')}>
          <div className="max-w-full overflow-x-auto rounded-2xl border border-ink/10 bg-surface">
            <table className="w-full min-w-[34rem] text-left text-sm">
              <thead className="text-ink/60"><tr className="border-b border-ink/10"><Th>{t('Week of sign-up')}</Th><Th right>{t('Accounts')}</Th><Th right>{t('Read pages')}</Th><Th right>{t('Asked a question')}</Th><Th right>{t('Translated a page')}</Th></tr></thead>
              <tbody>
                {data.cohorts.map(c => (
                  <tr key={c.week} className="border-b border-ink/5 last:border-0">
                    <td className="px-4 py-3">{format.dayMonth(c.week)}</td>
                    <td className="px-4 py-3 text-right font-medium">{c.signups}</td>
                    {[c.read, c.asked, c.translated].map((v, i) => <td key={i} className="whitespace-nowrap px-4 py-3 text-right">{v} <span className="text-ink/50">{pct(v, c.signups)}%</span></td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Block>
      )}

      <div className="grid gap-14 lg:grid-cols-2 lg:gap-10">
        <Block title={t('What the AI cost this month')} lead={t('The relay’s estimate by the token, not an invoice.')}>
          <div className="rounded-2xl border border-ink/10 bg-surface p-5">
            <p><span className="font-display text-4xl">{eur(data.costs.euros)}</span>{budget !== null && <span className="ml-2 text-ink/60">{t('of a budget of {budget}', { budget: eur(budget) })}</span>}</p>
            {budget !== null && <div className="mt-3"><Meter part={data.costs.euros} whole={budget} /></div>}
            <dl className="mt-5 grid grid-cols-2 gap-4 text-sm">
              <div><dt className="text-ink/60">{t('Trial accounts, on average')}</dt><dd className="mt-1 text-lg">{data.costs.per_signup_trial === null ? '–' : eur(data.costs.per_signup_trial)}</dd></div>
              <div><dt className="text-ink/60">{t('Accounts above the alert')}</dt><dd className="mt-1 text-lg">{data.costs.above_alert}</dd></div>
            </dl>
            <div className="mt-5">
              <Bars rows={Object.entries(data.costs.by_plan).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: k, value: v, shown: eur(v) }))} max={Math.max(...Object.values(data.costs.by_plan), 0)} />
            </div>
          </div>
        </Block>

        <Block title={t('Where people hit a limit')} lead={t('The last 30 days. Many at one limit means it is in the wrong place, or that it sells.')}>
          {limits.length === 0 ? <Empty /> : <Bars rows={limits.map(([k, v]) => ({ label: LIMITS[k] ?? k, value: v }))} max={limits[0]![1]} />}
        </Block>
      </div>

      <Block title={t('Activity')} lead={t('Counted by the day.')}>
        <div className="overflow-x-auto rounded-2xl border border-ink/10 bg-surface">
          <table className="w-full text-left text-sm">
            <thead className="text-ink/60"><tr className="border-b border-ink/10"><Th>&nbsp;</Th><Th right>{t('Today')}</Th><Th right>{t('7 days')}</Th><Th right>{t('30 days')}</Th></tr></thead>
            <tbody>
              {([[t('Sign-ups'), 'signup'], [t('Checkouts started'), 'checkout_started'], [t('Payments'), 'paid_event'], [t('Top-ups bought'), 'addon_page_topup'], [t('Invitation bonuses given'), 'invitation_bonus'], [t('Share links opened'), 'share_opened'], [t('Emergency cards opened'), 'card_opened']] as const).map(([label, key]) => (
                <tr key={key} className="border-b border-ink/5 last:border-0"><td className="px-4 py-3">{label}</td><td className="px-4 py-3 text-right">{n(w.today[key])}</td><td className="px-4 py-3 text-right">{n(w.days7[key])}</td><td className="px-4 py-3 text-right">{n(w.days30[key])}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </Block>
    </div>
  );
}

function Block({ title, lead, children }: { title: string; lead?: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="font-display text-[clamp(1.5rem,2.6vw,2rem)] font-normal leading-tight">{title}</h2>
      {lead && <p className="mt-1 text-sm text-ink/60">{lead}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Tile({ label, value, sub, children }: { label: string; value: number | string; sub?: string; children?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-ink/10 bg-surface p-5">
      <p className="text-sm text-ink/60">{label}</p>
      <p className="mt-2 font-display text-4xl leading-none">{value}</p>
      {sub && <p className="mt-2 text-xs text-ink/55">{sub}</p>}
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

/** A share of a whole, as a thin bar. */
function Meter({ part, whole }: { part: number; whole: number }) {
  const width = whole > 0 ? Math.min(100, (part / whole) * 100) : 0;
  return (
    <span className="block h-2 overflow-hidden rounded-full bg-ink/10" role="presentation">
      <span className="block h-2 rounded-full bg-accent" style={{ width: `${width}%` }} />
    </span>
  );
}

/** One series as horizontal bars, its label and value in ink and the bar in the accent; the value is also the bar's title, for a pointer. */
function Bars({ rows, max }: { rows: Array<{ label: string; value: number; note?: string; shown?: string }>; max: number }) {
  return (
    <ul className="space-y-3">
      {rows.map(r => (
        <li key={r.label} title={`${r.label}: ${r.shown ?? r.value}`}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate">{r.label}</span>
            <span className="shrink-0 font-medium">{r.shown ?? r.value}{r.note && <span className="ml-2 font-normal text-ink/50">{r.note}</span>}</span>
          </div>
          <span className="mt-1.5 block h-2.5 rounded-full bg-ink/[0.06]" role="presentation">
            <span className="block h-2.5 rounded-full bg-accent" style={{ width: `${max > 0 ? Math.max(1.5, (r.value / max) * 100) : 0}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A guardrail's state: an icon and a word, so it is never told by colour alone. */
function State({ state }: { state: 'ok' | 'amber' | 'red' | 'early' }) {
  const { t } = useI18n();
  const look = {
    ok: { cls: 'bg-green-50 text-green-800 border-green-200', word: t('On track'), path: 'M4.5 10.5l3.5 3.5 7.5-8' },
    amber: { cls: 'bg-amber-50 text-amber-800 border-amber-200', word: t('Watch'), path: 'M10 5v6M10 14.5v.5' },
    red: { cls: 'bg-red-50 text-red-800 border-red-200', word: t('Needs a look'), path: 'M6 6l8 8M14 6l-8 8' },
    early: { cls: 'bg-ink/5 text-ink/70 border-ink/15', word: t('Too early'), path: 'M5 10h10' },
  }[state];
  return (
    <span className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${look.cls}`}>
      <svg viewBox="0 0 20 20" aria-hidden="true" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round"><path d={look.path} /></svg>
      {look.word}
    </span>
  );
}

function Th({ children, right = false }: { children: ReactNode; right?: boolean }) {
  return <th className={`whitespace-nowrap px-4 py-3 font-normal ${right ? 'text-right' : ''}`}>{children}</th>;
}

function Empty() {
  const { t } = useI18n();
  return <p className="rounded-2xl border border-dashed border-ink/15 px-5 py-6 text-sm text-ink/55">{t('Nothing yet.')}</p>;
}
