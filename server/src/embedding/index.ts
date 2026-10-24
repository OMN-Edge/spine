import { loadEmbeddingConfig } from '../config.js';
import { createNoneEmbedder } from './adapters/none.js';
import { createRelayEmbedder } from './adapters/relay.js';
import { createVertexEmbedder } from './adapters/vertex.js';
import { EmbedderConfigError, type Embedder, type EmbedderConfig, type EmbedderFactory } from './types.js';

/** A registry, as for the LLM, store and mailer interfaces: a provider is one entry and one file. */
const ADAPTERS = {
  none: createNoneEmbedder,
  vertex: createVertexEmbedder,
  relay: createRelayEmbedder,
} satisfies Record<string, EmbedderFactory>;

export const EMBEDDERS = Object.keys(ADAPTERS);

/** Pure: validates its config and returns an embedder. Testable with a literal. */
export function createEmbedder(config: EmbedderConfig): Embedder {
  const factory = (ADAPTERS as Record<string, EmbedderFactory | undefined>)[config.adapter];
  if (!factory) throw new EmbedderConfigError(`unknown SPINE_EMBEDDINGS "${config.adapter}"; expected one of ${EMBEDDERS.join(', ')}`);
  return factory(config);
}

let _embedder: Embedder | null = null;

/** What the device adds to the embedder's settings: a source of passes for the relay in place of Google credentials. */
let hooks: Pick<EmbedderConfig, 'tokenProvider' | 'fetchImpl'> = {};
export function useEmbedderHooks(next: typeof hooks): void {
  hooks = next;
  _embedder = null;
}

/** Reads config on first use and memoizes. */
export function getEmbedder(): Embedder {
  if (!_embedder) _embedder = createEmbedder({ ...loadEmbeddingConfig(), ...hooks });
  return _embedder;
}

/** Tests only. */
export function resetEmbedder(replacement: Embedder | null = null): void {
  _embedder = replacement;
}

export * from './types.js';
