import type { AccountsStore } from 'spine-core/store/types.js';
import { FOUNDING_LIMIT, type PlanId } from 'spine-core/billing/plans.js';
import { standingOf } from './plans/seat.js';
import { costKey, type Family } from './plans/cost.js';
import { monthlyCost } from './plans/budget.js';
import { operatorSettings } from './operator-settings.js';

/**
 * What the operator and the marketing role look at (the marketing plan's "Day-one metrics and dashboard"), and nothing that is a person: counts by day and by
 * kind (`metrics`), the plan accounts are on, and what the server can see of an account's use (pages read, questions asked, pages translated, the import
 * used), counted by account and never shown by account. What only the app could report (documents kept, the emergency card, an invitation sent) is not here:
 * the app reports no counters, so the figures that stand for those are said to be proxies. Admin only; read at most once a minute.
 */
/** `early` is neutral: too little time has passed, or too few accounts exist, for a target to say anything. */
export type State = 'ok' | 'amber' | 'red' | 'early';
export interface Guardrail { key: string; value: number | null; target: number; unit: 'percent' | 'count' | 'euros'; state: State; note: string }
export interface Dashboard {
  generated_at: string;
  windows: Record<'today' | 'days7' | 'days30', Record<string, number>>;
  sources: Record<string, number>;
  accounts: { total: number; by_plan: Record<string, number>; founding: { held: number; limit: number } };
  funnel: { signups: number; read: number; imported: number; asked: number; translated: number };
  cohorts: Array<{ week: string; signups: number; read: number; asked: number; translated: number }>;
  costs: { month: string; euros: number; budget_euros: number | null; above_alert: number; by_plan: Record<string, number>; per_signup_trial: number | null };
  limits: Record<string, number>;
  guardrails: Guardrail[];
}

/** An account counts as having imported once it has read this many pages: the server cannot see documents, so this stands for the plan's "5+ documents kept". */
const IMPORTED_PAGES = 5;
const FAMILIES: Family[] = ['reading', 'chat', 'translation'];
const DAY = 24 * 3600e3;
const day = (d: Date) => d.toISOString().slice(0, 10);
/** The Monday of the week a day is in. */
const weekOf = (iso: string): string => { const d = new Date(iso); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return day(d); };

/** The 30 days a target is for, and how few days of data must be there before it says anything: a target for a month is not failed on the first day. */
export const TARGET_DAYS = 30;
export const TOO_EARLY_DAYS = 7;

/**
 * Where a guardrail stands. With less than a week of data it is `early`, never red; a target counted over the 30 days (`windowed`) is pro-rated to the days that have passed, so
 * one sign-up on day 2 against a target of 300 for the month is measured against 20, not 300.
 */
export const stateOf = (value: number | null, target: number, higherIsBetter: boolean, elapsedDays: number = TARGET_DAYS, windowed = false): State => {
  if (value === null) return 'ok';
  if (elapsedDays < TOO_EARLY_DAYS) return 'early';
  const aimed = windowed ? target * Math.min(1, elapsedDays / TARGET_DAYS) : target;
  const ratio = higherIsBetter ? value / aimed : aimed / Math.max(value, 1e-9);
  return ratio >= 1 ? 'ok' : ratio >= 0.75 ? 'amber' : 'red';
};

