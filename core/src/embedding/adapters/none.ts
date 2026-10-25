import type { Embedder, EmbedderFactory } from '../types.js';

/** Embeddings are off: similarity by meaning is not offered, and everything else works. */
export const createNoneEmbedder: EmbedderFactory = (): Embedder => ({
  enabled: false,
  id: 'none',
  dims: 0,
  async embed() {
    throw new Error('embeddings are switched off (SPINE_EMBEDDINGS=none)');
  },
});
