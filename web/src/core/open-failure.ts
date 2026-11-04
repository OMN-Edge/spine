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
 * An error's text is written by whatever code failed, so it is not trusted to be free of what the person keeps: an address, a title, a file
 * name, an id, a link with its key. What looks like any of those is replaced before the text goes in the report.
 */
export function scrubbed(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, '[link]')
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]')
    .replace(/"[^"]*"|“[^”]*”|'[^']*'|‘[^’]*’|`[^`]*`/g, '[text]')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[id]')
    .replace(/(?:[\w.~-]*\/)+[\w.~-]+/g, '[path]')
    .replace(/[A-Za-z0-9_+=-]{24,}/g, '[token]');
}

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
    `Error: ${shortened(scrubbed(name), 60)}: ${shortened(scrubbed(String(e?.message ?? err ?? '')), 300)}`,
    ...(typeof e?.status === 'number' ? [`Status: ${e.status}${e.code ? ` ${e.code}` : ''}`] : []),
    `Online: ${typeof navigator !== 'undefined' && navigator.onLine === false ? 'no' : 'yes'}`,
    `Browser: ${shortened(typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown', 160)}`,
  ];
  return { kind, report: lines.join('\n') };
}
