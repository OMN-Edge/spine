/**
 * What the pricing page says of the founding places (T-13). "0 of 500 taken" with an empty bar reads as "nobody bought", so the count waits until there is something to count: quiet while
 * fewer than a hundred are taken, the count and its bar from a hundred taken (a real number is a reason to trust), and from a hundred left the number left, which is a true reason to hurry.
 */
export const FOUNDING_PLACES = 500;
export const SHOW_COUNT_FROM_TAKEN = 100;
export const SCARCE_FROM_LEFT = 100;

export type FoundingStage = 'quiet' | 'count' | 'scarce';

export function foundingStage(left: number): FoundingStage {
  if (left <= SCARCE_FROM_LEFT) return 'scarce';
  return FOUNDING_PLACES - left >= SHOW_COUNT_FROM_TAKEN ? 'count' : 'quiet';
}
