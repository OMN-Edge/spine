import { ChatVertexAI } from '@langchain/google-vertexai';
import type { TaskClients, TaskSpecs } from 'spine-core/llm/tasks.js';
import { LlmConfigError, type ChatLlmConfig } from 'spine-core/llm/types.js';
import { buildVertexTasks, withStreamSafety } from './vertex-tasks.js';

/**
 * Vertex AI — Gemini *and* Claude. "Vertex or Gemini" is a category error; the
 * real distinction is which API serves the model, and this is the standard
 * endpoint surface, which carries the regional residency guarantee.
 *
 * Two residency controls, both configuration-level (SECURITY.md P8, M-8):
 *
 *  1. The endpoint and region must be stated explicitly. Nothing defaults, so
 *     an instance cannot end up on a global endpoint by omission.
 *  2. Construction fails if a Google API key is present in the environment *at
 *     all*. This is the one that matters: with `GOOGLE_API_KEY` set, the
 *     library reads it even though none was passed, `isApiKey` forces the
 *     platform to "gai", and the request goes to
 *     `https://aiplatform.googleapis.com/v1/publishers/google/models/...` —
 *     global host, configured endpoint dropped, no region in the path.
 *     Reproduced against the installed version, not inferred.
 *
 * What is deliberately *not* here: an assertion on the shape of the outgoing
 * request URL. An earlier version wrapped the library's internal HTTP client to
 * check the host and a `/locations/<region>/` path segment on every call. That
 * encoded Google's URL scheme as a security control — it would mean nothing for
 * an Azure or Bedrock endpoint, where there is no region token to look for —
 * and it coupled us to a library internal that the API-key path bypasses
 * anyway. Verifying residency against the provider's own request logs on first
 * deployment is the check that actually generalises; see
 * docs/deployment-gcp.md.
 */

/** Environment variables whose mere presence can reroute Google traffic. */
const API_KEY_VARS = ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENAI_API_KEY'] as const;

export function createVertexChat(
  config: ChatLlmConfig,
  tasks: TaskSpecs,
): TaskClients {
  const endpoint = config.endpoint;
  if (!endpoint) {
    throw new LlmConfigError(
      'SPINE_LLM_PROVIDER=vertex requires SPINE_LLM_ENDPOINT — residency is a property of the ' +
        'endpoint, so there is deliberately no default (e.g. aiplatform.eu.rep.googleapis.com)',
    );
  }
  if (!config.region) {
    throw new LlmConfigError(
      'SPINE_LLM_PROVIDER=vertex requires SPINE_LLM_REGION (e.g. eu). Stated rather than ' +
        'parsed out of the endpoint, because not every provider puts one there',
    );
  }
  if (!config.project) {
    throw new LlmConfigError('SPINE_LLM_PROVIDER=vertex requires SPINE_LLM_PROJECT');
  }

  const present = API_KEY_VARS.filter(name => (process.env[name] ?? '').length > 0);
  if (present.length > 0) {
    throw new LlmConfigError(
      `${present.join(', ')} is set, which makes this library ignore the configured endpoint ` +
        'and region and call the global one instead. Remove it from the environment and ' +
        'authenticate with a service account via GOOGLE_APPLICATION_CREDENTIALS (SECURITY.md M-8)',
    );
  }

  return buildVertexTasks(config, tasks, endpoint, ChatVertexAI, withStreamSafety(ChatVertexAI));
}
