import { BUILD_COMMIT, BUILD_VERSION } from '../build-info';

/**
 * Why the records did not open after the password was accepted, in the three kinds a person can act on differently:
 * `key`: the key did not open what the server holds (the password is what to look at);
 * `vault`: the server or the connection did not answer, or the core stopped before it had the records' list;
 * `records`: the records were fetched and could not be put to use on this device (the password is not the problem).
 */
export type OpenFailureKind = 'key' | 'vault' | 'records';

export interface OpenFailure {
  kind: OpenFailureKind;
  /** What a person can copy to support: no record, no address, no key. */
  report: string;
}

/** The core's own steps (`core.worker.ts` `trace`) before it has the list of records. None at all means it never started. */
const BEFORE_RECORDS = new Set(['opening the vault', 'loading profiles']);

const shortened = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * `step` is the last thing the core said it was doing. An error from the core reaches the page as a plain `Error` whose `name` is the
 * core's (a class does not cross the worker's boundary), so a wrong key is told by `name`.
 */
export function classifyOpenFailure(err: unknown, step: string, now: Date = new Date()): OpenFailure {
  const e = err as { name?: string; message?: string; status?: number; code?: string } | null;
  const name = e?.name ?? 'Error';
  const kind: OpenFailureKind = name === 'OpenError'
    ? 'key'
    : e instanceof TypeError || (typeof e?.status === 'number' && e.status !== 0) || BEFORE_RECORDS.has(step) ? 'vault' : 'records';
  const lines = [
    'Spine could not open the records',
    `Time: ${now.toISOString()}`,
    `App: ${BUILD_VERSION} ${shortened(BUILD_COMMIT, 12)}`,
    `Failed at: ${kind}${step ? ` (${step})` : ''}`,
    `Error: ${name}: ${shortened(String(e?.message ?? err ?? ''), 300)}`,
    ...(typeof e?.status === 'number' ? [`Status: ${e.status}${e.code ? ` ${e.code}` : ''}`] : []),
    `Online: ${typeof navigator !== 'undefined' && navigator.onLine === false ? 'no' : 'yes'}`,
    `Browser: ${shortened(typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown', 160)}`,
  ];
  return { kind, report: lines.join('\n') };
}
