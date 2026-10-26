import { registerEmbedder } from 'spine-core/embedding/index.js';
import { registerLlmProvider } from 'spine-core/llm/index.js';
import { createVertexEmbedder } from './embedding/adapters/vertex.js';
import { createAnthropicChat } from './llm/adapters/anthropic.js';
import { createVertexChat } from './llm/adapters/vertex.js';

/**
 * The providers of models, for the process that runs them: the relay service (and the operator's CLI, which reads the same settings). The
 * shared package knows only `relay`, which is what a device uses, so the vendor SDKs are carried here and nowhere else.
 */
export function useModelProviders(): void {
  registerLlmProvider('anthropic', createAnthropicChat);
  registerLlmProvider('vertex', createVertexChat);
  registerEmbedder('vertex', createVertexEmbedder);
}
