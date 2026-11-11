import type { SubscriptionRecord } from '../store/types.js';

/**
 * What each plan includes, and the one function that says what an account has now. Pure: the relay, the routes and the account page all
 * ask it, so a limit is written once. Prices are Paddle's (the operator creates them there and names their ids in the environment); the
 * amounts here are what the page shows, and must match them (`docs/billing.md`).
 *
 * With billing off (`SPINE_BILLING`, the default, and every self-hosted instance) nothing here applies: `entitlementsOf` is not asked.
 */
export type PlanId = 'trial' | 'free' | 'premium' | 'family';
/** What a subscription can be for. */
export type PaidPlan = 'premium' | 'family';

/** A page of AI processing is 1000, so a call can cost a part of one and the totals stay whole numbers. */
export const PAGE = 1000;
export const TRIAL_MONTHS = 6;
/** The first this many paying accounts keep the founding price for as long as they stay subscribed. */
export const FOUNDING_LIMIT = 500;
/** A payment that failed leaves the account its plan this long (Paddle retries and reminds meanwhile). */
export const PAST_DUE_GRACE_DAYS = 7;
/** An account that left a family (or was removed) cannot take a seat in another for this long, so seats cannot be passed around; coming back to the same family is allowed. */
export const SEAT_COOLDOWN_DAYS = 30;
/** How long an invitation to a seat can be accepted. */
export const SEAT_INVITE_DAYS = 7;
/** Invitations that may wait at once. */
export const SEAT_INVITES_WAITING = 10;

export const PRICES = {
  premium: { year: 39, month: 3.99 },
  founding: { year: 29 },
  family: { year: 79, month: 7.99 },
  currency: 'EUR',
} as const;

/**
 * What the AI does is counted in meters a person can read, each an exact count of its own: **pages** read (`pages`: the pages of the documents
 * and images the model reads to make records, and nothing else), **messages** of chat (`messages`: a question is one, whatever number of steps the
 * assistant takes), **translated pages** (`translated`: the pages of a document translated into a language, once, a share link's too) and the
 * one-off pages for reading an archive (`import`). The model also makes smaller calls around them (the start and end of a document, stamps,
 * summaries, links, embeddings); they are not pages and are not counted as pages.
 *
 * **Only adding is limited**: the pages read (what puts a document in the archive), the archive import and the storage. Using what is in the archive is
 * not: a person who has added a document can ask about it and have it translated, for themselves or for a doctor abroad, as often as they need,
 * so `messages` and `translated` are counted (the account page shows them) and have no allowance. Behind them are hidden fair-use ceilings, high
 * enough that no use of an archive meets them and low enough that an abuse of an account, or an app that does not tell the truth about what it
 * sends, cannot make a plan pay for more than a bounded amount; they are not here, and not in what a browser is sent: the server holds them in its
 * configuration (`server/src/billing/fair-use.ts`). The cost meters (`reading`, `chat`, `translation`, in thousandths of one page of reading, the unit
 * of `taskCost`) are what they are counted in.
 */
export type Count = 'pages' | 'messages' | 'translated' | 'import';
export type Backstop = 'reading' | 'chat' | 'translation';
export type Meter = Count | Backstop;
/** What a person sees counted, in this order. */
export const COUNTS: readonly Count[] = ['pages', 'messages', 'translated', 'import'];
export type Allowances = Record<Meter, number>;
/** No allowance: the meter only counts. */
export const UNLIMITED = Number.POSITIVE_INFINITY;
/** What one page of reading, one message of chat and one translated page cost in the cost unit: how a ceiling in messages or pages is counted in cost. */
export const CHAT_MESSAGE = 800;
export const TRANSLATED_PAGE = 630;

