import { z } from 'zod';
import type { ContinuationResult, ExtractionResult } from '../types.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { TaskClients, TaskSpecs } from './tasks.js';

/**
 * The LLM interface. Stateless, single-turn calls — no chaining, no agent loop,
 * no tool use, no multi-turn state (docs/architecture/interfaces.md) — with one exception: `agentModel()` hands the
 * chat agent (`chat/agent.ts`) the model itself, to bind its read-only tools to. What looks like a chain
 * is a data pipeline: continuation results decide how pages are grouped, and
 * the grouping decides what text each extraction call receives.
 *
 * Because every call is a stateless completion returning JSON, any chat
 * completion API can back this, which is what keeps the provider swappable.
 */
export interface ChatLlm {
  /** Are these two adjacent pages the same logical document? */
  detectContinuation(previousPageText: string, currentPageText: string): Promise<ContinuationResult>;
  /** Structured metadata for one logical document. */
  /** `knownTests`: canonical test names already in the archive, so the same test is named the same way. */
  /** `ownerNotes`: what the owner wrote on the document, as context (never as a source of values). */
  extractFields(documentText: string, knownTests?: string[], knownTags?: string[], ownerNotes?: string | null): Promise<ExtractionResult>;
  /**
   * Read one page image: the text on it and where. **This is the only call that
   * sends an image off the host** (SECURITY.md M-7), so it is reached only through
   * the multimodal parser, which is off unless the operator turns it on.
   * Null if the model's answer could not be used.
   */
  /** `thinking`: let the model think before it answers (slower and dearer; for handwriting and dense pages). */
  readPage(imagePath: string, options?: { thinking?: boolean }): Promise<PageReading | null>;
  /**
   * Read the doctors' names, specialties and professional codes off signature stamps: small images cut
   * from a document's last page, never a whole page. **The second call that sends an image off the host**
   * (SECURITY.md M-7), under the same operator switch; the caller checks it. Null if the answer could not
   * be used.
   */
  readStamps(imagePaths: string[]): Promise<StampReading | null>;
  /**
   * A document's extracted details and the owner's notes in another language. Text only, to the configured
   * provider, like extraction (SECURITY.md P8). Null if the answer could not be used. The caller reconciles
   * what came back with what it sent, by id.
   */
  translate(bundle: TranslationBundle, target: string, source: string | null): Promise<TranslationBundle | null>;
  /**
   * Which of these candidate documents the target is linked to: one requested the other, one follows up the other, or
   * they are one episode. Summary cards only, never pages (SECURITY.md P8); the cards are data, not instructions.
   * `candidate` in an answer is the id the caller gave. Null if the answer could not be used.
   */
  link(target: LinkCard, candidates: LinkCard[]): Promise<LinkJudgement[] | null>;
  /**
   * Whether these pages (the text read from them) form one coherent document, and if not how they divide. Page text goes to the
   * configured provider, as it does for extraction (SECURITY.md P8, M-24); the text is data, not instructions. Null if the answer
   * could not be used.
   */
  judgeGrouping(pages: GroupingPage[]): Promise<GroupingJudgement | null>;
  /**
   * Answers a question from the owner's own records and nothing else. `records` are labelled summary cards with their
   * results (never pages or scans); the answer cites them by label. Text only, to the configured provider (SECURITY.md
   * P8, M-18). Null if the answer could not be used.
   */
  answerQuestion(question: string, records: ChatRecord[], history: ChatTurn[]): Promise<ChatAnswer | null>;
  /**
   * The chat model itself, for an agent that binds tools to it (`chat/agent.ts`). Provider-neutral: LangChain's own base class.
   * Null where the implementation cannot offer one (a test double), and the caller then answers without tools.
   */
  agentModel(): BaseChatModel | null;
}

