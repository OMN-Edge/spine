import type { SubscriptionRecord } from '../store/types.js';

/**
 * What each plan includes, and the one function that says what an account has now. Pure: the relay, the routes and the account page all
 * ask it, so a limit is written once. Prices are Paddle's (the operator creates them there and names their ids in the environment); the
 * amounts here are what the page shows, and must match them (`docs/billing.md`).
 *
 * With billing off (`SPINE_BILLING`, the default, and every self-hosted instance) nothing here applies: `entitlementsOf` is not asked.
 */
export type PlanId = 'trial' | 'free' | 'premium';

/** A page of AI processing is 1000, so a call can cost a part of one and the totals stay whole numbers. */
export const PAGE = 1000;
export const TRIAL_MONTHS = 6;
/** The first this many paying accounts keep the founding price for as long as they stay subscribed. */
export const FOUNDING_LIMIT = 500;
/** A payment that failed leaves the account its plan this long (Paddle retries and reminds meanwhile). */
export const PAST_DUE_GRACE_DAYS = 7;

export const PRICES = {
  premium: { year: 39, month: 3.99 },
  founding: { year: 29 },
  currency: 'EUR',
} as const;

export interface Entitlements {
  plan: PlanId;
  /** AI processing allowed in the period, in thousandths of a page. */
  aiAllowance: number;
  /** `trial`: once, for the whole trial; `month`: a calendar month (UTC). */
  aiPeriod: 'trial' | 'month';
  /** Bytes of sealed objects an account may keep, or null for the instance's own ceiling (`vaultLimits`). */
  vaultBytes: number | null;
  /** Share links live at once, or null for the instance's own ceiling (`sharedLimits`). */
  liveShares: number | null;
  /** Translating documents, for the owner and for a share's recipient. */
  translation: boolean;
  /** Asking questions of the records (the assistant), and a share's chat. */
  chat: boolean;
  /** Looking for connections between documents. */
  linking: boolean;
  /** Related documents by meaning (embeddings). */
  related: boolean;
  /** A share link that waits for the owner to approve a visitor. */
  approvalMode: boolean;
  /** People (profiles) whose records the account keeps apart: one's own, a child's, a parent's. */
  profiles: number;
}

const GB = 1024 ** 3;

export const PLANS: Record<PlanId, Omit<Entitlements, 'plan'>> = {
  trial: { aiAllowance: 150 * PAGE, aiPeriod: 'trial', vaultBytes: null, liveShares: null, translation: true, chat: true, linking: true, related: true, approvalMode: true, profiles: 6 },
  free: { aiAllowance: 30 * PAGE, aiPeriod: 'month', vaultBytes: GB, liveShares: 1, translation: false, chat: false, linking: false, related: false, approvalMode: false, profiles: 1 },
  // "Unlimited (fair use)": a ceiling no ordinary use meets and a stuck loop does.
  premium: { aiAllowance: 4000 * PAGE, aiPeriod: 'month', vaultBytes: null, liveShares: null, translation: true, chat: true, linking: true, related: true, approvalMode: true, profiles: 1 },
};

const addMonths = (iso: string, months: number): Date => {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
};

export const trialEnd = (accountCreatedAt: string): string => addMonths(accountCreatedAt, TRIAL_MONTHS).toISOString();

/** Whether a subscription gives the paid plan at `now`: running, late within the grace, or cancelled but paid up to a date still ahead. */
export function subscriptionEntitles(sub: SubscriptionRecord | null, now: Date): boolean {
  if (!sub) return false;
  const end = sub.current_period_end ? Date.parse(sub.current_period_end) : null;
  if (sub.status === 'active' || sub.status === 'trialing') return end === null || end + 24 * 3600e3 > now.getTime();
  if (sub.status === 'past_due') return end === null || end + PAST_DUE_GRACE_DAYS * 24 * 3600e3 > now.getTime();
  // Cancelled (or paused) keeps what was paid for.
  return end !== null && end > now.getTime();
}

export function planOf(account: { created_at: string }, sub: SubscriptionRecord | null, now: Date): PlanId {
  if (subscriptionEntitles(sub, now)) return 'premium';
  return now.getTime() < Date.parse(trialEnd(account.created_at)) ? 'trial' : 'free';
}

export function entitlementsOf(account: { created_at: string }, sub: SubscriptionRecord | null, now: Date): Entitlements {
  const plan = planOf(account, sub, now);
  return { plan, ...PLANS[plan] };
}

/** The key AI usage is counted under: the whole trial, or the calendar month. */
export const usagePeriod = (e: Pick<Entitlements, 'aiPeriod'>, now: Date): string => (e.aiPeriod === 'trial' ? 'trial' : now.toISOString().slice(0, 7));

/** The tasks a relay runs, and the plan feature each needs (none: it is AI processing, which the allowance bounds). */
export type RelayTask = 'continuation' | 'extraction' | 'page' | 'pageThinking' | 'stamps' | 'translation' | 'linking' | 'grouping' | 'chat' | 'agent' | 'embed';

export const TASK_FEATURE: Record<RelayTask, 'translation' | 'chat' | 'linking' | 'related' | null> = {
  continuation: null, extraction: null, page: null, pageThinking: null, stamps: null, grouping: null,
  translation: 'translation', chat: 'chat', agent: 'chat', linking: 'linking', embed: 'related',
};

/**
 * What a call costs the allowance, in thousandths of a page: a fixed part and a part for each kilobyte of the request (the relay sees the
 * request, so the size is not a claim the device makes). **First guesses**: a page of reading is about two and a half thousand tokens in
 * and a thousand and a half out (`docs/billing.md`); replace these with figures from the provider's usage logs once there are any.
 */
const COST: Record<RelayTask, { base: number; perKb: number }> = {
  extraction: { base: 100, perKb: 125 },
  page: { base: 1000, perKb: 0 },
  pageThinking: { base: 2000, perKb: 0 },
  stamps: { base: 200, perKb: 0 },
  continuation: { base: 150, perKb: 0 },
  grouping: { base: 300, perKb: 0 },
  linking: { base: 300, perKb: 0 },
  translation: { base: 100, perKb: 100 },
  chat: { base: 50, perKb: 25 },
  agent: { base: 50, perKb: 25 },
  embed: { base: 40, perKb: 0 },
};

export function taskCost(task: RelayTask, requestBytes: number): number {
  const c = COST[task];
  return Math.round(c.base + (c.perKb * requestBytes) / 1024);
}
