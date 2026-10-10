import { getChatLlm } from '../llm/index.js';
import type { ContinuationResult } from '../types.js';

/**
 * Are these two adjacent pages the same logical document?
 *
 * The prompt, the model and the response validation live behind the LLM interface
 * (`src/llm/`); this is the ingestion pipeline's name for that call.
 */
export async function checkContinuation(
  prevText: string,
  currText: string,
): Promise<ContinuationResult> {
  return getChatLlm().detectContinuation(prevText, currText);
}