export interface Entitlements {
  plan: PlanId;
  /** AI processing allowed in the period, for each meter. On a plan with seats this is the plan's, for every account that shares it. */
  allowance: Allowances;
  /** On a plan with seats: what one account of it may use of each meter, so that one cannot take the whole pool. Null: the allowance is the account's own. */
  memberCap: Allowances | null;
  /** `trial`: reading once, for the whole trial; `month`: a calendar month (UTC). Chat and translation are always by the month. */
  aiPeriod: 'trial' | 'month';
  /** How many months of the page allowance can be kept: what a month does not use carries into the next, up to this many months' worth (`billing/carry.ts`). One: nothing carries. */
  carryMonths: number;
  /** Bytes of sealed objects an account may keep (on a plan with seats, all its accounts together), or null for the instance's own ceiling (`vaultLimits`); never above that ceiling. */
  vaultBytes: number | null;
  /** Share links live at once (on a plan with seats, all its accounts together), or null for the instance's own ceiling (`sharedLimits`). Only the free plan limits it. */
  liveShares: number | null;
  /**
   * Times a month the share links of the account are opened (one is one fetch of a link's sealed copy), and bytes a month those links send to their
   * readers. Only the free plan limits them: on a paid plan a link is for whoever needs to read it, a doctor abroad included, and these are only
   * counted, behind a hidden ceiling the server holds. Past a limit the links stay live and open again at the next month;
   * an emergency card is never counted or stopped.
   */
  linkViews: number;
  linkBytes: number;
  /** Documents a person may keep, or null for no limit. Counted by the app, not the server, which cannot see into sealed records (`plan-limits.ts`). */
  documents: number | null;
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
  /**
   * People (profiles) whose records are kept apart: one's own, a child's, a parent's. On a plan with seats this is the plan's total across
   * every account that holds a seat, each account's own profile included.
   */
  profiles: number;
  /** Accounts that may share the plan, the one that pays included (a seat is an account, never a profile). */
  seats: number;
  /** Letting another account into a profile (a co-guardian, a parent's records). */
  delegation: boolean;
}

const GB = 1024 ** 3;

/**
 * The one-off allowance for reading an archive (`import`): extra pages of reading, once for the life of the account (not by the month), used
 * when the person says they are importing (the Upload page).
 */
export const IMPORT_PAGES = 250;
/** A paid plan keeps what a month does not use for this many months' worth of its allowance: a person who adds nothing for two months can add three months' worth in the third. */
export const CARRY_MONTHS = 3;

/**
 * Allowances from what a plan limits: the pages and the import. Using what was added (`messages`, `translated`) has none where the plan includes it at all (the
 * free plan does not), and the cost meters have none here: their ceilings are the server's to hold.
 */
const allowances = (c: { pages: number; import: number }, uses: boolean): Allowances => ({
  pages: c.pages, import: c.import, messages: uses ? UNLIMITED : 0, translated: uses ? UNLIMITED : 0,
  reading: UNLIMITED, chat: UNLIMITED, translation: UNLIMITED,
});
/** The Premium plan's allowances: also what one account of a plan with seats may add of the plan's (use is the plan's, not the account's). */
const PREMIUM_ALLOWANCE = allowances({ pages: 30, import: IMPORT_PAGES }, true);
const FAMILY_ACCOUNT: Allowances = PREMIUM_ALLOWANCE;

/**
 * The limits of each plan: "fair use" on the pricing page and in the plan's words. Raising one later is a gift; lowering one is not.
 */
export const PLANS: Record<PlanId, Omit<Entitlements, 'plan'>> = {
  // The trial has Premium's limits, with pages as one total for the whole trial.
  trial: { allowance: allowances({ pages: 150, import: 0 }, true), memberCap: null, aiPeriod: 'trial', carryMonths: 1, vaultBytes: 5 * GB, liveShares: null, linkViews: UNLIMITED, linkBytes: UNLIMITED, translation: true, chat: true, linking: true, related: true, approvalMode: true, profiles: 6, documents: null, seats: 1, delegation: true },
  free: { allowance: allowances({ pages: 10, import: 0 }, false), memberCap: null, aiPeriod: 'month', carryMonths: 1, vaultBytes: GB, liveShares: 1, linkViews: 20, linkBytes: GB, translation: false, chat: false, linking: false, related: false, approvalMode: false, profiles: 1, documents: 50, seats: 1, delegation: false },
  premium: { allowance: PREMIUM_ALLOWANCE, memberCap: null, aiPeriod: 'month', carryMonths: CARRY_MONTHS, vaultBytes: 5 * GB, liveShares: null, linkViews: UNLIMITED, linkBytes: UNLIMITED, translation: true, chat: true, linking: true, related: true, approvalMode: true, profiles: 1, documents: null, seats: 1, delegation: false },
  // Premium for up to six people, who may be children and may have accounts of their own: six accounts at most (the seats), six people in
  // all (each account's own included), and one pool for the lot (twice Premium's pages and 25 GB of storage, shared), with each account held
  // to Premium's pages. A larger plan would be another entry here.
  family: { allowance: allowances({ pages: 60, import: 2 * IMPORT_PAGES }, true), memberCap: FAMILY_ACCOUNT, aiPeriod: 'month', carryMonths: CARRY_MONTHS, vaultBytes: 25 * GB, liveShares: null, linkViews: UNLIMITED, linkBytes: UNLIMITED, translation: true, chat: true, linking: true, related: true, approvalMode: true, profiles: 6, documents: null, seats: 6, delegation: true },
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
  if (sub && subscriptionEntitles(sub, now)) return sub.plan;
  return now.getTime() < Date.parse(trialEnd(account.created_at)) ? 'trial' : 'free';
}

