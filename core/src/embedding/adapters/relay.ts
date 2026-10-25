import { postToRelay } from '../../llm/adapters/relay.js';
import { EmbedderConfigError, type EmbedderConfig, type EmbedderFactory } from '../types.js';

/**
 * Embeddings through the relay: texts out, vectors back, with the relay's own embedder (whichever provider it is configured for) doing the
 * work. The relay's pass comes from `useRelayHooks`, as for the chat models. `space` keeps the name the vectors had when the server made
 * them itself (`vertex:gemini-embedding-2:768`), so a move to a relay does not make every stored vector stale.
 */
const BATCH = 16;

export const createRelayEmbedder: EmbedderFactory = (config: EmbedderConfig) => {
  const { endpoint, model, dims } = config;
  if (!endpoint) throw new EmbedderConfigError('SPINE_EMBEDDINGS=relay requires the relay\'s host (SPINE_EMBEDDING_ENDPOINT)');
  return {
    enabled: true,
    id: config.space ?? `relay:${model}:${dims}`,
    dims,
    async embed(texts, kind) {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const res = await postToRelay(endpoint, '/v1/embed', { texts: texts.slice(i, i + BATCH), kind });
        const { vectors } = (await res.json()) as { vectors: number[][] };
        for (const v of vectors) {
          if (!Array.isArray(v) || v.length !== dims || !v.every(x => typeof x === 'number' && Number.isFinite(x))) throw new Error(`the embedding service returned ${Array.isArray(v) ? v.length : 'no'} values, expected ${dims}`);
          out.push(Float32Array.from(v));
        }
      }
      if (out.length !== texts.length) throw new Error('the embedding service returned the wrong number of vectors');
      return out;
    },
  };
};
