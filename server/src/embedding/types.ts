/**
 * The embedder interface: text in, vectors out. Like the LLM and mailer interfaces, nothing above `adapters/` imports a
 * vendor package, and an adapter is one entry in the registry in `index.ts` and one file.
 *
 * A vector is only meaningful beside vectors from the same model, at the same size. `id` names that space and is stored
 * with every vector; vectors with different ids are never compared (see ARCHITECTURE.md, Similarity).
 */
export type EmbedKind = 'document' | 'query';

export interface Embedder {
  /** False for the `none` adapter. Callers check this rather than catching a throw. */
  readonly enabled: boolean;
  /** The vector space, e.g. `vertex:gemini-embedding-001:768`. */
  readonly id: string;
  readonly dims: number;
  /** One vector per text, unit length, in the order given. Rejects on any failure. */
  embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]>;
}

export interface EmbedderConfig {
  adapter: string;
  model: string;
  dims: number;
  endpoint?: string;
  region?: string;
  project?: string;
  /** Injectable for tests: a bearer token, and the HTTP call. */
  tokenProvider?: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

export type EmbedderFactory = (config: EmbedderConfig) => Embedder;

export class EmbedderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbedderConfigError';
  }
}
