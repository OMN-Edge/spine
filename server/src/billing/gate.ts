import type { AccountsStore } from 'spine-core/store/types.js';
import { BYTES_PER_PAGE, CHAT_MESSAGE, PAGE, TRANSLATED_PAGE, linkKey, meterKey, taskCost, TASK_FEATURE, TASK_METER, type Count, type Entitlements, type Meter, type RelayTask } from 'spine-core/billing/plans.js';
import { standingOf, type Standing } from './seat.js';
import { fairUseOf, type FairUse } from './fair-use.js';
import { windowMonths } from './window.js';
import { FAMILY_OF, costKey, microEuros, tokenKey } from './cost.js';
import { watchAccount } from './watch.js';

/** What is said when a hidden ceiling stops an action: neutral, and never with a number. */
export const FAIR_USE_MESSAGE = 'This account has reached its fair-use limit, contact support';
export interface Refusal { status: number; error: string; code: 'plan_required' | 'allowance_used' | 'fair_use' }

export interface RelayCall {
  /** The random id the device gives every call of one piece of work (a chat question, a document's translation), so it is counted once. */
  work?: string | null;
  /** How many pages the call reads or translates, as the device says; otherwise guessed from the size of the request. */
  pages?: number | null;
  /** The person said they are importing an archive (`x-spine-import`): reading is drawn from the one-off import allowance while it lasts. */
  bulk?: boolean;
  /** Bytes the relay answered with, for the estimate of what the call cost. */
  outBytes?: number;
}

/**
 * What the relay asks before it runs a task and tells after (`relay.ts`): whether the account's plan includes it and has room left, and what the
 * call cost. The relay sees the request, so the cost is measured, not claimed. Off, the relay has no gate and nothing here runs.
 *
 * **Only adding is limited** (`billing/plans.ts`): the pages read are counted exactly and stop at the plan's allowance (`pages`), and, while it lasts,
 * an archive import draws from its own one-off allowance (`import`); the small calls around reading are not pages and are not counted as pages. **Using is
 * not**: a chat question counts once (`messages`, whatever number of calls it takes) and a document's translation counts its pages once (`translated`), a
 * share link's included, and both are counted and never refused for want of an allowance. Behind the counts are the hidden fair-use ceilings
 * (`billing/fair-use.ts`, in the operator's configuration, never shown): a monthly one for each kind of work, as a cost, and a yearly one for questions and
 * translated pages, over the twelve months of the billing year or the last twelve. Past one the action is refused, that one only, with a neutral message
 * and no number, and nothing is quietly made worse: the model is the same at every volume.
 *
 * On a plan with seats a call is counted twice, in the plan's pool (under the account that pays) and in the account's own meter, and refused when
 * either is used up: the pool is what the plan has, the account's own is the cap that keeps one account from adding all of it (SECURITY.md **M-52**).
 * A share's translation is the owner's translation; a share's other calls are bounded by the share's own daily count.
 *
 * A call is checked before and charged after it succeeds, so a failed call costs nothing; several in flight at once can each pass the check
 * and overshoot an allowance by a few calls, which is bounded by the relay's own daily count and is the right way round for the person.
 */
export interface RelayGate {
  admit(subject: string, task: RelayTask, call?: RelayCall): Promise<Refusal | null>;
  settle(subject: string, task: RelayTask, requestBytes: number, call?: RelayCall): Promise<void>;
}

interface Counter { user: string; key: string; limit: number; hidden: boolean }

/** The cost a ceiling in messages or pages comes to, in the cost unit, and a plan's own page allowance's. */
function limitOf(e: Entitlements, fair: FairUse, meter: Meter, account: boolean): number {
  const m = fair.monthly;
  if (meter === 'reading') return (account && e.memberCap ? e.memberCap.pages : e.allowance.pages) * PAGE * m.readingMultiple;
  if (meter === 'chat') return account && e.memberCap ? Infinity : m.messages * CHAT_MESSAGE;
  if (meter === 'translation') return account && e.memberCap ? Infinity : m.translatedPages * TRANSLATED_PAGE;
  return account && e.memberCap ? e.memberCap[meter] : e.allowance[meter];
}

