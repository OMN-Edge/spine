import { z } from 'zod';
import type { Runnable } from '@langchain/core/runnables';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import {
  continuationSchema,
  extractionSchema,
  chatAnswerSchema,
  linkingSchema,
  pageReadingSchema,
  stampReadingSchema,
  translationSchema,
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
export const LLM_TASKS = ['continuation', 'extraction', 'page', 'pageThinking', 'stamps', 'translation', 'linking', 'chat', 'agent'] as const;
export type LlmTask = (typeof LLM_TASKS)[number];

export interface TaskSpec {
  name: LlmTask;
  /** Both providers take this at construction, under different option names. */
  maxTokens: number;
  /**
   * `none` for a task that is classifying or copying, where deliberation adds only cost. A model
   * that thinks before it answers spends its output budget on that first, so a long think can leave
   * no room for the answer. `default` leaves it to the model. Providers that do not think ignore it.
   */
  reasoning: 'none' | 'default';
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
  pageThinking: pageReadingSchema,
  stamps: stampReadingSchema,
  translation: translationSchema,
  linking: linkingSchema,
  chat: chatAnswerSchema,
  // The agent has no answer schema: it is the chat model itself, given tools, and it replies in prose. This only keeps the table whole.
  agent: z.object({}),
} satisfies Record<LlmTask, z.ZodType>;

export function buildTaskSpecs(config: ChatLlmConfig): TaskSpecs {
  return {
    continuation: {
      name: 'continuation',
      maxTokens: config.maxTokens.continuation,
      reasoning: 'none',
      jsonSchema: z.toJSONSchema(TASK_SCHEMAS.continuation) as Record<string, unknown>,
    },
    extraction: {
      name: 'extraction',
      maxTokens: config.maxTokens.extraction,
      reasoning: 'default',
      jsonSchema: z.toJSONSchema(TASK_SCHEMAS.extraction) as Record<string, unknown>,
    },
    page: {
      name: 'page',
      maxTokens: config.maxTokens.page,
      reasoning: 'none',
      jsonSchema: z.toJSONSchema(TASK_SCHEMAS.page) as Record<string, unknown>,
    },
    // The same reading with the model left to think first, for a page it did badly: handwriting, a dense block.
    // Slower and billed for the thinking, so only when asked for (the "think harder" choice beside Read page with AI).
    pageThinking: {
      name: 'pageThinking',
      maxTokens: config.maxTokens.page,
      reasoning: 'default',
      jsonSchema: z.toJSONSchema(TASK_SCHEMAS.pageThinking) as Record<string, unknown>,
    },
    // A few lines of text per stamp: the page budget is a ceiling, not a target.
    stamps: {
      name: 'stamps',
      maxTokens: config.maxTokens.page,
      reasoning: 'none',
      jsonSchema: z.toJSONSchema(TASK_SCHEMAS.stamps) as Record<string, unknown>,
    },
    // The same ceiling as extraction: a translation is about as long as what it translates, which a lab panel
    // can make long, and it is a ceiling and not a target.
    translation: {
      name: 'translation',
      maxTokens: config.maxTokens.extraction,
      reasoning: 'none',
      jsonSchema: z.toJSONSchema(TASK_SCHEMAS.translation) as Record<string, unknown>,
    },
    // A few short judgements about a handful of cards: no deliberation, and the extraction ceiling is far more than it needs.
    linking: {
      name: 'linking',
      maxTokens: config.maxTokens.continuation,
      reasoning: 'none',
      jsonSchema: z.toJSONSchema(TASK_SCHEMAS.linking) as Record<string, unknown>,
    },
    // An answer is a few paragraphs at most; the extraction ceiling is only a ceiling. The model may think first: reading
    // a series of results against a question is where it earns it.
    chat: {
      name: 'chat',
      maxTokens: config.maxTokens.extraction,
      reasoning: 'default',
      jsonSchema: z.toJSONSchema(TASK_SCHEMAS.chat) as Record<string, unknown>,
    },
    // The tool-using chat agent (`chat/agent.ts`). Its client is the plain chat model, not bound to a schema, because tools
    // are bound to it by the graph. The cap is per model reply; steps and tool output are capped by the graph.
    agent: {
      name: 'agent',
      maxTokens: config.maxTokens.extraction,
      reasoning: 'default',
      jsonSchema: z.toJSONSchema(TASK_SCHEMAS.agent) as Record<string, unknown>,
    },
  };
}
