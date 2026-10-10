import { loadLlmConfig } from '../config.js';
import { buildChatLlm } from './chat-llm.js';
import { buildTaskSpecs } from './tasks.js';
import { createAnthropicChat } from './adapters/anthropic.js';
import { createVertexChat } from './adapters/vertex.js';
import {
  LlmConfigError,
  type ChatLlm,
  type ChatLlmConfig,
  type TaskClientsFactory,
} from './types.js';

/**
 * Dispatch is a registry, not a switch: adding a provider is a map entry plus
 * an adapter file, with no conditional every provider has to pass through.
 */
const ADAPTERS = {
  anthropic: createAnthropicChat,
  vertex: createVertexChat,
} satisfies Record<string, TaskClientsFactory>;

export const LLM_PROVIDERS = Object.keys(ADAPTERS);

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
  const factory = (ADAPTERS as Record<string, TaskClientsFactory | undefined>)[config.provider];
  if (!factory) {
    throw new LlmConfigError(
      `unknown SPINE_LLM_PROVIDER "${config.provider}"; expected one of ${LLM_PROVIDERS.join(', ')}`,
    );
  }
  // The adapter is handed both tasks up front and builds a client for each.
  return buildChatLlm(factory(config, buildTaskSpecs(config)), config);
}

let _chatLlm: ChatLlm | null = null;

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
export function getChatLlm(): ChatLlm {
  if (!_chatLlm) _chatLlm = createChatLlm(loadLlmConfig());
  return _chatLlm;
}

/** Tests only, as `resetDb()` is. */
export function resetChatLlm(replacement: ChatLlm | null = null): void {
  _chatLlm = replacement;
}

export * from './types.js';
export {
  LLM_TASKS,
  type LlmTask,
  type TaskClients,
  type TaskSpec,
  type TaskSpecs,
} from './tasks.js';
