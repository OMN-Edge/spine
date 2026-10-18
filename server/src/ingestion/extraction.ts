import { getChatLlm } from '../llm/index.js';
import type { ExtractionResult } from '../types.js';

/**
 * Structured metadata for one logical document.
 *
 * The prompt, the model and the response validation live behind the LLM interface
 * (`src/llm/`); this is the ingestion pipeline's name for that call.
 */
export async function extractFields(documentText: string, knownTests: string[] = [], model?: string, knownTags: string[] = [], ownerNotes: string | null = null): Promise<ExtractionResult> {
  return getChatLlm(model).extractFields(documentText, knownTests, knownTags, ownerNotes);
}