/** A record as the chat model sees it. The label is the caller's ("D1"), not a database id. */
export interface ChatRecord {
  label: string;
  text: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatAnswer {
  answer: string;
  /** Labels of the records the answer relied on, only ones the caller sent. */
  sources: string[];
}

/** A document as the linking model sees it. The id is the caller's (a short label, not a database id). */
export interface LinkCard {
  id: string;
  text: string;
}

/** A page as the grouping model sees it. The id is the caller's (a short label, not a database id). */
export interface GroupingPage {
  id: string;
  text: string;
}

export interface GroupingJudgement {
  coherent: boolean;
  confidence: number;
  /** When not coherent: the labels divided into groups that each hold together. */
  groups: string[][];
  /** The labels in reading order (all of them, once each). */
  order: string[];
  title: string | null;
  reason: string;
}

export interface LinkJudgement {
  candidate: string;
  relation: LinkRelation;
}

/** What is translated for one document. Ids are the caller's, and come back unchanged. */
export interface TranslationBundle {
  title: string | null;
  summary: string | null;
  notes: string | null;
  /** `label` only for a label the interface has no wording for (the model may invent one); null otherwise. */
  fields: Array<{ id: string; label: string | null; value: string }>;
  measurements: Array<{ id: string; name: string }>;
  doctors: Array<{ id: string; specialty: string | null }>;
  /** In an answer only: the language the record is written in (a two-letter code), when the caller did not know it. */
  source_language?: string | null;
}

export interface StampReading {
  doctors: Array<{ name: string; specialty: string | null; code: string | null }>;
}

/**
 * A block of text on a page: a line, or a few that belong together. No position: a model's estimate of
 * where text sits was unreliable, so a page the model reads has its text and nothing to highlight.
 */
export interface PageRegion {
  text: string;
}

export interface PageReading {
  regions: PageRegion[];
}

export interface ChatLlmConfig {
  provider: string;
  model: string;
  /**
   * Explicit endpoint. Never defaulted to a global one: residency is a
   * property of the endpoint, so a silent fallback here voids the guarantee
   * (SECURITY.md P8, M-8).
   */
  endpoint?: string;
  /** Provider region, where the provider has one. Stated, never parsed. */
  region?: string;
  project?: string;
  maxTokens: { continuation: number; extraction: number; page: number };
  /** Retries inside the adapter, where transport failures belong. */
  maxRetries: number;
  /**
   * The model's context window in characters, the only cap on the text in a request. A page
   * pair or a document that would exceed it is cut for a boundary check or split into chunks
   * for extraction; nothing is shortened for any other reason.
   */
  contextChars: number;
  logger?: LlmLogger;
}

export interface LlmLogger {
  info(message: string, detail?: Record<string, unknown>): void;
  warn(message: string, detail?: Record<string, unknown>): void;
}

export type TaskClientsFactory = (config: ChatLlmConfig, tasks: TaskSpecs) => TaskClients;

/**
 * The provider declined to answer this input (a recitation or safety block, say). It is about these words, not about
 * the provider being down: a smaller piece of the same input may well be answered, so callers can split and try again.
 */
export class LlmBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmBlockedError';
  }
}

export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmConfigError';
  }
}

export const DOC_TYPES = [
  'lab_result',
  'discharge_note',
  'vaccination',
  'imaging',
  'prescription',
  'consultation_note',
  'other',
] as const;

/**
 * The interface validates every response against these before anything reaches the
 * database. `JSON.parse` in a `try/catch` accepted any shape at all, including
 * a confidence of "high" or a doc_type the schema does not have.
 */