/** The keys a call is counted under, and what each may hold: the account's own meter, and the plan's pool where the plan has seats. */
function countersOf(e: Entitlements, fair: FairUse, meter: Meter, userId: string, holder: string, now: Date): Counter[] {
  const hidden = meter === 'reading' || meter === 'chat' || meter === 'translation';
  if (!e.memberCap) return [{ user: userId, key: meterKey(meter, e, now), limit: limitOf(e, fair, meter, false), hidden }];
  return [
    { user: userId, key: meterKey(meter, e, now), limit: limitOf(e, fair, meter, true), hidden },
    { user: holder, key: meterKey(meter, e, now, true), limit: limitOf(e, fair, meter, false), hidden },
  ];
}

/** What a call adds to the pages a person sees: pages read, said by the device or guessed from the size; a page of a scan is one. */
function pagesOf(task: RelayTask, call: RelayCall, requestBytes: number): number {
  if (task === 'page') return 1;
  if (task !== 'extraction' && task !== 'translation') return 0;
  const said = call.pages && Number.isInteger(call.pages) && call.pages > 0 ? call.pages : 0;
  return said || Math.max(1, Math.ceil(requestBytes / BYTES_PER_PAGE[task]));
}

/** The keys of the months a yearly ceiling counts over, for a count a plan keeps in its pool or an account keeps alone. */
const yearKeys = (what: 'messages' | 'translated' | 'egress', standing: Standing, now: Date): string[] =>
  windowMonths(standing.subscription, now).map(month => (what === 'egress' ? linkKey('egress', new Date(`${month}-15T00:00:00Z`), standing.seat !== 'none') : meterKey(what, standing.entitlements, new Date(`${month}-15T00:00:00Z`), !!standing.entitlements.memberCap)));

