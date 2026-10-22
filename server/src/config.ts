import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** This file is `server/src/config.ts` or `server/dist/config.js`; the repo is two up. */
const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * Where the database, originals and page images live. The one place this is
 * decided: it used to be resolved separately in four modules, with three
 * different fallbacks relative to the working directory.
 *
 * Read at call time, not module load, so tests and the CLI can set it first.
 * Both systemd units set it explicitly; the fallback is `<repo>/data` wherever
 * the process was started from.
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(REPO_ROOT, 'data');
}

/**
 * Startup configuration, validated once.
 *
 * SECURITY.md P3: the service refuses to start rather than run with an absent,
 * default or weak secret. A fallback secret committed to the repo is a published
 * secret, so there are deliberately no `??` defaults for anything sensitive here.
 */

/** Values that have appeared in this repo or its example env file. */
const PUBLISHED_PLACEHOLDERS = new Set([
  'change-this-to-a-random-64-char-string',
  'dev-secret-change-in-production-must-be-32-chars',
]);

const MIN_SECRET_LENGTH = 32;

/**
 * Model ids and endpoints are configuration, never code (ARCHITECTURE.md). The
 * defaults here are the values that used to be string literals in
 * `continuation.ts` and `extraction.ts`, so an existing `.env` keeps working.
 *
 * There is deliberately no default endpoint: for a provider whose endpoint
 * carries a residency meaning, defaulting it would be the silent fallback P8
 * forbids. The adapter requires it where it matters.
 */
const DEFAULT_LLM_PROVIDER = 'anthropic';
/** Per-provider default endpoint. Only where there is no residency meaning. */
const DEFAULT_ENDPOINTS: Record<string, string> = { anthropic: 'api.anthropic.com' };
const DEFAULT_LLM_MODEL = 'claude-haiku-4-5-20251001';
// The answer is about 50 tokens, but a model that thinks first spends its budget on that: Gemini 2.5 Pro keeps at
// least 128 for it, and a longer think cut the reply off at 256.
const DEFAULT_MAX_TOKENS_CONTINUATION = 1024;
// A document with many values (a lab panel) needs room to list them all.
// A lab bulletin with 40 analytes needs about 6,500 tokens of JSON, measured on Gemini 3.8 Flash; 4096 cut it off
// mid-reply, and Gemini 2.5 Pro spent 1,900 more on thinking. The cap is a ceiling: only what is generated is paid for.
const DEFAULT_MAX_TOKENS_EXTRACTION = 16384;
/**
 * The only limit on how much text goes into one request: the model's context window, in
 * characters, with headroom for the answer and the prompt. 300,000 characters is about
 * 100,000 tokens at the three-or-so characters per token that Romanian text costs, inside
 * a 200,000-token window. Text over it is split into chunks, never cut off.
 */
const DEFAULT_CONTEXT_CHARS = 300_000;
/** Model calls in flight at once. Providers rate-limit and a Pi has few cores, so not unbounded. */
const DEFAULT_CONCURRENCY = 4;
// A dense scanned page (about 100 lines) is 15,000 characters of text and was cut off at 4096 on Gemini 3.8 Flash,
// and read whole at 8192. A ceiling, not a target: a normal page uses a fraction of it.
const DEFAULT_MAX_TOKENS_PAGE = 16384;
const DEFAULT_MAX_RETRIES = 2;

function positiveInteger(
  raw: string | undefined,
  fallback: number,
  name: string,
  problems: string[],
): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    problems.push(`${name} is "${raw}"; needs a positive integer`);
    return fallback;
  }
  return value;
}

export class ConfigError extends Error {
  constructor(problems: string[]) {
    super(
      `Refusing to start — invalid configuration:\n` +
        problems.map(p => `  - ${p}`).join('\n') +
        `\n\nFix ${'.env'} and restart. See SECURITY.md (P3).`,
    );
    this.name = 'ConfigError';
  }
}

export type RegistrationMode = 'operator' | 'open';

export type ParserMode = 'text' | 'ocr' | 'multimodal' | 'hybrid';

