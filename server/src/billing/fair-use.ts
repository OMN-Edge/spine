import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from 'spine-core/config.js';
import { logger } from 'spine-core/logger.js';
import type { PlanId } from 'spine-core/billing/plans.js';
import type { AccountsStore } from 'spine-core/store/types.js';

/**
 * The hidden fair-use ceilings (SECURITY.md **M-45**): what no use of an archive reaches and an abuse of an account does, so that one hostile account
 * costs a bounded amount. They are never shown (not in a response, a screen, an error or the pricing page) and are not in what a browser is
 * sent: they live here, on the server, and the operator changes them in a file without a release (`SPINE_FAIR_USE_FILE`, default `fair-use.json` in
 * the data directory), which is read again within half a minute. A plan the file does not name, or a value it gets wrong, keeps the built-in one.
 *
 * `monthly` is the burst guard, from the first day of the calendar month; `yearly` is the sustained one, over a window of twelve months (the billing year
 * of an annual subscription, the last twelve months otherwise) and counts questions, translated pages and the bytes links send. Link opens are monthly only.
 * On a plan with seats the numbers are the plan's, for the household.
 */
export interface MonthlyCeilings {
  /** Questions a month. */
  messages: number;
  /** Pages translated a month. */
  translatedPages: number;
  /** Times a month the links are opened. */
  linkViews: number;
  /** Bytes a month the links and the owner's own downloads send. */
  linkBytes: number;
  /** The cost ceiling on reading, as a multiple of what the plan's pages cost. */
  readingMultiple: number;
}
export interface YearlyCeilings { messages: number; translatedPages: number; linkBytes: number }
export interface FairUse { monthly: MonthlyCeilings; yearly: YearlyCeilings }
/** What the operator is told about, and at what: an account's AI cost in a month, and how near it is to a ceiling. */
export interface Watch { aiEurosPerMonth: number; fractionOfCeiling: number }
/** What a million tokens cost, in euros, for the estimate of what an account's AI use costs (a token is about four bytes of what is sent and returned). */
export interface Prices { inputPerMillionEur: number; outputPerMillionEur: number }

const GB = 1024 ** 3;
const PREMIUM: FairUse = {
  monthly: { messages: 600, translatedPages: 800, linkViews: 5000, linkBytes: 50 * GB, readingMultiple: 2 },
  yearly: { messages: 2400, translatedPages: 3000, linkBytes: 100 * GB },
};
const twice = (f: FairUse): FairUse => ({
  monthly: { ...f.monthly, messages: f.monthly.messages * 2, translatedPages: f.monthly.translatedPages * 2, linkViews: f.monthly.linkViews * 2, linkBytes: f.monthly.linkBytes * 2 },
  yearly: { messages: f.yearly.messages * 2, translatedPages: f.yearly.translatedPages * 2, linkBytes: f.yearly.linkBytes * 2 },
});
/** No ceiling: the trial's questions and translated pages have totals the person sees, which stop first. */
const NONE = 1e9;
export const DEFAULTS: Record<PlanId, FairUse> = {
  // The free plan has no questions and no translation, and its links are limited by the plan itself: only its reading has a ceiling.
  free: { monthly: { messages: 0, translatedPages: 0, linkViews: 0, linkBytes: 0, readingMultiple: 2 }, yearly: { messages: 0, translatedPages: 0, linkBytes: 0 } },
  // The trial counts questions and translated pages in visible totals, so it has no hidden ceiling for them; its pages read still do (twice its 150).
  trial: { monthly: { ...PREMIUM.monthly, messages: NONE, translatedPages: NONE }, yearly: { ...PREMIUM.yearly, messages: NONE, translatedPages: NONE } },
  // Essential asks questions but does not translate: no translated pages, and the same ceilings as Premium for the rest.
  essential: { monthly: { ...PREMIUM.monthly, translatedPages: 0 }, yearly: { ...PREMIUM.yearly, translatedPages: 0 } },
  premium: PREMIUM,
  family: twice(PREMIUM),
};
export const DEFAULT_WATCH: Watch = { aiEurosPerMonth: 15, fractionOfCeiling: 0.8 };
export const DEFAULT_PRICES: Prices = { inputPerMillionEur: 1.43, outputPerMillionEur: 8.61 };

