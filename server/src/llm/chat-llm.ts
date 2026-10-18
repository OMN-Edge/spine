import { readFile } from 'fs/promises';
import { logger } from '../logger.js';
import { HumanMessage } from '@langchain/core/messages';
import { OutputParserException } from '@langchain/core/output_parsers';
import { z } from 'zod';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ContinuationResult, ExtractionResult } from '../types.js';
import { buildContinuationPrompt, buildChatPrompt, buildExtractionPrompt, buildGroupingPrompt, buildLinkingPrompt, buildPageReadingPrompt, buildStampReadingPrompt, buildTranslationPrompt } from './prompts.js';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import { TASK_SCHEMAS, type LlmTask, type TaskClients } from './tasks.js';
import {
  CONTINUATION_FALLBACK,
  EXTRACTION_FALLBACK,
  type ChatLlm,
  type ChatLlmConfig,
  type ChatAnswer,
  type GroupingJudgement,
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
      // The prompt gives each label "in square brackets", and a model often writes it back that way ("[1]"): the label is what is inside.
      // (Found by the first run against a real model, which proposed a correct link that was thrown away for its brackets.)
      const labelOf = (written: string) => written.trim().replace(/^\[|\]$/g, '').trim();
      // A label the model made up is not an answer about any document we sent.
      return validated.links.filter(l => labels.has(labelOf(l.candidate))).map(l => ({ ...l, candidate: labelOf(l.candidate), reason: l.reason.trim() }));
    },

    async judgeGrouping(pages): Promise<GroupingJudgement | null> {
      if (pages.length === 0) return null;
      const validated = await invokeValidated(clients, config, log, 'grouping', buildGroupingPrompt(pages), TASK_SCHEMAS.grouping);
      if (!validated) return null;
      const known = new Set(pages.map(p => p.id));
      const clean = (labels: string[]) => labels.map(l => l.trim().replace(/^\[|\]$/g, '')).filter(l => known.has(l));
      const once = (labels: string[]) => [...new Set(labels)];
      // A label the model made up names no page we sent; a page it left out is put back so none is lost.
      const groups = validated.groups.map(g => once(clean(g))).filter(g => g.length > 0);
      const placed = new Set(groups.flat());
      for (const p of pages) if (!placed.has(p.id) && !validated.coherent) groups.push([p.id]);
      const order = once(clean(validated.order));
      for (const p of pages) if (!order.includes(p.id) && validated.coherent) order.push(p.id);
      return { coherent: validated.coherent, confidence: validated.confidence, groups: validated.coherent ? [] : groups, order: validated.coherent ? order : [], title: validated.title?.trim() || null, reason: validated.reason.trim() };
    },

    async answerQuestion(question, records, history): Promise<ChatAnswer | null> {
      const validated = await invokeValidated(clients, config, log, 'chat', buildChatPrompt(question, records, history), TASK_SCHEMAS.chat);
      if (!validated?.answer.trim()) return null;
      // A section label (D1.results) is a record of its own; its document (D1) may be cited too.
      const labels = new Set(records.flatMap(r => [r.label, r.label.split('.')[0]]));
      // A label the model made up names no record we sent.
      const sources = [...new Set(validated.sources.map(s => s.trim().replace(/^\[|\]$/g, '')))].filter(s => labels.has(s));
      return { answer: validated.answer.trim(), sources };
    },

    agentModel() {
      const model = clients.agent as unknown as BaseChatModel | undefined;
      // A model that cannot be given tools is no agent: the caller answers without them.
      return model && typeof (model as { bindTools?: unknown }).bindTools === 'function' ? model : null;
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