export interface ParserEnvConfig {
  mode: string;
  /** The opt-in for page images leaving the host (SECURITY.md M-7). */
  multimodalEnabled: boolean;
  /** Minimum non-whitespace characters for a page to count as having a text layer. */
  textLayerMinChars: number;
  /** Local OCR is kept only at or above this mean word confidence (0-100)... */
  ocrMinConfidence: number;
  /** ...and with no more than this share of words under 60 (0-1). */
  ocrMaxLowShare: number;
  /** Tesseract languages, e.g. `ron+eng`. */
  ocrLangs: string;
  /** Whether `hybrid` tries local OCR before the model. Off: a page with no text layer goes straight to the model. */
  ocrEnabled: boolean;
  /** Pages read at once when images go to the model. Local OCR is always one at a time. */
  concurrency: number;
}

export interface MailEnvConfig {
  adapter: string;
  apiKey?: string;
  sender?: string;
}

export interface EmbeddingEnvConfig {
  adapter: string;
  model: string;
  dims: number;
  endpoint?: string;
  region?: string;
  project?: string;
}

export interface StoreEnvConfig {
  adapter: string;
  location: string;
}

/** A model that can be picked for a reading. The first is `SPINE_LLM_MODEL`, which uploads use. */
export interface ModelChoice {
  id: string;
  label: string;
  /** Where this model runs when that differs from `SPINE_LLM_REGION`: a model is not always served where the default is. */
  region?: string;
  endpoint?: string;
}

export interface LlmEnvConfig {
  provider: string;
  model: string;
  /** Every model offered where a person picks one, the default first. All on the same provider, endpoint, region and project. */
  models: ModelChoice[];
  endpoint?: string;
  region?: string;
  project?: string;
  maxTokens: { continuation: number; extraction: number; page: number };
  maxRetries: number;
  /** The context window in characters: the only cap on the text in a request. */
  contextChars: number;
}

export interface Config {
  /** Interface Fastify binds. Loopback by default: nginx is the only public listener. */
  host: string;
  port: number;
  sessionSecret: string;
  isProduction: boolean;
  store: StoreEnvConfig;
  llm: LlmEnvConfig;
  mail: MailEnvConfig;
  parser: ParserEnvConfig;
  embeddings: EmbeddingEnvConfig;
  /** `operator`: accounts come from the CLI. `open`: anyone may register (needs a mailer). */
  registration: RegistrationMode;
}

/**
 * A link to this instance, for share URLs and the links in mail. `SPINE_DOMAIN` is
 * a bare host; localhost is plain http so development works without TLS.
 */
export function publicUrl(urlPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const host = env.SPINE_DOMAIN || 'localhost:3000';
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  return `${local ? 'http' : 'https'}://${host}${urlPath}`;
}

/**
 * Where the "Shared securely via Spine" footer on a shared page leads (FR-SHR-07): `SPINE_LANDING_URL`, an https address,
 * or null, in which case the footer is text only. Anything else is ignored rather than put in a link a stranger will click.
 */
export function landingUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.SPINE_LANDING_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Where backups go: `SPINE_BACKUP_DIR`, otherwise `backups/` beside the data directory. */
export function resolveBackupDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SPINE_BACKUP_DIR
    ? path.resolve(env.SPINE_BACKUP_DIR)
    : path.join(resolveDataDir(env), '..', 'backups');
}

export const PARSER_MODES: readonly ParserMode[] = ['text', 'ocr', 'multimodal', 'hybrid'];