export function entitlementsOf(account: { created_at: string }, sub: SubscriptionRecord | null, now: Date): Entitlements {
  const plan = planOf(account, sub, now);
  return { plan, ...PLANS[plan] };
}

/** The key reading is counted under: the whole trial, or the calendar month. */
export const usagePeriod = (e: Pick<Entitlements, 'aiPeriod'>, now: Date): string => (e.aiPeriod === 'trial' ? 'trial' : now.toISOString().slice(0, 7));

/** The key a month's link views or bytes are counted under (`ai_usage.period`); on a plan with seats the pool's, under the account that pays. */
export const linkKey = (what: 'views' | 'egress', now: Date, pool = false): string => `${pool ? 'pool:' : ''}${now.toISOString().slice(0, 7)}:${what}`;

/**
 * The key a meter is counted under (`ai_usage.period`): the hidden cost ceiling of reading keeps the plain period it has always had (the
 * trial's, or the month); every other meter is by the month with its name after it, except the pages of the trial, which are one total
 * (`trial:pages`), and the import allowance, which is once (`once:import`, no month, so nothing forgets it). A plan's pool is the same key with
 * `pool:` before it, under the account that pays.
 */
export const meterKey = (meter: Meter, e: Pick<Entitlements, 'aiPeriod'>, now: Date, pool = false): string => {
  const month = now.toISOString().slice(0, 7);
  const key = meter === 'reading' ? usagePeriod(e, now) : meter === 'pages' ? `${usagePeriod(e, now)}:pages` : meter === 'import' ? 'once:import' : `${month}:${meter}`;
  return pool ? `pool:${key}` : key;
};

/** The tasks a relay runs, and the plan feature each needs (none: it is AI processing, which the allowance bounds). */
export type RelayTask = 'continuation' | 'extraction' | 'page' | 'pageThinking' | 'stamps' | 'translation' | 'linking' | 'grouping' | 'chat' | 'agent' | 'embed';

export const TASK_FEATURE: Record<RelayTask, 'translation' | 'chat' | 'linking' | 'related' | null> = {
  continuation: null, extraction: null, page: null, pageThinking: null, stamps: null, grouping: null,
  translation: 'translation', chat: 'chat', agent: 'chat', linking: 'linking', embed: 'related',
};

/** The hidden cost ceiling a task is counted against (every call is, whatever else counts it). */
export const TASK_METER: Record<RelayTask, Backstop> = {
  continuation: 'reading', extraction: 'reading', page: 'reading', pageThinking: 'reading', stamps: 'reading', grouping: 'reading', linking: 'reading', embed: 'reading',
  translation: 'translation', chat: 'chat', agent: 'chat',
};

/**
 * What a call is, to the counts a person sees: pages for a call that reads them (a page of a scan is one, a document's text is as many as it
 * has pages, said by the device and otherwise guessed from its size), translated pages for one that translates, and nothing for the rest.
 */
export const BYTES_PER_PAGE = { extraction: 3000, translation: 2048 } as const;

/**
 * What a call costs a meter, in thousandths of a page: a fixed part and a part for each kilobyte of the request (the relay sees the
 * request, so the size is not a claim the device makes). One unit is a thousandth of the cost of reading one page. **First guesses**, in
 * proportion to what the provider charges for what each task sends and returns; replace them with figures from the provider's usage logs.
 */
const COST: Record<RelayTask, { base: number; perKb: number }> = {
  extraction: { base: 100, perKb: 125 },
  page: { base: 1000, perKb: 0 },
  pageThinking: { base: 2000, perKb: 0 },
  stamps: { base: 200, perKb: 0 },
  continuation: { base: 150, perKb: 0 },
  grouping: { base: 300, perKb: 0 },
  linking: { base: 300, perKb: 0 },
  translation: { base: 30, perKb: 150 },
  chat: { base: 80, perKb: 22 },
  agent: { base: 80, perKb: 22 },
  embed: { base: 40, perKb: 0 },
};

export function taskCost(task: RelayTask, requestBytes: number): number {
  const c = COST[task];
  return Math.round(c.base + (c.perKb * requestBytes) / 1024);
}
