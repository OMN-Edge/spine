import { readFile } from 'fs/promises';
import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { ContinuationResult, ExtractionResult } from '../types.js';
import { buildContinuationPrompt, buildExtractionPrompt, buildPageReadingPrompt } from './prompts.js';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import { TASK_SCHEMAS, type LlmTask, type TaskClients } from './tasks.js';
import {
  CONTINUATION_FALLBACK,
  EXTRACTION_FALLBACK,
  type ChatLlm,
  type ChatLlmConfig,
  type LlmLogger,
  type PageReading,
} from './types.js';

/**
 * The interface implementation: prompts in, validated domain types out. It holds no
 * vendor types, so swapping the library underneath touches only `adapters/`.
 */

const consoleLogger: LlmLogger = {
  info: (message, detail) => console.log(message, detail ?? ''),
  warn: (message, detail) => console.warn(message, detail ?? ''),
};

async function invokeValidated<T>(
  clients: TaskClients,
  config: ChatLlmConfig,
  logger: LlmLogger,
  task: LlmTask,
  prompt: BaseLanguageModelInput,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const raw = await clients[task].invoke(prompt);
  const parsed = schema.safeParse(raw);

  if (parsed.success) return parsed.data;

  // Visible, not silent. The old code caught a JSON parse error and returned a
  // default with no record that the model had misbehaved at all.
  logger.warn('llm response failed schema validation', {
    task,
    provider: config.provider,
    model: config.model,
    issues: parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`),
  });
  return null;
}

export function buildChatLlm(clients: TaskClients, config: ChatLlmConfig): ChatLlm {
  const logger = config.logger ?? consoleLogger;

  return {
    async detectContinuation(previousPageText, currentPageText): Promise<ContinuationResult> {
      const validated = await invokeValidated(
        clients,
        config,
        logger,
        'continuation',
        buildContinuationPrompt(previousPageText, currentPageText),
        TASK_SCHEMAS.continuation,
      );

      return validated ?? CONTINUATION_FALLBACK;
    },

    async extractFields(documentText): Promise<ExtractionResult> {
      const validated = await invokeValidated(
        clients,
        config,
        logger,
        'extraction',
        buildExtractionPrompt(documentText),
        TASK_SCHEMAS.extraction,
      );

      return validated ?? EXTRACTION_FALLBACK;
    },

    async readPage(imagePath): Promise<PageReading | null> {
      // The page goes as a data URL in a standard image block, which LangChain turns
      // into a base64 `image` block for Anthropic and `inlineData` for Gemini.
      const image = (await readFile(imagePath)).toString('base64');
      const message = new HumanMessage({
        content: [
          { type: 'text', text: buildPageReadingPrompt() },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } },
        ],
      });

      const validated = await invokeValidated(
        clients, config, logger, 'page', [message], TASK_SCHEMAS.page,
      );
      if (!validated) return null;

      // Model-reported boxes are clamped into the page and put the right way up, and
      // blocks with no text are dropped. The boxes stay approximate.
      const clamp = (n: number) => Math.min(1, Math.max(0, n));
      return {
        regions: validated.regions
          .filter(region => region.text.trim().length > 0)
          .map(region => ({
            text: region.text,
            x0: clamp(Math.min(region.x0, region.x1)),
            y0: clamp(Math.min(region.y0, region.y1)),
            x1: clamp(Math.max(region.x0, region.x1)),
            y1: clamp(Math.max(region.y0, region.y1)),
          })),
      };
    },
  };
}