function readParserConfig(env: NodeJS.ProcessEnv, problems: string[]): ParserEnvConfig {
  // `sidecar` is the old name of `text`, which says what it does (the PDF's own text layer) and not what runs it.
  const requested = env.SPINE_PARSER ?? 'text';
  const mode = requested === 'sidecar' ? 'text' : requested;
  const multimodalEnabled = /^(1|true|yes|on)$/i.test(env.SPINE_MULTIMODAL_ENABLED ?? '');

  if (!(PARSER_MODES as readonly string[]).includes(mode)) {
    problems.push(`SPINE_PARSER is "${mode}"; expected one of ${PARSER_MODES.join(', ')}`);
  }
  if (mode === 'ocr' && /^(0|false|no|off)$/i.test(env.SPINE_OCR ?? '')) {
    problems.push('SPINE_PARSER=ocr with SPINE_OCR=off would read no scanned page; use SPINE_PARSER=text, or turn SPINE_OCR back on');
  }
  // P8 / M-7: sending page images to a model must be asked for twice — once by
  // choosing a parser that does it, once by saying so — so that picking a parser
  // never turns it on by implication.
  if ((mode === 'multimodal' || mode === 'hybrid') && !multimodalEnabled) {
    problems.push(
      `SPINE_PARSER=${mode} sends page images to the LLM provider, which needs ` +
        'SPINE_MULTIMODAL_ENABLED=true as well. It is a separate switch on purpose.',
    );
  }
  // First guesses, measured on Romanian print and handwriting-style fonts: clean print
  // reads at about 93 with no weak words, 3-degree tilt at 87 with 6%, and the cursive
  // fonts at 76-81 with 11-18%. Real handwriting is probably worse, but that is
  // untested, so these are meant to be tuned from the per-page routing log.
  const number = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) {
      problems.push(`${name} is "${raw}"; needs a number from ${min} to ${max}`);
      return fallback;
    }
    return value;
  };

  const ocrLangs = env.SPINE_OCR_LANGS || 'ron+eng';
  if (!/^[a-z_]+(\+[a-z_]+)*$/.test(ocrLangs)) {
    problems.push(`SPINE_OCR_LANGS is "${ocrLangs}"; expected Tesseract codes joined by +, e.g. ron+eng`);
  }

  return {
    mode,
    multimodalEnabled,
    textLayerMinChars: number('SPINE_TEXT_LAYER_MIN_CHARS', 50, 1, 100_000),
    ocrMinConfidence: number('SPINE_OCR_MIN_CONFIDENCE', 85, 0, 100),
    ocrMaxLowShare: number('SPINE_OCR_MAX_LOW_SHARE', 0.1, 0, 1),
    concurrency: Math.trunc(number('SPINE_LLM_CONCURRENCY', DEFAULT_CONCURRENCY, 1, 16)),
    ocrLangs,
    ocrEnabled: !/^(0|false|no|off)$/i.test(env.SPINE_OCR ?? ''),
  };
}

/** The parser section on its own, for `getParser()`. */
export function loadParserConfig(env: NodeJS.ProcessEnv = process.env): ParserEnvConfig {
  const problems: string[] = [];
  const parser = readParserConfig(env, problems);
  if (problems.length > 0) throw new ConfigError(problems);
  return parser;
}

const REGISTRATION_MODES: readonly RegistrationMode[] = ['operator', 'open'];

function readMailConfig(
  env: NodeJS.ProcessEnv,
  problems: string[],
): { mail: MailEnvConfig; registration: RegistrationMode } {
  const adapter = env.SPINE_MAILER ?? 'none';
  const mail: MailEnvConfig = {
    adapter,
    apiKey: env.BREVO_API_KEY || undefined,
    sender: env.SPINE_MAIL_SENDER || undefined,
  };

  const rawRegistration = env.SPINE_REGISTRATION ?? 'operator';
  if (!(REGISTRATION_MODES as readonly string[]).includes(rawRegistration)) {
    problems.push(`SPINE_REGISTRATION is "${rawRegistration}"; expected one of ${REGISTRATION_MODES.join(', ')}`);
  }
  const registration = (rawRegistration === 'open' ? 'open' : 'operator') as RegistrationMode;

  // P3: open signup needs verifiable addresses, and verifying needs mail. Refuse
  // to start rather than accept accounts nobody can confirm.
  if (registration === 'open' && adapter === 'none') {
    problems.push('SPINE_REGISTRATION=open needs a mailer, but SPINE_MAILER is none (open signup verifies addresses by email)');
  }
  if (adapter === 'brevo') {
    if (!mail.apiKey) problems.push('SPINE_MAILER=brevo needs BREVO_API_KEY');
    if (!mail.sender) problems.push('SPINE_MAILER=brevo needs SPINE_MAIL_SENDER (pick a neutral name: it is visible in the recipient\'s inbox)');
    if (!env.SPINE_DOMAIN) problems.push('SPINE_MAILER=brevo needs SPINE_DOMAIN, which the links in mail point at');
  }
  return { mail, registration };
}

/**
 * Embeddings (similarity by meaning). Off unless asked for; on, they are Vertex at a stated endpoint, region and project
 * (taken from the chat model's settings when that is Vertex too), never defaulted: residency is a property of the endpoint.
 */
