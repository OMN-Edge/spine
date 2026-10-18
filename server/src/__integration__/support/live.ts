import { execFileSync } from 'child_process';
import { describe } from 'vitest';
import { getChatLlm } from '../../llm/index.js';
import { getEmbedder } from '../../embedding/index.js';
import { loadLlmConfig } from '../../config.js';

/**
 * What this run can do. A suite that needs the model is skipped (and says why) if the configuration is not usable; one that reads a PDF
 * also needs the sidecar and poppler. Nothing is skipped silently: the reason is printed once.
 */
function llmProblem(): string | null {
  try { getChatLlm(); return null; } catch (err) { return err instanceof Error ? err.message : String(err); }
}
function hasPoppler(): boolean {
  try { execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const problem = llmProblem();
export const live = problem === null;
export const pipelineReady = live && process.env.SPINE_IT_SIDECAR === '1' && hasPoppler();

if (!live) console.warn(`[integration] no usable model, all flows skipped: ${problem}`);
else if (!pipelineReady) console.warn('[integration] no sidecar or no poppler: the flows that read a PDF are skipped');

/** A flow that calls the model. */
export const describeLive = live ? describe : describe.skip;
/** A flow that reads a PDF through the sidecar and the model. */
export const describePipeline = pipelineReady ? describe : describe.skip;

/** What the run is pointed at, for the log: the names only, never a key, a path or a project. */
export function describeTarget(): string {
  const llm = loadLlmConfig();
  return `${llm.provider} / ${llm.model}; embeddings ${getEmbedder().enabled ? 'on' : 'off'}; parser ${process.env.SPINE_PARSER ?? 'default'}`;
}
