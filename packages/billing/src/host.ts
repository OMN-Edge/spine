import type { BillingStore } from './store.js';

/**
 * What the application gives this package once, at start-up: the store it keeps, where a line of the log goes, and how the operator is told of something only a person can mend.
 * Nothing is wired by default: asked for before it is given, each says what is missing (as the ports of the application's core do), so a process that forgot is found at its first use.
 */
export interface Log {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface BillingHost {
  /** The store, asked for at each use (a process may replace it). */
  store(): BillingStore;
  log: Log;
  /** Tells the operator of something about the invoices that only a person can mend. Only references and the service's words, never a buyer. Never throws. */
  alert(subject: string, lines: string[]): Promise<void>;
}

let given: BillingHost | null = null;

export function useBillingHost(host: BillingHost | null): void { given = host; }

function host(): BillingHost {
  if (!given) throw new Error('spine-billing has no host: the application gives it its store, log and alert with useBillingHost() before it is used');
  return given;
}

export const store = (): BillingStore => host().store();
export const log: Log = {
  info: (message, fields) => host().log.info(message, fields),
  warn: (message, fields) => host().log.warn(message, fields),
  error: (message, fields) => host().log.error(message, fields),
};
export const alert = (subject: string, lines: string[]): Promise<void> => host().alert(subject, lines);
