import type { Count } from 'spine-core/billing/plans.js';

/**
 * What an account has done in all: the pages read for it, the questions answered and the pages translated, kept apart from the month counts (the key has no
 * month, so nothing forgets it) and always the account's own, never a pool's. Numbers only, shown on the account page as things done.
 */
export const totalKey = (count: Count): string => `total:${count}`;

export const TOTALS = ['pages', 'messages', 'translated'] as const satisfies readonly Count[];
