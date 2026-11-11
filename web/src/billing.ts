import { useEffect, useState } from 'react';
import { api, type BillingView } from './api';
import { msg } from './i18n';
import { device } from './core/client';

/**
 * What the signed-in account's plan is, for the screens that say so. `null` while it is being read, and `{ enabled: false }` on an instance
 * with no plans (self-hosted, private), where nothing here shows. A failed read shows nothing either: the plan is the server's to enforce,
 * so a screen that cannot tell simply does not nudge.
 */
export function useBilling(): BillingView | null {
  const [view, setView] = useState<BillingView | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const again = () => setVersion(v => v + 1);
    window.addEventListener(PLAN_CHANGED, again);
    return () => window.removeEventListener(PLAN_CHANGED, again);
  }, []);
  useEffect(() => {
    let live = true;
    api.billing.get().then(v => live && setView(v)).catch(() => live && setView({ enabled: false }));
    return () => { live = false; };
  }, [version]);
  return view;
}

/**
 * Tells the device's core what the account's plan limits that only the app can count (the number of documents), now and whenever the plan
 * changes, so the core refuses what does not fit before it spends anything. A failed read tells it nothing: no limit is the safe side for a person
 * (their records are never made unreachable by a limit), and the server still counts everything that costs money.
 */
export function useDocumentLimit(enabled: boolean): void {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const again = () => setVersion(v => v + 1);
    window.addEventListener(PLAN_CHANGED, again);
    return () => window.removeEventListener(PLAN_CHANGED, again);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api.billing.get().then(async v => { if (live) await device.setPlanLimits({ documents: v.enabled ? v.limits?.documents ?? null : null }); }).catch(() => undefined);
    return () => { live = false; };
  }, [enabled, version]);
}

const PLAN_CHANGED = 'spine:plan-changed';
/** Something that changes what the plan gives (a seat taken or given up) happened: the screens that show the plan read it again. */
export const planChanged = (): void => { window.dispatchEvent(new Event(PLAN_CHANGED)); };

/** A refusal that comes from the plan, in words the person is told (translated by the caller), or null for any other error. */
export function planRefusal(err: unknown): string | null {
  const text = err instanceof Error ? err.message : '';
  if (/plan.s AI processing is used up/i.test(text)) return PLAN_TEXT.allowance;
  if (/another live share is not part of the account.s plan/i.test(text)) return PLAN_TEXT.shares;
  if (/approving visitors is not part of the account.s plan/i.test(text)) return PLAN_TEXT.approval;
  if (/the plan.s people are all taken/i.test(text)) return PLAN_TEXT.peopleTaken;
  if (/fair-use limit/i.test(text)) return PLAN_TEXT.fairUse;
  if (/another document is not part of the account.s plan/i.test(text)) return PLAN_TEXT.documents;
  if (/another person is not part of the account.s plan/i.test(text)) return PLAN_TEXT.people;
  if (/not part of the account.s plan|answered 402/i.test(text)) return PLAN_TEXT.feature;
  return null;
}

const PLAN_TEXT = {
  allowance: msg('The AI reading in your plan is used up for now. It starts again next month, or you can upgrade on your account page.'),
  shares: msg('Your plan has one share link at a time. Revoke it, or upgrade on your account page for more.'),
  approval: msg('Approving visitors before they see a link is part of the paid plan. See your account page.'),
  people: msg('Your plan keeps the records of one person. A plan for the family adds more; see your account page.'),
  fairUse: msg('This account has reached its fair-use limit. Contact support.'),
  documents: msg('Your plan keeps up to 50 documents, and that many are kept. Premium has no limit on how many; see your account page.'),
  peopleTaken: msg('Every person your plan holds is taken, across all the accounts that share it. Remove one, or ask the account that pays about a larger plan.'),
  feature: msg('This is not part of your plan. See the plans on your account page.'),
} as const;

export const formatBytes = (n: number): string => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`);
