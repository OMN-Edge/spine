import { GoogleAuth } from 'google-auth-library';
import { EmbedderConfigError, type EmbedderConfig, type EmbedderFactory, type EmbedKind } from 'spine-core/embedding/types.js';

/**
 * Vertex AI text embeddings over the standard `predict` surface, at an endpoint, region and project that are stated, not
 * defaulted: residency is a property of the endpoint (SECURITY.md P8, M-8), as for the chat models. What is sent is the
 * text of a document's short summary card, or of a search query; the reply is numbers.
 *
 * The `predict` call is made with `fetch` and a service-account token rather than through a library, because the library
 * route reroutes to the global host when an API key is in the environment (see `llm/adapters/vertex.ts`), and refusing
 * that is cheaper than depending on it. For the same reason a Google API key in the environment is refused here too.
 *
 * Two request styles, chosen by the model, because Google serves them differently. `gemini-embedding-2` (the one the `eu`
 * multi-region serves) is called with `:embedContent`; `:predict` answers 404 "publisher model not found" for it. It has no
 * task-type field: whether a text is a query or a document is said in a prefix on the text, as Google documents. The older
 * models (`gemini-embedding-001`, `text-embedding-005`, ...) use `:predict` with a task type. Which models a given endpoint
 * serves is for the endpoint to say (`npm run cli -- check-embeddings` names them); nothing here assumes.
 *
 * One text a request: `embedContent` fuses every part into one vector and neither style is batched here, and doing the same for
 * every model keeps one code path. Several run at once.
 */
const API_KEY_VARS = ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENAI_API_KEY'] as const;
const PARALLEL = 4;
const TIMEOUT_MS = 30_000;

const taskType = (kind: EmbedKind) => (kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT');

/** The models called with `embedContent` and told their task in the text itself. */
export const usesEmbedContent = (model: string): boolean => /^gemini-embedding-[2-9]/.test(model);

/** Google's documented retrieval prefixes for `gemini-embedding-2`: a query, and a document (a card has its title on its first line, so none is given). */
const withTask = (text: string, kind: EmbedKind): string =>
  kind === 'query' ? `task: search result | query: ${text}` : `title: none | text: ${text}`;

/** Scales to unit length, so a dot product is a cosine and a truncated (smaller) vector is comparable. */
export function normalise(values: number[]): Float32Array {
  const out = Float32Array.from(values);
  let sum = 0;
  for (const v of out) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

export const createVertexEmbedder: EmbedderFactory = (config: EmbedderConfig) => {
  const { endpoint, region, project, model, dims } = config;
  if (!endpoint) throw new EmbedderConfigError('SPINE_EMBEDDINGS=vertex requires an endpoint (SPINE_EMBEDDING_ENDPOINT, or SPINE_LLM_ENDPOINT with the vertex provider); there is deliberately no default');
  if (!region) throw new EmbedderConfigError('SPINE_EMBEDDINGS=vertex requires a region (SPINE_EMBEDDING_REGION, or SPINE_LLM_REGION)');
  if (!project) throw new EmbedderConfigError('SPINE_EMBEDDINGS=vertex requires a project (SPINE_EMBEDDING_PROJECT, or SPINE_LLM_PROJECT)');
  const present = API_KEY_VARS.filter(name => (process.env[name] ?? '').length > 0);
  if (present.length > 0 && !config.tokenProvider) {
    throw new EmbedderConfigError(`${present.join(', ')} is set, which can send Google calls to the global endpoint; remove it and authenticate with a service account via GOOGLE_APPLICATION_CREDENTIALS (SECURITY.md M-8)`);
  }

  const embedContent = usesEmbedContent(model);
  const url = `https://${endpoint}/v1/projects/${project}/locations/${region}/publishers/google/models/${model}:${embedContent ? 'embedContent' : 'predict'}`;
  const auth = config.tokenProvider ? null : new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const token = config.tokenProvider ?? (async () => {
    const value = await auth!.getAccessToken();
    if (!value) throw new Error('no access token for Vertex AI (is GOOGLE_APPLICATION_CREDENTIALS set?)');
    return value;
  });
  const call = config.fetchImpl ?? fetch;

  async function one(text: string, kind: EmbedKind): Promise<Float32Array> {
    const response = await call(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
      body: JSON.stringify(embedContent
        ? { content: { parts: [{ text: withTask(text, kind) }] }, outputDimensionality: dims }
        : { instances: [{ content: text, task_type: taskType(kind) }], parameters: { outputDimensionality: dims, autoTruncate: true } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      // The reply may quote the request; only its status goes in the message, never document text.
      throw new Error(`the embedding service answered ${response.status}`);
    }
    const body = (await response.json()) as {
      predictions?: Array<{ embeddings?: { values?: number[] } }>;
      embedding?: { values?: number[] };
      embeddings?: Array<{ values?: number[] }>;
    };
    // `predict` answers with predictions; `embedContent` with an embedding (or a list of one).
    const values = body.predictions?.[0]?.embeddings?.values ?? body.embedding?.values ?? body.embeddings?.[0]?.values;
    if (!Array.isArray(values) || values.length !== dims || !values.every(v => typeof v === 'number' && Number.isFinite(v))) {
      throw new Error(`the embedding service returned ${Array.isArray(values) ? values.length : 'no'} values, expected ${dims}`);
    }
    return normalise(values);
  }

  return {
    enabled: true,
    id: `vertex:${model}:${dims}`,
    dims,
    // Metadata only: the models the endpoint lists, no text of any document. `check-embeddings` uses it to say what to set
    // when the configured model is not served there.
    async availableModels() {
      const response = await call(`https://${endpoint}/v1beta1/publishers/google/models?pageSize=200`, {
        headers: { authorization: `Bearer ${await token()}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`the model list answered ${response.status}`);
      const body = (await response.json()) as { publisherModels?: Array<{ name?: string }> };
      return (body.publisherModels ?? []).map(m => (m.name ?? '').split('/').pop() ?? '').filter(name => /embed/i.test(name));
    },

    async embed(texts, kind) {
      const out: Float32Array[] = new Array(texts.length);
      let next = 0;
      const worker = async () => { for (let i = next++; i < texts.length; i = next++) out[i] = await one(texts[i], kind); };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, texts.length) }, worker));
      return out;
    },
  };
};
