import type { AccountsStore } from 'spine-core/store/types.js';
import { watchOf } from './plans/fair-use.js';

/**
 * The settings the operator changes from the admin page, kept in the database (`operator_settings`) so they work on a host with no disk and change
 * without a release or a restart. Each has a default here, and the ones that had a variable keep it as the next fallback, so a deployment that set
 * one goes on as it was: **the admin page's value, else the variable, else the default**. Everything else stays in the environment: secrets, the
 * payment provider's prices, the model, the mailer, who may sign up and who is an administrator, which are not for a web page to change.
 * A value is checked against its bounds before it is kept; a value that is not a setting, or out of bounds, is refused.
 */
export interface SettingDef {
  key: string;
  /** What it is, in the words the admin page shows (English; the page is the operator's). */
  label: string;
  help: string;
  unit: 'count' | 'percent' | 'euros' | 'days';
  min: number;
  max: number;
  /** null: off unless set. */
  fallback: number | null;
  env?: string;
  /** Where the default comes from when it is not fixed: the fair-use file's, for the alert it already held. */
  fallbackOf?: () => number | null;
}

export const SETTINGS: readonly SettingDef[] = [
  { key: 'target.accounts', label: 'Sign-ups in the last 30 days', help: 'How many accounts you want made in any 30 days.', unit: 'count', min: 0, max: 10_000_000, fallback: 300 },
  { key: 'target.imported', label: 'Imported, share of sign-ups', help: 'Accounts that read 5 or more pages, as a share of all sign-ups.', unit: 'percent', min: 0, max: 100, fallback: 40 },
  { key: 'target.asked', label: 'Asked a question, share of sign-ups', help: 'Accounts that asked at least one question, as a share of all sign-ups.', unit: 'percent', min: 0, max: 100, fallback: 25 },
  { key: 'target.founding', label: 'Founding member places taken', help: 'How many of the 500 founding places you want taken by now.', unit: 'count', min: 0, max: 500, fallback: 25 },
  { key: 'ai.budget', label: 'Monthly AI budget', help: 'You are told at half, four fifths and all of it, once each, by mail to SPINE_ALERT_EMAIL. Empty: not watched.', unit: 'euros', min: 1, max: 1_000_000, fallback: null, env: 'SPINE_AI_BUDGET_EUR' },
  { key: 'ai.account_alert', label: 'AI cost of one account that needs a look', help: 'An account whose estimated AI cost in a month reaches this is reported and counted on the dashboard.', unit: 'euros', min: 1, max: 100_000, fallback: 15, fallbackOf: () => watchOf().aiEurosPerMonth },
  { key: 'mail.nudge_days', label: 'Days between reminders to add documents', help: 'The mail “Had an appointment lately?”, at most once in this many days. Empty: none.', unit: 'days', min: 7, max: 365, fallback: null, env: 'SPINE_NUDGE_DAYS' },
];

export type SettingKey = (typeof SETTINGS)[number]['key'];
export interface SettingView extends SettingDef { value: number | null; source: 'admin' | 'environment' | 'default'; updated_at: string | null }

const CACHE_MS = 30_000;
let cache: { at: number; rows: Map<string, { value: string; updated_at: string }> } | null = null;
/** Tests, and a change from the page: read the database again next time. */
export const forgetOperatorSettings = (): void => { cache = null; };

const inBounds = (def: SettingDef, n: number) => Number.isFinite(n) && n >= def.min && n <= def.max && (def.unit === 'euros' || Number.isInteger(n));

function envValue(def: SettingDef, env: NodeJS.ProcessEnv): number | null {
  if (!def.env) return null;
  const raw = env[def.env];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return inBounds(def, n) ? n : null;
}

/** Every setting, with the value that applies and where it comes from. */
export async function operatorSettings(store: AccountsStore, env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<SettingView[]> {
  if (!cache || now - cache.at > CACHE_MS) cache = { at: now, rows: new Map((await store.settings.all()).map(r => [r.key, { value: r.value, updated_at: r.updated_at }])) };
  return SETTINGS.map(def => {
    const row = cache!.rows.get(def.key);
    const stored = row ? Number(row.value) : NaN;
    if (row && inBounds(def, stored)) return { ...def, value: stored, source: 'admin' as const, updated_at: row.updated_at };
    const fromEnv = envValue(def, env);
    if (fromEnv !== null) return { ...def, value: fromEnv, source: 'environment' as const, updated_at: null };
    return { ...def, value: def.fallbackOf ? def.fallbackOf() : def.fallback, source: 'default' as const, updated_at: null };
  });
}

/** The value of one setting (null: off). */
export async function settingOf(store: AccountsStore, key: SettingKey, env: NodeJS.ProcessEnv = process.env): Promise<number | null> {
  return (await operatorSettings(store, env)).find(s => s.key === key)!.value;
}

/** Keeps a value the operator typed, or forgets it (null) so the variable or the default applies again. Answers what is wrong, or null. */
export async function changeSetting(store: AccountsStore, key: unknown, value: unknown, at: string): Promise<string | null> {
  const def = SETTINGS.find(s => s.key === key);
  if (!def) return 'not a setting';
  if (value === null) {
    await store.settings.clear(def.key);
  } else {
    const n = typeof value === 'number' ? value : NaN;
    if (!inBounds(def, n)) return `${def.label} must be ${def.unit === 'euros' ? 'an amount' : 'a whole number'} from ${def.min} to ${def.max}`;
    await store.settings.set(def.key, String(n), at);
  }
  forgetOperatorSettings();
  return null;
}
