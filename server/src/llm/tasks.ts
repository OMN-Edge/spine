import { z } from 'zod';
import type { Runnable } from '@langchain/core/runnables';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import {
  continuationSchema,
  extractionSchema,
  pageReadingSchema,
  stampReadingSchema,
  type ChatLlmConfig,
} from './types.js';

/**
 * Spine makes a handful of model calls, and everything about their shape is
 * fixed at startup: the output budget and the response schema. So both belong
 * in a task definition the adapter is handed once, rather than being passed
 * per call.
 *
 * This is also the one place a task's schema is stated, so the JSON Schema the
 * provider is constrained with and the zod schema the interface validates against
 * cannot drift apart.
 */
export const LLM_TASKS = ['continuation', 'extraction', 'page', 'stamps'] as const;
export type LlmTask = (typeof LLM_TASKS)[number];

export interface TaskSpec {
  name: LlmTask;
  /** Both providers take this at construction, under different option names. */
  maxTokens: number;
  jsonSchema: Record<string, unknown>;
}

export type TaskSpecs = Record<LlmTask, TaskSpec>;

/**
 * What an adapter returns: one ready-to-invoke client per task, already bound
 * to its schema and token budget.
 *
 * This is LangChain's own `Runnable`, not an interface of ours. An earlier
 * version wrapped it in a one-method `StructuredChat`, which bought only the
 * ability to swap the library without touching this file — speculative, and
 * cheap to pay later if it ever happens. `@langchain/core` is the shared
 * abstraction package rather than a provider SDK, so depending on it here is
 * using the library as intended; what must stay out of this layer is
 * `ChatAnthropic`, `ChatVertexAI` and anything else provider-specific.
 */
export type TaskClients = Record<LlmTask, Runnable<BaseLanguageModelInput, unknown>>;

/** The zod schema each task's response is validated against. */
export const TASK_SCHEMAS = {
  continuation: continuationSchema,
  extraction: extractionSchema,
  page: pageReadingSchema,
  stamps: stampReadingSchema,
} satisfies Record<LlmTask, z.ZodType>;

export function buildTaskSpecs(config: ChatLlmConfig): TaskSpecs {
  return {
    continuation: {
      name: 'continuation',
      maxTokens: config.maxTokens.continuation,
      jsonSchema: z.toJSONSchema(TASK_SCHEMAS.continuation) as Record<string, unknown>,
    },
    extraction: {
      name: 'extraction',
      maxTokens: config.maxTokens.extraction,
      jsonSchema: z.toJSONSchema(TASK_SCHEMAS.extraction) as Record<string, unknown>,
    },
    page: {
      name: 'page',
      maxTokens: config.maxTokens.page,
      jsonSchema: z.toJSONSchema(TASK_SCHEMAS.page) as Record<string, unknown>,
    },
    // A few lines of text per stamp: the page budget is a ceiling, not a target.
    stamps: {
      name: 'stamps',
      maxTokens: config.maxTokens.page,
      jsonSchema: z.toJSONSchema(TASK_SCHEMAS.stamps) as Record<string, unknown>,
    },
  };
}
