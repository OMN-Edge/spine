/**
 * When the account page offers to buy a plan (T-07). A person on the first day of three months of trial is not asked for money: the page shows what the trial holds and one quiet "Compare
 * plans". The buttons come when the trial is nearly over, when any of its totals is nearly used, or when the account is not on the trial at all.
 */
export const BUY_WITHIN_DAYS = 21;
export const NEARLY = 0.8;

export interface Standing {
  plan: 'trial' | 'free' | 'essential' | 'premium' | 'family' | undefined;
  trialEndsAt: string | null | undefined;
  /** How much of each limited thing is used, from 0 to 1 and over (pages, questions, translations). */
  used: number[];
  now?: Date;
}

export function offerPlans({ plan, trialEndsAt, used, now = new Date() }: Standing): boolean {
  if (plan !== 'trial') return true;
  if (used.some(u => u >= NEARLY)) return true;
  if (!trialEndsAt) return true;
  return (Date.parse(trialEndsAt) - now.getTime()) / 86_400_000 <= BUY_WITHIN_DAYS;
}

/** Whole days left of the trial, never below nought. */
export function trialDaysLeft(trialEndsAt: string, now = new Date()): number {
  return Math.max(0, Math.ceil((Date.parse(trialEndsAt) - now.getTime()) / 86_400_000));
}
