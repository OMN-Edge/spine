import {
  ConfigError,
  readEmbeddingConfig,
  readLlmConfig,
  readParserConfig,
  readStoreConfig,
  type EmbeddingEnvConfig,
  type LlmEnvConfig,
  type ParserEnvConfig,
  type StoreEnvConfig,
} from 'spine-core/config.js';

/**
 * The settings only the server has: its port and secret, who may register, the mailer, how long a sign-in lasts, and what an account may
 * keep in the vault and publish as sealed shares. The settings the device shares (the model, the parser, the store, the data
 * directory) are in `core/src/config.ts`, and `loadConfig` reads them together so a bad value of any is reported at once.
 */

/** Values that have appeared in this repo or its example env file. */
const PUBLISHED_PLACEHOLDERS = new Set([
  'change-this-to-a-random-64-char-string',
  'dev-secret-change-in-production-must-be-32-chars',
]);

const MIN_SECRET_LENGTH = 32;

export type RegistrationMode = 'operator' | 'open' | 'approval';
export type InstanceKind = 'public' | 'private';

export interface MailEnvConfig {
  adapter: string;
  apiKey?: string;
  sender?: string;
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
  /** `operator`: accounts come from the CLI. `open`: anyone may register (needs a mailer). `approval`: anyone may ask for an account, which waits for the administrator. */
  registration: RegistrationMode;
  /** `private` labels the instance as a private deployment and refuses open signup (`SPINE_INSTANCE`). */
  instance: InstanceKind;
}

export const REGISTRATION_MODES: readonly RegistrationMode[] = ['operator', 'open', 'approval'];

function readMailConfig(
  env: NodeJS.ProcessEnv,
  problems: string[],
): { mail: MailEnvConfig; registration: RegistrationMode; instance: InstanceKind } {
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
  const registration = ((REGISTRATION_MODES as readonly string[]).includes(rawRegistration) ? rawRegistration : 'operator') as RegistrationMode;

  const rawInstance = env.SPINE_INSTANCE ?? 'public';
  if (rawInstance !== 'public' && rawInstance !== 'private') problems.push(`SPINE_INSTANCE is "${rawInstance}"; expected public or private`);
  const instance: InstanceKind = rawInstance === 'private' ? 'private' : 'public';
  // A private deployment is for the people its administrator lets in: it never accepts open signup, by mistake or otherwise.
  if (instance === 'private' && registration === 'open') {
    problems.push('SPINE_INSTANCE=private does not accept SPINE_REGISTRATION=open: use approval (people ask, the administrator approves) or operator (the administrator creates accounts)');
  }

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
  return { mail, registration, instance };
}

/** The registration mode on its own, for the account routes. */
export function loadRegistrationMode(env: NodeJS.ProcessEnv = process.env): RegistrationMode {
  const problems: string[] = [];
  const { registration } = readMailConfig(env, problems);
  if (problems.length > 0) throw new ConfigError(problems);
  return registration;
}

/** Whether this is a private deployment, for the pages that say so. */
export function loadInstanceKind(env: NodeJS.ProcessEnv = process.env): InstanceKind {
  const problems: string[] = [];
  const { instance } = readMailConfig(env, problems);
  if (problems.length > 0) throw new ConfigError(problems);
  return instance;
}

/** The addresses that may approve accounts from the app (`SPINE_ADMIN_EMAILS`, comma separated, compared lower-cased). The CLI needs none. */
export function adminEmails(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env.SPINE_ADMIN_EMAILS ?? '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean));
}

/** The mail section on its own, so `getMailer()` does not depend on unrelated settings. */
export function loadMailConfig(env: NodeJS.ProcessEnv = process.env): MailEnvConfig {
  const problems: string[] = [];
  const { mail } = readMailConfig(env, problems);
  if (problems.length > 0) throw new ConfigError(problems);
  return mail;
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
  const { mail, registration, instance } = readMailConfig(env, problems);
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
    instance,
  };
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
 * What one account may keep in its vault (ciphertext, so a count of bytes and nothing else): `SPINE_VAULT_MAX_MB` for the whole
 * account (default 5120) and `SPINE_VAULT_MAX_OBJECT_MB` for one object (default 100). A bad value gives the default.
 */
export function vaultLimits(env: NodeJS.ProcessEnv = process.env): { accountBytes: number; objectBytes: number } {
  const mb = (raw: string | undefined, fallback: number) => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) * 1024 * 1024 : fallback * 1024 * 1024;
  };
  return { accountBytes: mb(env.SPINE_VAULT_MAX_MB, 5120), objectBytes: mb(env.SPINE_VAULT_MAX_OBJECT_MB, 100) };
}

/**
 * What one account may publish as sealed shares (docs/crypto-design.md, stage 4): bytes only, since the server cannot see what is in
 * them. `SPINE_SHARE_MAX_MB` for one sealed database or page image (default 100), `SPINE_SHARE_MAX_TOTAL_MB` for all of an account's
 * live shares together (default 1024), `SPINE_SHARE_MAX_LIVE` for how many are live at once (default 50). A bad value gives the default.
 */
/**
 * Whether a visitor may upload their own files in the demo (SECURITY.md M-39), and how many: `SPINE_DEMO_UPLOADS=on` (default off: each
 * visitor costs model calls the operator pays for), `SPINE_DEMO_MAX_UPLOADS` files (default 3), the first `SPINE_DEMO_MAX_PAGES` pages of
 * each (default 5). A bad number gives the default. These are what the demo's core is told; the relay's count is what bounds the calls.
 */
export function demoUploads(env: NodeJS.ProcessEnv = process.env): { uploads: number; pages: number } | null {
  if ((env.SPINE_DEMO_UPLOADS ?? '').trim().toLowerCase() !== 'on') return null;
  const n = (raw: string | undefined, fallback: number) => (Number.isInteger(Number(raw)) && Number(raw) >= 1 ? Number(raw) : fallback);
  return { uploads: n(env.SPINE_DEMO_MAX_UPLOADS, 3), pages: n(env.SPINE_DEMO_MAX_PAGES, 5) };
}

export function sharedLimits(env: NodeJS.ProcessEnv = process.env): { partBytes: number; totalBytes: number; live: number } {
  const n = (raw: string | undefined, fallback: number) => (Number.isFinite(Number(raw)) && Number(raw) >= 1 ? Math.floor(Number(raw)) : fallback);
  return { partBytes: n(env.SPINE_SHARE_MAX_MB, 100) * 1024 * 1024, totalBytes: n(env.SPINE_SHARE_MAX_TOTAL_MB, 1024) * 1024 * 1024, live: n(env.SPINE_SHARE_MAX_LIVE, 50) };
}
