import { execFileSync } from 'child_process';
import { describe, it } from 'vitest';
import { getChatLlm } from 'spine-core/llm/index.js';
import { getEmbedder } from 'spine-core/embedding/index.js';
import { loadLlmConfig } from 'spine-core/config.js';

/**
 * What this run can do. A suite that needs the model is skipped (and says why) if the configuration is not usable; one that reads a PDF
 * also needs poppler. Nothing is skipped silently: the reason is printed once.
 */
function llmProblem(): string | null {
  try { getChatLlm(); return null; } catch (err) { return err instanceof Error ? err.message : String(err); }
}
function hasPoppler(): boolean {
  try { execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const problem = llmProblem();
export const live = problem === null;
export const pipelineReady = live && hasPoppler();

/**
 * A run is asked for on purpose (`env.ts` refuses to load otherwise), so a flow that cannot run is a failure, not a skip: a skipped test is
 * reported as green, and a run that checked nothing must not look like one that checked everything.
 */
function unavailable(name: string, why: string) {
  describe(name, () => { it('can run', () => { throw new Error(`${name}: ${why}`); }); });
}
export const describeLive = (name: string, fn: () => void) => (live ? describe(name, fn) : unavailable(name, `no usable model (${problem})`));
/** A flow that reads a PDF and the model. */
export const describePipeline = (name: string, fn: () => void) =>
  pipelineReady ? describe(name, fn) : unavailable(name, live ? 'poppler is not installed' : `no usable model (${problem})`);

/** What the run is pointed at, for the log: the names only, never a key, a path or a project. */
export function describeTarget(): string {
  const llm = loadLlmConfig();
  return `${llm.provider} / ${llm.model}; embeddings ${getEmbedder().enabled ? 'on' : 'off'}; parser ${process.env.SPINE_PARSER ?? 'default'}`;
}
