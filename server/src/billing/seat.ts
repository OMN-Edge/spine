import type { AccountsStore, SubscriptionRecord } from 'spine-core/store/types.js';
import { entitlementsOf, type Entitlements } from 'spine-core/billing/plans.js';

/**
 * What an account has now, and whose plan and allowance it is (SECURITY.md **M-52**). An account that holds a seat in someone's plan has that
 * plan while it runs; one whose organizer's plan has ended has its own again, with its seat kept for if the plan comes back, and nothing
 * deleted either way. The AI allowance is the plan's, counted under the organizer (`holder`), whoever's device made the call.
 */
export interface Standing {
  entitlements: Entitlements;
  /** The account whose subscription this is, and under which the plan's usage is counted: the organizer for a member, otherwise the account. */
  holder: string;
  /** `organizer`: pays for a plan with seats; `member`: holds a seat in another's plan; `none`: neither. */
  seat: 'organizer' | 'member' | 'none';
  /** The subscription the plan is from (the organizer's, for a member), which says when the billing year began; null on the trial and the free plan. */
  subscription: SubscriptionRecord | null;
}

export async function standingOf(store: AccountsStore, userId: string, now: Date): Promise<Standing | null> {
  const user = await store.users.findById(userId);
  if (!user) return null;
  const membership = await store.family.membership(userId);
  if (membership) {
    const organizer = await store.users.findById(membership.organizer_id);
    if (organizer) {
      const sub = await store.billing.get(organizer.id);
      const shared = entitlementsOf(organizer, sub, now);
      if (shared.plan === 'family') return { entitlements: shared, holder: organizer.id, seat: 'member', subscription: sub };
    }
  }
  const ownSub = await store.billing.get(userId);
  const own = entitlementsOf(user, ownSub, now);
  return { entitlements: own, holder: userId, seat: own.seats > 1 ? 'organizer' : 'none', subscription: ownSub };
}
