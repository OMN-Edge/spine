import { readFile } from 'fs/promises';
import { logger } from '../logger.js';
import { HumanMessage } from '@langchain/core/messages';
import { OutputParserException } from '@langchain/core/output_parsers';
import { z } from 'zod';
import type { ContinuationResult, ExtractionResult } from '../types.js';
import { buildContinuationPrompt, buildExtractionPrompt, buildLinkingPrompt, buildPageReadingPrompt, buildStampReadingPrompt, buildTranslationPrompt } from './prompts.js';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import { TASK_SCHEMAS, type LlmTask, type TaskClients } from './tasks.js';
import {
  CONTINUATION_FALLBACK,
  EXTRACTION_FALLBACK,
  type ChatLlm,
  type ChatLlmConfig,
  type LinkJudgement,
  type LlmLogger,
  type PageReading,
  type StampReading,
  type TranslationBundle,
} from './types.js';

/**
 * The interface implementation: prompts in, validated domain types out. It holds no
 * vendor types, so swapping the library underneath touches only `adapters/`.
 */

/** One try and one more, for a reply that is not JSON. */
const UNPARSEABLE_ATTEMPTS = 2;

async function invokeValidated<T>(
  clients: TaskClients,
  config: ChatLlmConfig,
  logger: LlmLogger,
  task: LlmTask,
  prompt: BaseLanguageModelInput,
  schema: z.ZodType<T>,
): Promise<T | null> {
  let raw: unknown;
  for (let attempt = 1; ; attempt++) {
    try {
      raw = await clients[task].invoke(prompt);
      break;
    } catch (err) {
      // The model answered, but not with JSON that parses: a reply cut off at its token cap, say.
      // That is the model misbehaving, not the provider being down, so ask once more and then
      // degrade as for a schema failure. Anything else (auth, network, a 5xx) is a real failure and
      // propagates. The message is not logged: it quotes the reply, which can hold document text.
      if (!(err instanceof OutputParserException)) throw err;
      logger.warn('llm response was not valid JSON', { task, provider: config.provider, model: config.model, attempt });
      if (attempt === UNPARSEABLE_ATTEMPTS) return null;
    }
  }
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
  const log = config.logger ?? logger;

  return {
    async detectContinuation(previousPageText, currentPageText): Promise<ContinuationResult> {
      const validated = await invokeValidated(
        clients,
        config,
        log,
        'continuation',
        buildContinuationPrompt(previousPageText, currentPageText, config.contextChars),
        TASK_SCHEMAS.continuation,
      );

      return validated ?? CONTINUATION_FALLBACK;
    },

    async extractFields(documentText, knownTests = [], knownTags = [], ownerNotes = null): Promise<ExtractionResult> {
      const validated = await invokeValidated(
        clients,
        config,
        log,
        'extraction',
        buildExtractionPrompt(documentText, knownTests, knownTags, ownerNotes),
        TASK_SCHEMAS.extraction,
      );

      return validated ?? EXTRACTION_FALLBACK;
    },

    async translate(bundle, target, source): Promise<TranslationBundle | null> {
      const validated = await invokeValidated(
        clients,
        config,
        log,
        'translation',
        buildTranslationPrompt(bundle, target, source),
        TASK_SCHEMAS.translation,
      );
      if (!validated) return null;
      return {
        title: validated.title ?? null,
        summary: validated.summary ?? null,
        notes: validated.notes ?? null,
        fields: validated.fields.map(f => ({ id: f.id, label: f.label ?? null, value: f.value })),
        measurements: validated.measurements,
        doctors: validated.doctors.map(d => ({ id: d.id, specialty: d.specialty ?? null })),
        source_language: validated.source_language ?? null,
      };
    },

    async link(target, candidates): Promise<LinkJudgement[] | null> {
      if (candidates.length === 0) return [];
      const validated = await invokeValidated(clients, config, log, 'linking', buildLinkingPrompt(target, candidates), TASK_SCHEMAS.linking);
      if (!validated) return null;
      const labels = new Set(candidates.map(c => c.id));
      // A label the model made up is not an answer about any document we sent.
      return validated.links.filter(l => labels.has(l.candidate.trim())).map(l => ({ ...l, candidate: l.candidate.trim(), reason: l.reason.trim() }));
    },

    async readStamps(imagePaths): Promise<StampReading | null> {
      if (imagePaths.length === 0) return { doctors: [] };
      const images = await Promise.all(imagePaths.map(async p => (await readFile(p)).toString('base64')));
      const message = new HumanMessage({
        content: [
          { type: 'text', text: buildStampReadingPrompt(images.length) },
          ...images.map(image => ({ type: 'image_url' as const, image_url: { url: `data:image/png;base64,${image}` } })),
        ],
      });
      const validated = await invokeValidated(clients, config, log, 'stamps', [message], TASK_SCHEMAS.stamps);
      if (!validated) return null;

      const clean = (value: string | null | undefined) => value?.trim() || null;
      return {
        doctors: validated.doctors
          .map(d => ({ name: d.name.trim(), specialty: clean(d.specialty), code: clean(d.code) }))
          .filter(d => d.name.length > 0),
      };
    },

    async readPage(imagePath, options): Promise<PageReading | null> {
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
        clients, config, log, options?.thinking ? 'pageThinking' : 'page', [message], TASK_SCHEMAS.page,
      );
      if (!validated) return null;

      // Blocks with no text are dropped.
      return { regions: validated.regions.filter(region => region.text.trim().length > 0) };
    },
  };
}
