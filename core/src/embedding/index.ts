import { loadEmbeddingConfig } from '../config.js';
import { createNoneEmbedder } from './adapters/none.js';
import { createRelayEmbedder } from './adapters/relay.js';
import { EmbedderConfigError, type Embedder, type EmbedderConfig, type EmbedderFactory } from './types.js';

/** A registry, as for the LLM, store and mailer interfaces: a provider is one entry and one file. The relay service adds `vertex` (see `llm/index.ts`). */
const ADAPTERS: Record<string, EmbedderFactory> = {
  none: createNoneEmbedder,
  relay: createRelayEmbedder,
};

/** Adds a provider. Called once at start-up by the process that runs one. */
export function registerEmbedder(name: string, factory: EmbedderFactory): void {
  ADAPTERS[name] = factory;
}

export const embedders = (): string[] => Object.keys(ADAPTERS);

/** Pure: validates its config and returns an embedder. Testable with a literal. */
export function createEmbedder(config: EmbedderConfig): Embedder {
  const factory: EmbedderFactory | undefined = ADAPTERS[config.adapter];
  if (!factory) throw new EmbedderConfigError(`unknown SPINE_EMBEDDINGS "${config.adapter}"; expected one of ${embedders().join(', ')}`);
  return factory(config);
}

let _embedder: Embedder | null = null;

/** Reads config on first use and memoizes. */
export function getEmbedder(): Embedder {
  if (!_embedder) _embedder = createEmbedder(loadEmbeddingConfig());
  return _embedder;
}

/** Tests only. */
export function resetEmbedder(replacement: Embedder | null = null): void {
  _embedder = replacement;
}

export * from './types.js';
