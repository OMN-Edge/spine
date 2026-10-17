import { api, type ModelChoice } from '../api';

export interface AiTarget { provider: string; endpoint: string | null }

let cached: ReturnType<typeof api.sourceFiles.capabilities> | null = null;

/** Asked once per page load and shared: a screen can show many "read with AI" buttons, and the server's answer does not change while it runs. */
function capabilities() {
  cached ??= api.sourceFiles.capabilities().catch(err => { cached = null; throw err; });
  return cached;
}

/** Where page images would go, or null if the operator has not allowed AI reading. */
export function loadAiTarget(): Promise<AiTarget | null> {
  return capabilities().then(c => (c.aiReading.enabled ? c.aiReading : null)).catch(() => null);
}

/** How an upload is read on this server, for saying what "Read whole document" will do. */
export function loadReading() {
  return capabilities().then(c => c.reading).catch(() => null);
}

/** The models a reading can be run with; the default first. One entry means there is nothing to pick. */
export function loadModels(): Promise<ModelChoice[]> {
  return capabilities().then(c => c.models ?? []).catch(() => []);
}

export const whereTo = (target: AiTarget) => (target.endpoint ? `${target.provider} (${target.endpoint})` : target.provider);
