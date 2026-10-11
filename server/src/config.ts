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
const DEFAULT_MAX_TOKENS_CONTINUATION = 256;
const DEFAULT_MAX_TOKENS_EXTRACTION = 2048;
const DEFAULT_MAX_TOKENS_PAGE = 4096;
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

export type ParserMode = 'sidecar' | 'multimodal' | 'hybrid';

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
}

export interface MailEnvConfig {
  adapter: string;
  apiKey?: string;
  sender?: string;
}

export interface StoreEnvConfig {
  adapter: string;
  location: string;
}

export interface LlmEnvConfig {
  provider: string;
  model: string;
  endpoint?: string;
  region?: string;
  project?: string;
  maxTokens: { continuation: number; extraction: number; page: number };
  maxRetries: number;
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

/** Where backups go: `SPINE_BACKUP_DIR`, otherwise `backups/` beside the data directory. */
export function resolveBackupDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SPINE_BACKUP_DIR
    ? path.resolve(env.SPINE_BACKUP_DIR)
    : path.join(resolveDataDir(env), '..', 'backups');
}

export const PARSER_MODES: readonly ParserMode[] = ['sidecar', 'multimodal', 'hybrid'];

function readParserConfig(env: NodeJS.ProcessEnv, problems: string[]): ParserEnvConfig {
  const mode = env.SPINE_PARSER ?? 'sidecar';
  const multimodalEnabled = /^(1|true|yes|on)$/i.test(env.SPINE_MULTIMODAL_ENABLED ?? '');

  if (!(PARSER_MODES as readonly string[]).includes(mode)) {
    problems.push(`SPINE_PARSER is "${mode}"; expected one of ${PARSER_MODES.join(', ')}`);
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
    ocrLangs,
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

function readLlmConfig(env: NodeJS.ProcessEnv, problems: string[]): LlmEnvConfig {
  const llm: LlmEnvConfig = {
    provider: env.SPINE_LLM_PROVIDER ?? DEFAULT_LLM_PROVIDER,
    model: env.SPINE_LLM_MODEL ?? DEFAULT_LLM_MODEL,
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
  };

  if (llm.model.trim().length === 0) problems.push('SPINE_LLM_MODEL is empty');
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
    registration,
  };
}
