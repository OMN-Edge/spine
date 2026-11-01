import type { AccountsStore } from 'spine-core/store/types.js';
import { entitlementsOf, taskCost, TASK_FEATURE, usagePeriod, type RelayTask } from 'spine-core/billing/plans.js';

export interface Refusal { status: number; error: string; code: 'plan_required' | 'allowance_used' }

/**
 * What the relay asks before it runs a task and tells after (`relay.ts`): whether the account's plan includes it and has allowance left,
 * and what the call cost. The relay sees the request, so the cost is measured, not claimed. Off, the relay has no gate and nothing here runs.
 *
 * A call is checked before and charged after it succeeds, so a failed call costs nothing; several in flight at once can each pass the check
 * and overshoot an allowance by a few calls, which is bounded by the relay's own daily count and is the right way round for the person.
 */
export interface RelayGate {
  admit(subject: string, task: RelayTask): Promise<Refusal | null>;
  settle(subject: string, task: RelayTask, requestBytes: number): Promise<void>;
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

  return {
    async admit(subject, task) {
      const who = await ownerOf(subject);
      if (!who) return null;
      const user = await store().users.findById(who.userId);
      if (!user) return null;
      const e = entitlementsOf(user, await store().billing.get(who.userId), now());
      const feature = TASK_FEATURE[task];
      if (feature && !e[feature]) return { status: 402, error: 'this is not part of the account’s plan', code: 'plan_required' };
      if (who.share) return null;
      if ((await store().usage.aiUsed(who.userId, usagePeriod(e, now()))) >= e.aiAllowance) return { status: 402, error: 'the plan’s AI processing is used up', code: 'allowance_used' };
      return null;
    },

    async settle(subject, task, requestBytes) {
      const who = await ownerOf(subject);
      if (!who || who.share) return;
      const user = await store().users.findById(who.userId);
      if (!user) return;
      const e = entitlementsOf(user, await store().billing.get(who.userId), now());
      await store().usage.aiAdd(who.userId, usagePeriod(e, now()), taskCost(task, requestBytes));
    },
  };
}