export function createRelayGate(store: () => AccountsStore, now: () => Date = () => new Date()): RelayGate {
  // A share's recipient has no account; the plan that counts is its owner's, for the features only (the share's own daily count bounds the cost).
  const ownerOf = async (subject: string): Promise<{ userId: string; share: boolean } | null> => {
    if (subject.startsWith('demo:')) return null;
    if (subject.startsWith('share:')) {
      const bundle = await store().shared.get(subject.slice('share:'.length));
      return bundle ? { userId: bundle.userId, share: true } : null;
    }
    return { userId: subject, share: false };
  };

  /** The key a piece of work is remembered under: its id and the hour, so an id a dishonest device reuses is counted again each hour rather than never (the cost ceilings bound what is left). */
  const workKey = (work: string): string => `w:${work}:${now().toISOString().slice(0, 13)}`;
  const hasRoom = async (c: Counter): Promise<boolean> => (await store().usage.aiUsed(c.user, c.key)) < c.limit;
  const add = async (e: Entitlements, fair: FairUse, meter: Meter, userId: string, holder: string, amount: number) => {
    for (const c of countersOf(e, fair, meter, userId, holder, now())) await store().usage.aiAdd(c.user, c.key, amount);
  };
  const used = { status: 402, error: 'the plan’s AI processing is used up', code: 'allowance_used' } as const;
  const fairUseRefusal = { status: 402, error: FAIR_USE_MESSAGE, code: 'fair_use' } as const;
  const roomIn = async (e: Entitlements, fair: FairUse, meter: Meter, userId: string, holder: string): Promise<Refusal | null> => {
    for (const c of countersOf(e, fair, meter, userId, holder, now())) if (!(await hasRoom(c))) return c.hidden ? fairUseRefusal : used;
    return null;
  };

  /** The count a task adds to, when it is one a person sees counted. */
  const countOf = (task: RelayTask): Count | null => (task === 'extraction' || task === 'page' ? 'pages' : task === 'translation' ? 'translated' : task === 'chat' || task === 'agent' ? 'messages' : null);

  return {
    async admit(subject, task, call = {}) {
      const who = await ownerOf(subject);
      if (!who) return null;
      const standing = await standingOf(store(), who.userId, now());
      if (!standing) return null;
      const e = standing.entitlements;
      const fair = fairUseOf(e.plan);
      const feature = TASK_FEATURE[task];
      if (feature && !e[feature]) return { status: 402, error: 'this is not part of the account’s plan', code: 'plan_required' };
      const backstop = TASK_METER[task];
      if (who.share && backstop !== 'translation') return null;
      // The monthly ceiling of this kind of work: refused only past what no use of an archive reaches.
      const monthly = await roomIn(e, fair, backstop, who.userId, standing.holder);
      if (monthly) return monthly;
      const count = countOf(task);
      // Adding is limited: a page is read while the plan, or an import in progress, has pages left. Using is counted and not limited by the plan.
      if (count === 'pages') {
        const importing = !!call.bulk && e.allowance.import > 0 && !(await roomIn(e, fair, 'import', who.userId, standing.holder));
        if (!importing) { const pages = await roomIn(e, fair, 'pages', who.userId, standing.holder); if (pages) return pages; }
      }
      // The yearly ceiling on questions and translated pages, over the billing year or the last twelve months; a question or translation already begun is finished.
      if (count === 'messages' || count === 'translated') {
        const begun = !!call.work && (await store().usage.seen(who.userId, workKey(call.work)));
        if (!begun) {
          const pooled = !!e.memberCap;
          const holder = pooled ? standing.holder : who.userId;
          const sum = await store().usage.aiUsedMany(holder, yearKeys(count === 'messages' ? 'messages' : 'translated', standing, now()));
          if (sum >= (count === 'messages' ? fair.yearly.messages : fair.yearly.translatedPages)) return fairUseRefusal;
        }
      }
      return null;
    },

    async settle(subject, task, requestBytes, call = {}) {
      const who = await ownerOf(subject);
      if (!who) return;
      const backstop = TASK_METER[task];
      if (who.share && backstop !== 'translation') return;
      const standing = await standingOf(store(), who.userId, now());
      if (!standing) return;
      const e = standing.entitlements;
      const fair = fairUseOf(e.plan);
      await add(e, fair, backstop, who.userId, standing.holder, taskCost(task, requestBytes));
      const count = countOf(task);
      if (count === 'pages') {
        // An import's pages are charged to the import allowance while it has room, and to the month's pages when it has not.
        const importing = !!call.bulk && e.allowance.import > 0 && !(await roomIn(e, fair, 'import', who.userId, standing.holder));
        await add(e, fair, importing ? 'import' : 'pages', who.userId, standing.holder, pagesOf(task, call, requestBytes));
      } else if (count === 'translated' || count === 'messages') {
        // Counted once for a piece of work however many calls it takes: the first call of an id counts, the others do not; no id, every call.
        const first = !call.work || (await store().usage.see(who.userId, workKey(call.work), now().toISOString()));
        if (first) await add(e, fair, count, who.userId, standing.holder, count === 'messages' ? 1 : pagesOf(task, call, requestBytes));
      }
      // What the call cost, as an estimate, by kind of work: the numbers the plans' prices are to be checked against, and what the operator is told by.
      const month = now().toISOString().slice(0, 7);
      const { tokens, micro } = microEuros(requestBytes, call.outBytes ?? 0);
      const family = FAMILY_OF[task];
      await store().usage.aiAdd(who.userId, costKey(family, month), micro);
      await store().usage.aiAdd(who.userId, tokenKey(family, month), tokens);
      void watchAccount(store(), who.userId, standing, now()).catch(() => undefined);
    },
  };
}
