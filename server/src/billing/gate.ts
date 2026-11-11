import type { AccountsStore } from 'spine-core/store/types.js';
import { BYTES_PER_PAGE, taskCost, meterKey, TASK_FEATURE, TASK_METER, type Count, type Entitlements, type Meter, type RelayTask } from 'spine-core/billing/plans.js';
import { standingOf } from './seat.js';

export interface Refusal { status: number; error: string; code: 'plan_required' | 'allowance_used' }

export interface RelayCall {
  /** The random id the device gives every call of one piece of work (a chat question, a document's translation), so it is counted once. */
  work?: string | null;
  /** How many pages the call reads or translates, as the device says; otherwise guessed from the size of the request. */
  pages?: number | null;
  /** The person said they are importing an archive (`x-spine-import`): reading is drawn from the one-off import allowance while it lasts. */
  bulk?: boolean;
}

/**
 * What the relay asks before it runs a task and tells after (`relay.ts`): whether the account's plan includes it and has room left, and what the
 * call cost. The relay sees the request, so the cost is measured, not claimed. Off, the relay has no gate and nothing here runs.
 *
 * **Only adding is limited** (`billing/plans.ts`): the pages read are counted exactly and stop at the plan's allowance (`pages`), and, while it lasts,
 * an archive import draws from its own one-off allowance (`import`); the small calls around reading (a document's start and end, stamps, summaries,
 * links, embeddings) are not pages and are not counted as pages. **Using is not**: a chat question counts once (`messages`, whatever number of calls it
 * takes) and a document's translation counts its pages once (`translated`), a share link's included, and both are counted for the account page
 * and never refused for want of an allowance. What backs the counts is a cost ceiling for each kind of work, high enough that no use of an
 * archive meets it (`reading`, `chat`, `translation`), refused only past it, which bounds what an app that does not tell the truth can spend.
 *
 * On a plan with seats a call is counted twice, in the plan's pool (under the account that pays) and in the account's own meter, and refused when
 * either is used up: the pool is what the plan has, the account's own is the cap that keeps one account from adding all of it (SECURITY.md
 * **M-52**). A share's translation is the owner's translation; a share's other calls are bounded by the share's own daily count.
 *
 * A call is checked before and charged after it succeeds, so a failed call costs nothing; several in flight at once can each pass the check
 * and overshoot an allowance by a few calls, which is bounded by the relay's own daily count and is the right way round for the person.
 */
export interface RelayGate {
  admit(subject: string, task: RelayTask, call?: RelayCall): Promise<Refusal | null>;
  settle(subject: string, task: RelayTask, requestBytes: number, call?: RelayCall): Promise<void>;
}

/** The keys a call is counted under, and what each may hold: the account's own meter, and the plan's pool where the plan has seats. */
function countersOf(e: Entitlements, meter: Meter, userId: string, holder: string, now: Date): Array<{ user: string; key: string; limit: number }> {
  if (!e.memberCap) return [{ user: userId, key: meterKey(meter, e, now), limit: e.allowance[meter] }];
  return [
    { user: userId, key: meterKey(meter, e, now), limit: e.memberCap[meter] },
    { user: holder, key: meterKey(meter, e, now, true), limit: e.allowance[meter] },
  ];
}

/** What a call adds to the pages a person sees: pages read, said by the device or guessed from the size; a page of a scan is one. */
function pagesOf(task: RelayTask, call: RelayCall, requestBytes: number): number {
  if (task === 'page') return 1;
  if (task !== 'extraction' && task !== 'translation') return 0;
  const said = call.pages && Number.isInteger(call.pages) && call.pages > 0 ? call.pages : 0;
  return said || Math.max(1, Math.ceil(requestBytes / BYTES_PER_PAGE[task]));
}

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

  /** Whether every counter of a meter (the account's own, and the plan's pool) still has room. */
  const hasRoom = async (e: Entitlements, meter: Meter, userId: string, holder: string): Promise<boolean> => {
    for (const c of countersOf(e, meter, userId, holder, now())) if ((await store().usage.aiUsed(c.user, c.key)) >= c.limit) return false;
    return true;
  };
  const add = async (e: Entitlements, meter: Meter, userId: string, holder: string, amount: number) => {
    for (const c of countersOf(e, meter, userId, holder, now())) await store().usage.aiAdd(c.user, c.key, amount);
  };
  const used = { status: 402, error: 'the plan’s AI processing is used up', code: 'allowance_used' } as const;

  /** The count a task adds to, when it is one a person sees counted. */
  const countOf = (task: RelayTask): Count | null => (task === 'extraction' || task === 'page' ? 'pages' : task === 'translation' ? 'translated' : task === 'chat' || task === 'agent' ? 'messages' : null);

  return {
    async admit(subject, task, call = {}) {
      const who = await ownerOf(subject);
      if (!who) return null;
      const standing = await standingOf(store(), who.userId, now());
      if (!standing) return null;
      const e = standing.entitlements;
      const feature = TASK_FEATURE[task];
      if (feature && !e[feature]) return { status: 402, error: 'this is not part of the account’s plan', code: 'plan_required' };
      const backstop = TASK_METER[task];
      if (who.share && backstop !== 'translation') return null;
      // The ceiling behind the counts: refused only past what no use of an archive reaches.
      if (!(await hasRoom(e, backstop, who.userId, standing.holder))) return used;
      const count = countOf(task);
      // Adding is limited: a page is read while the plan, or an import in progress, has pages left. Using is counted and not limited (infinite allowance).
      if (count === 'pages') {
        const importing = !!call.bulk && e.allowance.import > 0 && (await hasRoom(e, 'import', who.userId, standing.holder));
        if (!importing && !(await hasRoom(e, 'pages', who.userId, standing.holder))) return used;
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
      await add(e, backstop, who.userId, standing.holder, taskCost(task, requestBytes));
      const count = countOf(task);
      if (count === 'pages') {
        // An import's pages are charged to the import allowance while it has room, and to the month's pages when it has not.
        const importing = !!call.bulk && e.allowance.import > 0 && (await hasRoom(e, 'import', who.userId, standing.holder));
        await add(e, importing ? 'import' : 'pages', who.userId, standing.holder, pagesOf(task, call, requestBytes));
      } else if (count === 'translated' || count === 'messages') {
        // Counted once for a piece of work however many calls it takes: the first call of an id counts, the others do not; no id, every call.
        const first = !call.work || (await store().usage.see(who.userId, `w:${call.work}`, now().toISOString()));
        if (first) await add(e, count, who.userId, standing.holder, count === 'messages' ? 1 : pagesOf(task, call, requestBytes));
      }
    },
  };
}
