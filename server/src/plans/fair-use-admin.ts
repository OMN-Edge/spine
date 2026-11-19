import type { AccountsStore } from 'spine-core/store/types.js';
import { DB_KEY, DEFAULTS, DEFAULT_PRICES, DEFAULT_WATCH, fairUseView, forgetFairUseOverrides, syncFairUse } from './fair-use.js';

/**
 * Changing the hidden fair-use ceilings from the admin page (`plans/fair-use.ts` says what they are and why they are hidden): an **administrator
 * only**, never the marketing role, and the numbers are never sent to anyone else. A change names one value by its path (`premium.monthly.messages`,
 * `watch.fractionOfCeiling`, `prices.inputPerMillionEur`) and is checked against the values that exist and a bound before it is kept in the database,
 * where the instances read it within half a minute. Forgetting a value (null) gives back the file's or the built-in one.
 */
const PLANS = ['trial', 'free', 'essential', 'premium', 'family'] as const;
const MAX = 1e13;

export interface FairUseRow { path: string; label: string; unit: 'count' | 'bytes' | 'multiple' | 'fraction' | 'euros'; value: number; builtin: number; source: 'admin' | 'file or default' }
export interface FairUseSection { title: string; rows: FairUseRow[] }

const LABELS: Record<string, [string, FairUseRow['unit']]> = {
  'monthly.messages': ['Questions a month', 'count'],
  'monthly.translatedPages': ['Translated pages a month', 'count'],
  'monthly.linkViews': ['Link opens a month', 'count'],
  'monthly.linkBytes': ['Link traffic a month', 'bytes'],
  'monthly.readingMultiple': ['Pages read: times what the plan allows', 'multiple'],
  'yearly.messages': ['Questions in 12 months', 'count'],
  'yearly.translatedPages': ['Translated pages in 12 months', 'count'],
  'yearly.linkBytes': ['Link traffic in 12 months', 'bytes'],
};
const PLAN_NAMES: Record<string, string> = { trial: 'Trial', free: 'Free', essential: 'Essential', premium: 'Premium (and Founding)', family: 'Family (the household)' };

const at = (o: unknown, path: string[]): unknown => path.reduce<unknown>((x, k) => (x && typeof x === 'object' ? (x as Record<string, unknown>)[k] : undefined), o);

export function fairUseSections(): FairUseSection[] {
  const { effective, set } = fairUseView();
  const sections: FairUseSection[] = PLANS.map(plan => ({
    title: PLAN_NAMES[plan]!,
    rows: Object.entries(LABELS).map(([k, [label, unit]]) => {
      const path = [plan, ...k.split('.')];
      return { path: path.join('.'), label, unit, value: at(effective.fairUse, path) as number, builtin: at(DEFAULTS, path) as number, source: typeof at(set, path) === 'number' ? 'admin' as const : 'file or default' as const };
    }),
  }));
  const one = (path: string[], label: string, unit: FairUseRow['unit'], eff: unknown, builtin: unknown): FairUseRow => ({ path: path.join('.'), label, unit, value: eff as number, builtin: builtin as number, source: typeof at(set, path) === 'number' ? 'admin' : 'file or default' });
  sections.push({ title: 'Alerts and the cost estimate', rows: [
    one(['watch', 'fractionOfCeiling'], 'Tell me at this share of a ceiling', 'fraction', effective.watch.fractionOfCeiling, DEFAULT_WATCH.fractionOfCeiling),
    one(['prices', 'inputPerMillionEur'], 'Price of a million tokens sent to the model', 'euros', effective.prices.inputPerMillionEur, DEFAULT_PRICES.inputPerMillionEur),
    one(['prices', 'outputPerMillionEur'], 'Price of a million tokens it answers with', 'euros', effective.prices.outputPerMillionEur, DEFAULT_PRICES.outputPerMillionEur),
  ] });
  return sections;
}

/** Whether a path names a value that exists, and the bound it must keep. */
function boundOf(path: unknown): { path: string[]; max: number; min: number } | null {
  if (typeof path !== 'string' || path.length > 80) return null;
  const parts = path.split('.');
  if (parts[0] === 'watch' && parts.length === 2 && parts[1] === 'fractionOfCeiling') return { path: parts, min: 0.05, max: 1 };
  if (parts[0] === 'prices' && parts.length === 2 && (parts[1] === 'inputPerMillionEur' || parts[1] === 'outputPerMillionEur')) return { path: parts, min: 0, max: 1000 };
  if (parts.length === 3 && (PLANS as readonly string[]).includes(parts[0]!) && `${parts[1]}.${parts[2]}` in LABELS) return { path: parts, min: 0, max: parts[2] === 'readingMultiple' ? 100 : MAX };
  return null;
}

/** Keeps one value (or forgets it with null). Answers what is wrong, or null. */
export async function changeFairUse(store: AccountsStore, path: unknown, value: unknown, now: string): Promise<string | null> {
  const bound = boundOf(path);
  if (!bound) return 'not a fair-use value';
  if (value !== null && !(typeof value === 'number' && Number.isFinite(value) && value >= bound.min && value <= bound.max)) return `must be a number from ${bound.min} to ${bound.max}`;
  let doc: Record<string, unknown> = {};
  try { const text = (await store.settings.all()).find(r => r.key === DB_KEY)?.value; if (text) doc = JSON.parse(text) as Record<string, unknown>; } catch { doc = {}; }
  // Walk to the leaf, making the objects on the way, and set or remove it; empty objects left behind are dropped.
  const chain: Array<[Record<string, unknown>, string]> = [];
  let node = doc;
  for (const k of bound.path.slice(0, -1)) {
    if (!node[k] || typeof node[k] !== 'object') node[k] = {};
    chain.push([node, k]);
    node = node[k] as Record<string, unknown>;
  }
  const leaf = bound.path[bound.path.length - 1]!;
  if (value === null) delete node[leaf]; else node[leaf] = value;
  for (const [parent, k] of chain.reverse()) if (Object.keys(parent[k] as object).length === 0) delete parent[k];
  if (Object.keys(doc).length === 0) await store.settings.clear(DB_KEY); else await store.settings.set(DB_KEY, JSON.stringify(doc), now);
  forgetFairUseOverrides();
  await syncFairUse(store);
  return null;
}