function readEmbeddingConfig(env: NodeJS.ProcessEnv, problems: string[]): EmbeddingEnvConfig {
  const adapter = (env.SPINE_EMBEDDINGS ?? 'none').toLowerCase();
  const chatIsVertex = (env.SPINE_LLM_PROVIDER ?? 'anthropic') === 'vertex';
  const inherit = (own: string | undefined, llm: string | undefined) => (own || (chatIsVertex ? llm : undefined) || undefined);
  const rawDims = env.SPINE_EMBEDDING_DIMS ?? '768';
  const dims = Number(rawDims);
  if (!Number.isInteger(dims) || dims < 128 || dims > 3072) problems.push(`SPINE_EMBEDDING_DIMS is "${rawDims}"; needs an integer 128-3072`);
  const config: EmbeddingEnvConfig = {
    adapter,
    model: env.SPINE_EMBEDDING_MODEL || 'gemini-embedding-2',
    dims,
    endpoint: inherit(env.SPINE_EMBEDDING_ENDPOINT, env.SPINE_LLM_ENDPOINT),
    region: inherit(env.SPINE_EMBEDDING_REGION, env.SPINE_LLM_REGION),
    project: inherit(env.SPINE_EMBEDDING_PROJECT, env.SPINE_LLM_PROJECT),
  };
  if (adapter === 'vertex') {
    if (!config.endpoint) problems.push('SPINE_EMBEDDINGS=vertex needs SPINE_EMBEDDING_ENDPOINT (or SPINE_LLM_ENDPOINT with SPINE_LLM_PROVIDER=vertex): residency is a property of the endpoint, so there is no default');
    if (!config.region) problems.push('SPINE_EMBEDDINGS=vertex needs SPINE_EMBEDDING_REGION (or SPINE_LLM_REGION)');
    if (!config.project) problems.push('SPINE_EMBEDDINGS=vertex needs SPINE_EMBEDDING_PROJECT (or SPINE_LLM_PROJECT)');
  }
  return config;
}