export interface Loaded { fairUse: Record<PlanId, FairUse>; watch: Watch; prices: Prices }
let loaded: { at: number; mtime: number; value: Loaded } | null = null;
let checked = 0;

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * What the operator set on the admin page, kept in the database under one setting (`fair_use`, the same shape as the file) so it works where there is no
 * disk to put a file on (Cloud Run) and is the same for every instance. It is the last word: built-in values, then the file, then this. Read again at most
 * every half minute by whoever is about to apply a ceiling (`syncFairUse`, called by the relay's gate, the link routes and the report).
 */
export const DB_KEY = 'fair_use';
let overrides: unknown = null;
let overridesText = '';
let overridesAt = 0;
export async function syncFairUse(store: AccountsStore, now: number = Date.now()): Promise<void> {
  if (overridesAt && now - overridesAt < 30_000) return;
  overridesAt = now;
  const text = (await store.settings.all()).find(r => r.key === DB_KEY)?.value ?? '';
  if (text === overridesText) return;
  overridesText = text;
  try { overrides = text ? JSON.parse(text) : null; } catch { overrides = null; logger.warn('the fair-use settings of the admin page could not be read; the file and the built-in ceilings are used'); }
  loaded = null; checked = 0;
}
/** After a change from the admin page: this instance reads the database again at once (the others within half a minute). */
export const forgetFairUseOverrides = (): void => { overridesAt = 0; };

/** The file the operator writes, if there is one. */
export function fairUseFile(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.SPINE_FAIR_USE_FILE) return env.SPINE_FAIR_USE_FILE;
  try { return path.join(resolveDataDir(), 'fair-use.json'); } catch { return null; }
}

export function merge(base: Loaded, file: unknown): Loaded {
  const out: Loaded = JSON.parse(JSON.stringify(base));
  const raw = (file && typeof file === 'object' ? file : {}) as Record<string, unknown>;
  const fill = <T extends object>(into: T, from: unknown, where: string) => {
    if (!from || typeof from !== 'object') return;
    for (const [k, v] of Object.entries(from as Record<string, unknown>)) {
      if (k in into && positive(v)) (into as Record<string, number>)[k] = v;
      else logger.warn('a fair-use setting is not used', { setting: `${where}.${k}` });
    }
  };
  for (const plan of Object.keys(out.fairUse) as PlanId[]) {
    const p = raw[plan] as { monthly?: unknown; yearly?: unknown } | undefined;
    if (!p) continue;
    fill(out.fairUse[plan].monthly, p.monthly, `${plan}.monthly`);
    fill(out.fairUse[plan].yearly, p.yearly, `${plan}.yearly`);
  }
  fill(out.watch, raw.watch, 'watch');
  fill(out.prices, raw.prices, 'prices');
  return out;
}

function current(env: NodeJS.ProcessEnv = process.env): Loaded {
  const every = Number(env.SPINE_FAIR_USE_CHECK_MS ?? 30_000);
  const now = Date.now();
  if (loaded && now - checked < every) return loaded.value;
  checked = now;
  const file = fairUseFile(env);
  let mtime = 0;
  try { mtime = file ? fs.statSync(file).mtimeMs : 0; } catch { mtime = 0; }
  if (loaded && loaded.mtime === mtime) return loaded.value;
  let value: Loaded = { fairUse: DEFAULTS, watch: DEFAULT_WATCH, prices: DEFAULT_PRICES };
  if (file && mtime) {
    try { value = merge(value, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (err) { logger.warn('the fair-use file could not be read; the built-in ceilings are used', { reason: err instanceof Error ? err.message : String(err) }); }
  }
  if (overrides) value = merge(value, overrides);
  loaded = { at: now, mtime, value };
  return value;
}

export const fairUseOf = (plan: PlanId): FairUse => current().fairUse[plan];
export const watchOf = (): Watch => current().watch;
export const pricesOf = (): Prices => current().prices;
/** Tests: forget what was read, so the next call reads the file again. */
export function resetFairUse(): void { loaded = null; checked = 0; overrides = null; overridesText = ''; overridesAt = 0; }

/** What applies now (built-in, file and admin page together), and what the admin page itself has set, for the page that edits them. */
export function fairUseView(): { effective: Loaded; set: unknown } { return { effective: current(), set: overrides ?? {} }; }
