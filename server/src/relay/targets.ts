import { loadEmbeddingConfig, loadLlmConfig } from '../config.js';
import type { RelayTarget } from './relay.js';

/**
 * What the relay may call, from the same settings the server reads (`SPINE_LLM_*`, `SPINE_EMBEDDING_*`), so one set of values describes
 * both: the chat models (each at its own region when it has one) and the embedding model. A stated endpoint, region and project are
 * required; nothing is guessed.
 */
export function relayTargets(env: NodeJS.ProcessEnv = process.env): RelayTarget[] {
  const llm = loadLlmConfig(env);
  if (llm.provider !== 'vertex') throw new Error('the relay forwards to Vertex AI; set SPINE_LLM_PROVIDER=vertex');
  if (!llm.endpoint || !llm.region || !llm.project) throw new Error('SPINE_LLM_ENDPOINT, SPINE_LLM_REGION and SPINE_LLM_PROJECT are required');
  const targets: RelayTarget[] = llm.models.map(m => ({ model: m.id, endpoint: m.endpoint ?? llm.endpoint!, region: m.region ?? llm.region!, project: llm.project! }));
  const embed = loadEmbeddingConfig(env);
  if (embed.adapter === 'vertex') {
    if (!embed.endpoint || !embed.region || !embed.project) throw new Error('SPINE_EMBEDDINGS=vertex needs an endpoint, a region and a project');
    targets.push({ model: embed.model, endpoint: embed.endpoint, region: embed.region, project: embed.project });
  }
  return targets;
}
