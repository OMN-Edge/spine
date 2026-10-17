/**
 * The logger that modules without access to the Fastify app use — the parser's
 * per-page routing, the LLM's validation warnings.
 *
 * It writes to the console until the server points it at its own structured logger, so
 * those lines come out as the same JSON as every other line in the journal and can be
 * searched the same way. Tests leave it alone and get plain console output.
 */
export interface AppLogger {
  info(message: string, detail?: Record<string, unknown>): void;
  warn(message: string, detail?: Record<string, unknown>): void;
  error(message: string, detail?: Record<string, unknown>): void;
}

let current: AppLogger = {
  info: (message, detail) => console.log(message, detail ?? ''),
  warn: (message, detail) => console.warn(message, detail ?? ''),
  error: (message, detail) => console.error(message, detail ?? ''),
};

/** Delegates, so a module that imported `logger` early still follows a later `useLogger`. */
export const logger: AppLogger = {
  info: (message, detail) => current.info(message, detail),
  warn: (message, detail) => current.warn(message, detail),
  error: (message, detail) => current.error(message, detail),
};

export function useLogger(next: AppLogger): void {
  current = next;
}
