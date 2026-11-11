import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from 'spine-core/config.js';
import { logger } from 'spine-core/logger.js';
import type { PlanId } from 'spine-core/billing/plans.js';

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
const DEFAULTS: Record<PlanId, FairUse> = {
  // The free plan has no questions and no translation, and its links are limited by the plan itself: only its reading has a ceiling.
  free: { monthly: { messages: 0, translatedPages: 0, linkViews: 0, linkBytes: 0, readingMultiple: 2 }, yearly: { messages: 0, translatedPages: 0, linkBytes: 0 } },
  trial: PREMIUM,
  premium: PREMIUM,
  family: twice(PREMIUM),
};
const DEFAULT_WATCH: Watch = { aiEurosPerMonth: 15, fractionOfCeiling: 0.8 };
const DEFAULT_PRICES: Prices = { inputPerMillionEur: 1.43, outputPerMillionEur: 8.61 };

interface Loaded { fairUse: Record<PlanId, FairUse>; watch: Watch; prices: Prices }
let loaded: { at: number; mtime: number; value: Loaded } | null = null;
let checked = 0;

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** The file the operator writes, if there is one. */
export function fairUseFile(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.SPINE_FAIR_USE_FILE) return env.SPINE_FAIR_USE_FILE;
  try { return path.join(resolveDataDir(), 'fair-use.json'); } catch { return null; }
}

function merge(base: Loaded, file: unknown): Loaded {
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
  loaded = { at: now, mtime, value };
  return value;
}

export const fairUseOf = (plan: PlanId): FairUse => current().fairUse[plan];
export const watchOf = (): Watch => current().watch;
export const pricesOf = (): Prices => current().prices;
/** Tests: forget what was read, so the next call reads the file again. */
export function resetFairUse(): void { loaded = null; checked = 0; }
