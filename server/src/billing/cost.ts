import { pricesOf } from './fair-use.js';
import type { RelayTask } from 'spine-core/billing/plans.js';

/**
 * What an account's AI use costs, as an estimate (SECURITY.md **M-45**): a token is about four bytes of what is sent and what comes back, and each
 * has its price (`prices` in the fair-use file). The relay keeps no content, so this is the one measure it has of a call, kept as numbers by the month
 * and by kind of work (reading, chat, translation), so what a chat message, a translated page and a link open really cost can replace the
 * assumptions the plans were priced on.
 */
export const BYTES_PER_TOKEN = 4;
/** What the response's headers are of the bytes written for it, taken off before they are counted as tokens. */
const HEADER_BYTES = 200;

export type Family = 'reading' | 'chat' | 'translation';
export const FAMILY_OF: Record<RelayTask, Family> = {
  continuation: 'reading', extraction: 'reading', page: 'reading', pageThinking: 'reading', stamps: 'reading', grouping: 'reading', linking: 'reading', embed: 'reading',
  translation: 'translation', chat: 'chat', agent: 'chat',
};

export const tokensOf = (bytes: number): number => Math.max(0, Math.round(bytes / BYTES_PER_TOKEN));

/** Millionths of a euro, for a call that was sent `inBytes` and answered with `outBytes` (of which a response's headers are not tokens). */
export function microEuros(inBytes: number, outBytes: number): { tokens: number; micro: number } {
  const tin = tokensOf(inBytes);
  const tout = tokensOf(Math.max(0, outBytes - HEADER_BYTES));
  const { inputPerMillionEur, outputPerMillionEur } = pricesOf();
  return { tokens: tin + tout, micro: Math.round(tin * inputPerMillionEur + tout * outputPerMillionEur) };
}

/** The keys an account's estimated cost and tokens are counted under (`ai_usage.period`), by the month and the kind of work. */
export const costKey = (family: Family, month: string): string => `${month}:cost:${family}`;
export const tokenKey = (family: Family, month: string): string => `${month}:tokens:${family}`;