/** The embeddings section on its own, so `getEmbedder()` does not depend on unrelated settings. */
export function loadEmbeddingConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingEnvConfig {
  const problems: string[] = [];
  const config = readEmbeddingConfig(env, problems);
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/** The registration mode on its own, for the account routes. */
export function loadRegistrationMode(env: NodeJS.ProcessEnv = process.env): RegistrationMode {
  const problems: string[] = [];
  const { registration } = readMailConfig(env, problems);
  if (problems.length > 0) throw new ConfigError(problems);
  return registration;
}

/** The mail section on its own, so `getMailer()` does not depend on unrelated settings. */
export function loadMailConfig(env: NodeJS.ProcessEnv = process.env): MailEnvConfig {
  const problems: string[] = [];
  const { mail } = readMailConfig(env, problems);
  if (problems.length > 0) throw new ConfigError(problems);
  return mail;
}

/**
 * The store section on its own, for the same reason as `loadLlmConfig` below:
 * `getStore()` should not fail because an unrelated secret is missing.
 *
 * `DATA_DIR` and `SPINE_DB_PATH` keep their current meaning so an existing
 * deployment needs no change.
 */
export function loadStoreConfig(env: NodeJS.ProcessEnv = process.env): StoreEnvConfig {
  const problems: string[] = [];
  const store = readStoreConfig(env, problems);
  if (problems.length > 0) throw new ConfigError(problems);
  return store;
}

function readStoreConfig(env: NodeJS.ProcessEnv, problems: string[]): StoreEnvConfig {
  const location = env.SPINE_DB_PATH ?? path.join(resolveDataDir(env), 'spine.db');

  if (location.trim().length === 0) problems.push('SPINE_DB_PATH is empty');

  return { adapter: env.SPINE_STORE ?? 'sqlite', location };
}

/**
 * The LLM section on its own, so `getChatLlm()` can read it without dragging in
 * secret validation: a missing SESSION_SECRET should stop the server at
 * startup, not make an ingestion call fail for an unrelated reason.
 */
export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmEnvConfig {
  const problems: string[] = [];
  const llm = readLlmConfig(env, problems);
  if (problems.length > 0) throw new ConfigError(problems);
  return llm;
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const MAX_MODEL_CHOICES = 8;

/**
 * The host for a stated region, for a model that runs somewhere other than the default. Stated, never
 * guessed: `global` is refused because it says nothing about where a request is handled, and anything that
 * is not a region name is refused rather than turned into a host.
 */
function endpointForRegion(region: string): string | null {
  if (/^(eu|us)$/.test(region)) return `aiplatform.${region}.rep.googleapis.com`;
  if (/^[a-z]+-[a-z]+[0-9]+$/.test(region)) return `${region}-aiplatform.googleapis.com`;
  return null;
}

/**
 * `SPINE_LLM_MODELS`: the models offered where a person picks one ("Read with AI", "Extract details
 * again"), comma separated, each `id` or `id=Label`. The default model is always first and is listed
 * even if it is not named; naming it here only gives it a label (or a region). Ids are checked against this list on
 * every request, so a client cannot ask for a model the operator did not offer. A model that is not served
 * where the default is takes its own region, `id|europe-west4=Label`; its host follows from the region and
 * the response says where each choice runs, so a person is told where their pages would go.
 */
function readModelChoices(env: NodeJS.ProcessEnv, defaultModel: string, problems: string[]): ModelChoice[] {
  const choices: ModelChoice[] = [{ id: defaultModel, label: defaultModel }];
  for (const entry of (env.SPINE_LLM_MODELS ?? '').split(',')) {
    const text = entry.trim();
    if (!text) continue;
    // id[|region][=Label]. The label may hold anything but a comma; an id may hold an @ (a version).
    const [left, ...rest] = text.split('=');
    const [rawId, rawRegion] = left.split('|');
    const id = rawId.trim();
    const region = rawRegion === undefined ? undefined : rawRegion.trim();
    const label = rest.join('=').trim() || id;
    if (!MODEL_ID.test(id)) {
      problems.push(`SPINE_LLM_MODELS has "${id}", which is not a model id (letters, digits and . _ : @ / -)`);
      continue;
    }
    let endpoint: string | undefined;
    if (region !== undefined) {
      if (env.SPINE_LLM_PROVIDER !== 'vertex') {
        problems.push(`SPINE_LLM_MODELS names a region for ${id}, which only means something with SPINE_LLM_PROVIDER=vertex`);
        continue;
      }
      endpoint = endpointForRegion(region) ?? undefined;
      if (!endpoint) {
        problems.push(`SPINE_LLM_MODELS: "${region}" for ${id} is not a region (use eu, us or a name like europe-west4; global is refused)`);
        continue;
      }
    }
    const existing = choices.find(choice => choice.id === id);
    if (existing) { existing.label = label; if (region) { existing.region = region; existing.endpoint = endpoint; } }
    else choices.push({ id, label, ...(region ? { region, endpoint } : {}) });
  }
  if (choices.length > MAX_MODEL_CHOICES) problems.push(`SPINE_LLM_MODELS offers ${choices.length} models; the most is ${MAX_MODEL_CHOICES}`);
  return choices;
}

function readLlmConfig(env: NodeJS.ProcessEnv, problems: string[]): LlmEnvConfig {
  const llm: LlmEnvConfig = {
    provider: env.SPINE_LLM_PROVIDER ?? DEFAULT_LLM_PROVIDER,
    model: env.SPINE_LLM_MODEL ?? DEFAULT_LLM_MODEL,
    models: [],
    endpoint:
      env.SPINE_LLM_ENDPOINT ||
      DEFAULT_ENDPOINTS[env.SPINE_LLM_PROVIDER ?? DEFAULT_LLM_PROVIDER] ||
      undefined,
    region: env.SPINE_LLM_REGION || undefined,
    project: env.SPINE_LLM_PROJECT || undefined,
    maxTokens: {
      continuation: positiveInteger(
        env.SPINE_LLM_MAX_TOKENS_CONTINUATION,
        DEFAULT_MAX_TOKENS_CONTINUATION,
        'SPINE_LLM_MAX_TOKENS_CONTINUATION',
        problems,
      ),
      extraction: positiveInteger(
        env.SPINE_LLM_MAX_TOKENS_EXTRACTION,
        DEFAULT_MAX_TOKENS_EXTRACTION,
        'SPINE_LLM_MAX_TOKENS_EXTRACTION',
        problems,
      ),
      page: positiveInteger(
        env.SPINE_LLM_MAX_TOKENS_PAGE,
        DEFAULT_MAX_TOKENS_PAGE,
        'SPINE_LLM_MAX_TOKENS_PAGE',
        problems,
      ),
    },
    maxRetries: positiveInteger(
      env.SPINE_LLM_MAX_RETRIES,
      DEFAULT_MAX_RETRIES,
      'SPINE_LLM_MAX_RETRIES',
      problems,
    ),
    contextChars: positiveInteger(
      env.SPINE_LLM_CONTEXT_CHARS,
      DEFAULT_CONTEXT_CHARS,
      'SPINE_LLM_CONTEXT_CHARS',
      problems,
    ),
  };
  if (llm.contextChars < 10_000) problems.push('SPINE_LLM_CONTEXT_CHARS is below 10,000, which is too small for a page of text');

  if (llm.model.trim().length === 0) problems.push('SPINE_LLM_MODEL is empty');
  llm.models = readModelChoices(env, llm.model, problems);
  return llm;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];

  const sessionSecret = env.SESSION_SECRET ?? '';
  if (sessionSecret.length === 0) {
    problems.push('SESSION_SECRET is not set');
  } else if (sessionSecret.length < MIN_SECRET_LENGTH) {
    problems.push(
      `SESSION_SECRET is ${sessionSecret.length} chars; needs at least ${MIN_SECRET_LENGTH}`,
    );
  } else if (PUBLISHED_PLACEHOLDERS.has(sessionSecret)) {
    problems.push('SESSION_SECRET is a placeholder published in this repository');
  }

  const rawPort = env.PORT ?? '3000';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`PORT is "${rawPort}"; needs an integer 1-65535`);
  }

  const store = readStoreConfig(env, problems);
  const llm = readLlmConfig(env, problems);
  const { mail, registration } = readMailConfig(env, problems);
  const parser = readParserConfig(env, problems);
  const embeddings = readEmbeddingConfig(env, problems);

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    // Binding loopback keeps trust boundary 2 intact: with trustProxy enabled,
    // a directly reachable Fastify means attacker-controlled X-Forwarded-*.
    host: env.SPINE_HOST ?? '127.0.0.1',
    port,
    sessionSecret,
    isProduction: env.NODE_ENV === 'production',
    store,
    llm,
    mail,
    parser,
    embeddings,
    registration,
  };
}

