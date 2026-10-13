import { z } from 'zod';
import type { ContinuationResult, ExtractionResult } from '../types.js';
import type { TaskClients, TaskSpecs } from './tasks.js';

/**
 * The LLM interface. Two stateless, single-turn calls — no chaining, no agent loop,
 * no tool use, no multi-turn state (ARCHITECTURE.md). What looks like a chain
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
  extractFields(documentText: string, knownTests?: string[]): Promise<ExtractionResult>;
  /**
   * Read one page image: the text on it and where. **This is the only call that
   * sends an image off the host** (SECURITY.md M-7), so it is reached only through
   * the multimodal parser, which is off unless the operator turns it on.
   * Null if the model's answer could not be used.
   */
  readPage(imagePath: string): Promise<PageReading | null>;
  /**
   * Read the doctors' names, specialties and professional codes off signature stamps: small images cut
   * from a document's last page, never a whole page. **The second call that sends an image off the host**
   * (SECURITY.md M-7), under the same operator switch; the caller checks it. Null if the answer could not
   * be used.
   */
  readStamps(imagePaths: string[]): Promise<StampReading | null>;
}

export interface StampReading {
  doctors: Array<{ name: string; specialty: string | null; code: string | null }>;
}

/** A block of text on a page, with its box as fractions (0–1) of the page, from the top left. */
export interface PageRegion {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
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

/**
 * Coordinates are plain numbers here and clamped afterwards, rather than bounded
 * in the schema: a model that answers 1.02 for a box at the page edge should still
 * be usable, not fail the whole page.
 */
export const pageReadingSchema = z.object({
  regions: z.array(
    z.object({
      text: z.string(),
      x0: z.number(),
      y0: z.number(),
      x1: z.number(),
      y1: z.number(),
    }),
  ),
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