export async function dashboardOf(store: AccountsStore, now: Date = new Date()): Promise<Dashboard> {
  const totalsSince = async (from: Date) => Object.fromEntries((await store.metrics.totals(day(from))).map(t => [t.name, t.total]));
  const [today, days7, days30] = await Promise.all([totalsSince(now), totalsSince(new Date(now.getTime() - 6 * DAY)), totalsSince(new Date(now.getTime() - 29 * DAY))]);
  const sources = Object.fromEntries(Object.entries(days30).filter(([k]) => k.startsWith('signup_from_')).map(([k, v]) => [k.slice('signup_from_'.length), v]));
  const limits = Object.fromEntries(Object.entries(days30).filter(([k]) => k === 'fair_use' || k.startsWith('limit_')));

  const month = now.toISOString().slice(0, 7);
  const byPlan: Record<string, number> = {};
  const euroByPlan: Record<string, number> = {};
  const weeks = new Map<string, { week: string; signups: number; read: number; asked: number; translated: number }>();
  const funnel = { signups: 0, read: 0, imported: 0, asked: 0, translated: 0 };
  let euros = 0;
  let above = 0;
  let trialSignups = 0;
  let trialEuros = 0;
  let first: string | null = null;
  const settings = Object.fromEntries((await operatorSettings(store)).map(s => [s.key, s.value]));
  const aiEurosPerMonth = settings['ai.account_alert'] ?? Infinity;
  const cutoff = new Date(now.getTime() - 8 * 7 * DAY);

  for (const user of await store.users.list()) {
    const standing = await standingOf(store, user.id, now);
    if (!standing) continue;
    const plan: PlanId = standing.entitlements.plan;
    byPlan[plan] = (byPlan[plan] ?? 0) + 1;
    const used = (key: string) => store.usage.aiUsed(user.id, key);
    const [pages, asked, translated] = await Promise.all([used('total:pages'), used('total:messages'), used('total:translated')]);
    const cost = (await store.usage.aiUsedMany(user.id, FAMILIES.map(f => costKey(f, month)))) / 1e6;
    euros += cost;
    euroByPlan[plan] = (euroByPlan[plan] ?? 0) + cost;
    if (cost >= aiEurosPerMonth) above++;
    if (plan === 'trial') { trialSignups++; trialEuros += cost; }
    const read = pages > 0;
    funnel.signups++;
    if (first === null || user.created_at < first) first = user.created_at;
    if (read) funnel.read++;
    if (pages >= IMPORTED_PAGES) funnel.imported++;
    if (asked > 0) funnel.asked++;
    if (translated > 0) funnel.translated++;
    if (new Date(user.created_at) >= cutoff) {
      const w = weekOf(user.created_at);
      const row = weeks.get(w) ?? { week: w, signups: 0, read: 0, asked: 0, translated: 0 };
      row.signups++; if (read) row.read++; if (asked > 0) row.asked++; if (translated > 0) row.translated++;
      weeks.set(w, row);
    }
  }
  const held = await store.billing.foundingHeld();
  const pct = (n: number) => (funnel.signups > 0 ? Math.round((n / funnel.signups) * 100) : null);
  const budget = settings['ai.budget'] ?? null;
  const monthTotal = await monthlyCost(store, month);

  // How long there has been anything to measure: from the first account, so a new instance is not judged on a month it has not had.
  const elapsedDays = first === null ? 0 : Math.max(0, (now.getTime() - new Date(first).getTime()) / DAY);
  const T = { accounts: settings['target.accounts'] ?? 0, imported: settings['target.imported'] ?? 0, asked: settings['target.asked'] ?? 0, founding: settings['target.founding'] ?? 0 };
  const guardrails: Guardrail[] = [
    { key: 'Sign-ups in the last 30 days', value: days30.signup ?? 0, target: T.accounts, unit: 'count', state: stateOf(days30.signup ?? 0, T.accounts, true, elapsedDays, true), note: 'a target you set on this page' },
    { key: 'Imported (5 or more pages read), share of sign-ups', value: pct(funnel.imported), target: T.imported, unit: 'percent', state: stateOf(pct(funnel.imported), T.imported, true, elapsedDays), note: 'stands for 5+ documents kept, which only the app can count' },
    { key: 'Asked a question, share of sign-ups', value: pct(funnel.asked), target: T.asked, unit: 'percent', state: stateOf(pct(funnel.asked), T.asked, true, elapsedDays), note: 'a target you set on this page' },
    { key: 'Founding member places taken', value: held, target: T.founding, unit: 'count', state: stateOf(held, T.founding, true, elapsedDays), note: 'of 500' },
    { key: 'Accounts above the AI alert this month', value: above, target: 0, unit: 'count', state: above === 0 ? 'ok' : 'red', note: `an account's estimated AI cost of ${aiEurosPerMonth} EUR or more: look at each` },
    ...(budget !== null ? [{ key: 'Share of the monthly AI budget used', value: Math.round((monthTotal / budget) * 100), target: 80, unit: 'percent' as const, state: (monthTotal / budget >= 1 ? 'red' : monthTotal / budget >= 0.8 ? 'amber' : 'ok') as State, note: 'the monthly AI budget you set on this page' }] : []),
  ];

  return {
    generated_at: now.toISOString(),
    windows: { today, days7, days30 },
    sources,
    accounts: { total: funnel.signups, by_plan: byPlan, founding: { held, limit: FOUNDING_LIMIT } },
    funnel,
    cohorts: [...weeks.values()].sort((a, b) => (a.week < b.week ? -1 : 1)),
    costs: { month, euros, budget_euros: budget, above_alert: above, by_plan: euroByPlan, per_signup_trial: trialSignups > 0 ? trialEuros / trialSignups : null },
    limits,
    guardrails,
  };
}
