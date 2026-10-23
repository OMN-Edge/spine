import { ChatGoogleBase, GoogleAbstractedFetchClient, type GoogleAbstractedClientOps } from '@langchain/google-common';
import type { TaskClients, TaskSpecs } from '../../../../server/src/llm/tasks';
import { LlmConfigError, type ChatLlmConfig } from '../../../../server/src/llm/types';
import { buildVertexTasks, withStreamSafety } from '../../../../server/src/llm/adapters/vertex-tasks';
import { relayFetch, relayToken } from './relay-auth';

/**
 * The model on the device: the same Vertex client the server uses, with its requests going to the relay (whose address is the
 * configured endpoint) carrying a pass in place of Google credentials. Same contract as server/src/llm/adapters/vertex.ts; what the two
 * share (safety settings, thinking, streaming, refusals) is in vertex-tasks.ts.
 */
class RelayClient extends GoogleAbstractedFetchClient {
  constructor(private readonly project: string) {
    super();
    // Only what the relay accepts: the library's own client headers (User-Agent, Client-Info) are not needed there and would each have
    // to be allowed by the browser's cross-origin check.
    this._fetch = async (url, init) => relayFetch(url, { ...init, headers: { 'Content-Type': 'application/json', authorization: `Bearer ${await relayToken()}` } });
  }
  get clientType() { return 'relay'; }
  async getProjectId() { return this.project; }
  async request(opts: GoogleAbstractedClientOps) { return this._request(opts.url, opts, {}); }
}

class RelayChat extends ChatGoogleBase<{ projectId?: string }> {
  static lc_name() { return 'RelayChat'; }
  constructor(fields: Record<string, unknown>) { super({ ...fields, platformType: 'gcp' } as never); }
  buildAbstractedClient(fields?: { authOptions?: { projectId?: string } }) { return new RelayClient(fields?.authOptions?.projectId ?? ''); }
}

export function createVertexChat(config: ChatLlmConfig, tasks: TaskSpecs): TaskClients {
  if (!config.endpoint || !config.region || !config.project) {
    throw new LlmConfigError('this instance has no relay for model calls, so nothing can be read with a model here');
  }
  const Chat = RelayChat as never;
  return buildVertexTasks(config, tasks, config.endpoint, Chat, withStreamSafety(Chat));
}