/** How many model calls may be in flight at once (`SPINE_LLM_CONCURRENCY`, default 4). */
export function llmConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  return loadParserConfig(env).concurrency;
}

/** The context window in characters, the only cap on the text sent in one request. */
export function llmContextChars(env: NodeJS.ProcessEnv = process.env): number {
  return loadLlmConfig(env).contextChars;
}

/**
 * `SPINE_TRANSLATION=off` stops documents being translated into the reader's language: the details and the
 * owner's notes then stay in the language they were written in. Translating sends that text to the LLM
 * provider (SECURITY.md P8), so an operator who does not want that turns it off. On by default.
 */
export function translationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|no|off)$/i.test(env.SPINE_TRANSLATION ?? '');
}

/**
 * `SPINE_LINKING=off` stops the app looking for links between documents (a consultation and the tests it asked for, a
 * follow-up). Looking sends the summary cards of up to seven documents per document to the LLM provider (SECURITY.md
 * P8, M-16), so an operator who does not want that turns it off. Links the owner adds by hand still work. On by default.
 */
export function linkingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|no|off)$/i.test(env.SPINE_LINKING ?? '');
}

/**
 * `SPINE_CHAT=off` removes the page where the owner asks questions of their records. Each question sends the question and
 * the summary cards and results of the records found for it to the LLM provider (SECURITY.md P8, M-18), so an operator who
 * does not want that turns it off. On by default.
 */
export function chatEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|no|off)$/i.test(env.SPINE_CHAT ?? '');
}


export interface SessionLimits {
  /** A sign-in unused for this long ends (`SPINE_SESSION_IDLE_HOURS`, default 24). */
  idleMs: number;
  /** A sign-in ends this long after it began, however much it is used (`SPINE_SESSION_DAYS`, default 14). */
  absoluteMs: number;
}

/** How long a sign-in lasts (SECURITY.md S-33). A bad value falls back to the default rather than lengthening a session. */
export function sessionLimits(env: NodeJS.ProcessEnv = process.env): SessionLimits {
  const positive = (raw: string | undefined, fallback: number, max: number) => {
    const n = Number(raw);
    return raw !== undefined && raw !== '' && Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
  };
  return {
    idleMs: positive(env.SPINE_SESSION_IDLE_HOURS, 24, 24 * 30) * 60 * 60 * 1000,
    absoluteMs: positive(env.SPINE_SESSION_DAYS, 14, 90) * 24 * 60 * 60 * 1000,
  };
}

/**
 * Model calls allowed a day, whoever asks (`SPINE_LLM_DAILY_CALLS`, default 5000, 0 for no ceiling). The per-route
 * limits bound one caller; this bounds the instance, so a leaked share link with chat on, or a loop, cannot run up
 * the provider's bill unnoticed (SECURITY.md S-35). A bad value falls back to the default.
 */
export function llmDailyCalls(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SPINE_LLM_DAILY_CALLS;
  if (raw === undefined || raw === '') return 5000;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 5000;
}