export const continuationSchema = z.object({
  is_continuation: z.boolean(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

export const DOCTOR_ROLES = ['author', 'prescriber', 'referrer', 'other'] as const;

/**
 * Deliberately lenient where the model is describing what is printed: reference ranges,
 * flags and dates arrive as text and are normalised on our side (ingestion/measurements.ts).
 * Rejecting a whole document because a reference range came back as "12" instead of 12 would
 * lose everything else on it.
 */
export const extractionSchema = z.object({
  // What the document is written in; absent or null when it cannot be told.
  language: z.string().nullish(),
  title: z.string(),
  doc_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  provider: z.string().nullable(),
  doc_type: z.enum(DOC_TYPES),
  ai_summary: z.string(),
  suggested_tags: z.array(z.string()),
  // Absent means none: a model that leaves out a list the document does not have should not lose the rest.
  doctors: z.array(
    z.object({
      name: z.string(),
      specialty: z.string().nullable(),
      // Printed under the signature ("Cod X12345"); absent on most documents.
      code: z.string().nullish(),
      role: z.enum(DOCTOR_ROLES),
    }),
  ).default([]),
  fields: z.array(
    z.object({
      label: z.string(),
      value: z.string(),
      group: z.number().int().positive().nullish(),
      source_snippet: z.string(),
      page_number: z.number().int().positive(),
      confidence: z.number().min(0).max(1),
    }),
  ),
  measurements: z.array(
    z.object({
      name: z.string(),
      canonical: z.string(),
      value: z.string(),
      unit: z.string().nullable(),
      ref_low: z.string().nullable(),
      ref_high: z.string().nullable(),
      flag: z.string().nullable(),
      date: z.string().nullable(),
      source_snippet: z.string(),
      page_number: z.number().int().positive(),
      confidence: z.number().min(0).max(1),
    }),
  ).default([]),
});

/** Text only. A model that still adds coordinates is not failed for it: unknown keys are dropped. */
export const pageReadingSchema = z.object({
  regions: z.array(z.object({ text: z.string() })),
});

/** What a translation answers: the same shape it was given, in the other language. Absent lists are empty, so one a model leaves out does not lose the rest. */
export const translationSchema = z.object({
  source_language: z.string().nullish(),
  title: z.string().nullish(),
  summary: z.string().nullish(),
  notes: z.string().nullish(),
  fields: z.array(z.object({ id: z.string(), label: z.string().nullish(), value: z.string() })).default([]),
  measurements: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
  doctors: z.array(z.object({ id: z.string(), specialty: z.string().nullish() })).default([]),
});

export const LINK_RELATIONS = [
  'candidate_requested_target', 'target_requested_candidate', 'target_follows_up_candidate', 'candidate_follows_up_target', 'same_episode',
] as const;
export type LinkRelation = (typeof LINK_RELATIONS)[number];

/** What a linking answers: only the candidates that are related, each with the relation. It gives no reason: what is shown as one is made from the data (`linking/why.ts`). */
export const linkingSchema = z.object({
  links: z.array(z.object({
    candidate: z.string(),
    relation: z.enum(LINK_RELATIONS),
  })).default([]),
});

/**
 * What judging a set of pages answers: whether they form one coherent document (one report, one visit, one admission), and if not,
 * how they divide. Pages are named by the caller's labels. `order` is the order to read them in.
 */
export const groupingSchema = z.object({
  coherent: z.boolean(),
  confidence: z.number().min(0).max(1).default(0.5),
  /** Only when coherent is false: the pages divided into groups that each hold together. Every label once. */
  groups: z.array(z.array(z.string())).default([]),
  order: z.array(z.string()).default([]),
  /** A short title for the document, in its own language, if the pages are one document. */
  title: z.string().nullish(),
  reason: z.string().default(''),
});

/** What a question about the records answers: the text, citing records by label, and the labels it relied on. */
export const chatAnswerSchema = z.object({
  answer: z.string(),
  sources: z.array(z.string()).default([]),
});

/** What a stamp reading answers: nothing for an image that is not a doctor's stamp. */
export const stampReadingSchema = z.object({
  doctors: z.array(
    z.object({
      name: z.string(),
      specialty: z.string().nullish(),
      code: z.string().nullish(),
    }),
  ),
});

export type ValidatedContinuation = z.infer<typeof continuationSchema>;
export type ValidatedExtraction = z.infer<typeof extractionSchema>;

/**
 * Degradation paths, kept here so there is one definition of each rather than a
 * literal inline at the point of failure. A malformed response must not kill a
 * ten-page upload because the model got confused on page seven: a wrong
 * boundary splits a document, which the owner can merge in the review UI, and a
 * failed extraction is visible as its summary. Both are logged.
 */
export const CONTINUATION_FALLBACK: ContinuationResult = {
  is_continuation: false,
  confidence: 0.5,
  reasoning: 'Model response failed validation — defaulted to new document',
};

export const EXTRACTION_FALLBACK: ExtractionResult = {
  title: null,
  doc_date: null,
  provider: null,
  doc_type: 'other',
  ai_summary: 'Extraction failed — review manually.',
  suggested_tags: [],
  doctors: [],
  fields: [],
  measurements: [],
};
