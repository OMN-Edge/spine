import { api } from '../api';

export interface AiTarget { provider: string; endpoint: string | null }

let cached: Promise<AiTarget | null> | null = null;

/**
 * Where page images would go, or null if the operator has not allowed AI reading. Asked
 * once per page load and shared: a screen can show many "read with AI" buttons, and the
 * server's answer does not change while it runs.
 */
export function loadAiTarget(): Promise<AiTarget | null> {
  cached ??= api.sourceFiles.capabilities()
    .then(c => (c.aiReading.enabled ? c.aiReading : null))
    .catch(() => { cached = null; return null; });
  return cached;
}

export const whereTo = (target: AiTarget) => (target.endpoint ? `${target.provider} (${target.endpoint})` : target.provider);
