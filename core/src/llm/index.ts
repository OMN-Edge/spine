import { loadLlmConfig } from '../config.js';
import { logger } from '../logger.js';
import { buildChatLlm } from './chat-llm.js';
import { buildTaskSpecs, type TaskClients } from './tasks.js';
import { createRelayChat } from './adapters/relay.js';
import {
  LlmConfigError,
  type ChatLlm,
  type ChatLlmConfig,
  type TaskClientsFactory,
} from './types.js';

/**
 * Dispatch is a registry, not a switch: adding a provider is one adapter file and one registration, with no conditional every provider
 * has to pass through. This package knows one, `relay`, which is what the device uses: it calls the relay, which holds the credential and
 * runs the task through the provider it is configured with. The providers themselves (anthropic, vertex) are the relay service's, in
 * `server/src/llm/adapters/`, and it registers them (`server/src/providers.ts`), so this package carries no vendor SDK.
 */
const ADAPTERS: Record<string, TaskClientsFactory> = {
  relay: createRelayChat,
};

/** Adds a provider. Called once at start-up by the process that runs one. */
export function registerLlmProvider(name: string, factory: TaskClientsFactory): void {
  ADAPTERS[name] = factory;
}

export const llmProviders = (): string[] => Object.keys(ADAPTERS);

/**
 * Construction. Pure: validates its config, returns a new port, touches no
 * global state — so it is unit-testable with a config literal.
 *
 * Synchronous, because nothing here is asynchronous: both adapters just
 * construct client objects, and the provider SDKs resolve credentials lazily on
 * the first request. (An earlier version was `async`, which forced a separate
 * `initChatLlm()` at startup so that `getChatLlm()` could stay sync. Neither
 * was needed.)
 */
export function createChatLlm(config: ChatLlmConfig): ChatLlm {
  return buildChatLlm(createTaskClients(config), config);
}

/**
 * The adapter's clients, one per task, before the interface wraps them: what the relay serves a device's call with.
 * The adapter is handed all the tasks up front and builds a client for each.
 */
export function createTaskClients(config: ChatLlmConfig): TaskClients {
  const factory: TaskClientsFactory | undefined = ADAPTERS[config.provider];
  if (!factory) {
    throw new LlmConfigError(
      `unknown SPINE_LLM_PROVIDER "${config.provider}"; expected one of ${llmProviders().join(', ')}`,
    );
  }
  return factory(config, buildTaskSpecs(config));
}

let _chatLlm: ChatLlm | null = null;
const _byModel = new Map<string, ChatLlm>();

/**
 * Access. Reads configuration on first use and memoizes, mirroring `getDb()` —
 * except that the construction half is `createChatLlm` above, so it stays
 * testable without touching process state.
 *
 * Config is read here rather than at module load, which is the bug that makes
 * `SPINE_DB_PATH` have to be set before `db/index.ts` is first imported. It
 * reads only the LLM section, so a missing SESSION_SECRET is not this
 * function's problem.
 *
 * The composition root calls this once at startup so a bad provider or
 * credential stops the process there (P3) rather than surfacing at the first
 * ingestion — but nothing depends on that having happened.
 */
export function getChatLlm(model?: string): ChatLlm {
  const config = loadLlmConfig();
  if (!model || model === config.model) {
    if (!_chatLlm) _chatLlm = createChatLlm(config);
    return _chatLlm;
  }
  // Another model on the same provider, endpoint, region and project. Only one the operator listed.
  const choice = config.models.find(c => c.id === model);
  if (!choice) {
    throw new LlmConfigError(`the model "${model}" is not offered; SPINE_LLM_MODELS lists the choices`);
  }
  let llm = _byModel.get(model);
  if (!llm) {
    // A model not served where the default is brings its own region and host, stated in the list.
    const where = choice.region ? { region: choice.region, endpoint: choice.endpoint } : {};
    llm = createChatLlm({ ...config, model, ...where });
    _byModel.set(model, llm);
    // As for the default at startup: where each model runs has to be observable.
    logger.info('llm model ready', { model, endpoint: where.endpoint ?? config.endpoint, region: where.region ?? config.region });
  }
  return llm;
}

/**
 * A model named in a request: undefined if none was named (use the default), the id if it is one the
 * operator offered, null if it is not, which the caller answers with a 400.
 */
export function chooseModel(requested: unknown): string | undefined | null {
  if (requested === undefined || requested === null || requested === '') return undefined;
  if (typeof requested !== 'string') return null;
  return loadLlmConfig().models.some(choice => choice.id === requested) ? requested : null;
}

/** Tests only, as `resetDb()` is. */
export function resetChatLlm(replacement: ChatLlm | null = null, byModel: Record<string, ChatLlm> = {}): void {
  _chatLlm = replacement;
  _byModel.clear();
  for (const [model, llm] of Object.entries(byModel)) _byModel.set(model, llm);
}

export * from './types.js';
export {
  LLM_TASKS,
  type LlmTask,
  type TaskClients,
  type TaskSpec,
  type TaskSpecs,
} from './tasks.js';
