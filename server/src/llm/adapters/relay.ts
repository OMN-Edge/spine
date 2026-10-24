import { RunnableLambda } from '@langchain/core/runnables';
import { BaseChatModel, type BaseChatModelCallOptions } from '@langchain/core/language_models/chat_models';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import { AIMessageChunk, HumanMessage, coerceMessageLikeToMessage, mapChatMessagesToStoredMessages, mapStoredMessagesToChatMessages, type BaseMessage } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import type { StreamLine } from '../../relay/protocol.js';
import type { TaskClients, TaskSpecs } from '../tasks.js';
import { LlmBlockedError, LlmConfigError, type ChatLlmConfig } from '../types.js';

/**
 * The model reached through a relay (docs/relay.md): this side only says which task and sends the messages; the relay holds the
 * provider's credential and its adapter (Vertex, Anthropic, ...) and does everything provider-specific. What this file knows of a provider
 * is nothing, so adding one never touches it. It is how a device calls a model: a browser cannot hold Spine's credential.
 *
 * `endpoint` is the relay's host. A pass in place of a credential comes from `useRelayHooks`, set by the device.
 */
export interface RelayHooks { tokenProvider?: () => Promise<string>; fetchImpl?: typeof fetch }
let hooks: RelayHooks = {};
export function useRelayHooks(next: RelayHooks): void { hooks = next; }

/** An error the relay answered with, said in the interface's terms. */
async function refusal(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (body.code === 'blocked') return new LlmBlockedError(body.error ?? 'the model refused');
  return Object.assign(new Error(`the model service answered ${res.status}${body.error ? `: ${body.error}` : ''}`), { status: res.status });
}

export async function postToRelay(endpoint: string, path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const token = await hooks.tokenProvider?.();
  if (!token) throw new LlmConfigError('this device has no pass for the model service');
  const res = await (hooks.fetchImpl ?? fetch)(`https://${endpoint}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await refusal(res);
  return res;
}

function messagesOf(input: BaseLanguageModelInput): BaseMessage[] {
  if (typeof input === 'string') return [new HumanMessage(input)];
  if (Array.isArray(input)) return input.map(coerceMessageLikeToMessage);
  return (input as { toChatMessages(): BaseMessage[] }).toChatMessages();
}

type AgentOptions = BaseChatModelCallOptions & { tools?: unknown[] };

/** The chat model the agent graph binds tools to; each call is one request to the relay, and the model that answers is the relay's. */
class RelayAgent extends BaseChatModel<AgentOptions> {
  constructor(private readonly where: { endpoint: string; model: string }) { super({}); }
  _llmType() { return 'spine-relay'; }
  bindTools(tools: unknown[]) { return this.withConfig({ tools: tools.map(t => convertToOpenAITool(t as never)) } as never); }

  private request(messages: BaseMessage[], options: AgentOptions, stream: boolean) {
    return postToRelay(this.where.endpoint, '/v1/task/agent', {
      model: this.where.model, messages: mapChatMessagesToStoredMessages(messages), tools: options.tools, stream,
    }, options.signal);
  }

  async _generate(messages: BaseMessage[], options: this['ParsedCallOptions']): Promise<ChatResult> {
    const { message } = (await (await this.request(messages, options, false)).json()) as { message: Parameters<typeof mapStoredMessagesToChatMessages>[0][number] };
    const [ai] = mapStoredMessagesToChatMessages([message]);
    return { generations: [{ text: typeof ai.content === 'string' ? ai.content : '', message: ai }] };
  }

  async *_streamResponseChunks(messages: BaseMessage[], options: this['ParsedCallOptions']): AsyncGenerator<ChatGenerationChunk> {
    const res = await this.request(messages, options, true);
    const decoder = new TextDecoder();
    let pending = '';
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      pending += decoder.decode(part, { stream: true });
      let at: number;
      while ((at = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, at).trim();
        pending = pending.slice(at + 1);
        if (!line) continue;
        const { chunk, error, code } = JSON.parse(line) as StreamLine;
        if (error) throw code === 'blocked' ? new LlmBlockedError(error) : new Error(error);
        if (!chunk) continue;
        const message = new AIMessageChunk({
          content: chunk.content as never, tool_call_chunks: chunk.tool_call_chunks as never, additional_kwargs: chunk.additional_kwargs,
          response_metadata: chunk.response_metadata, usage_metadata: chunk.usage_metadata as never, id: chunk.id,
        });
        yield new ChatGenerationChunk({ text: typeof chunk.content === 'string' ? chunk.content : '', message });
      }
    }
  }
}

export function createRelayChat(config: ChatLlmConfig, tasks: TaskSpecs): TaskClients {
  const endpoint = config.endpoint;
  if (!endpoint) throw new LlmConfigError('SPINE_LLM_PROVIDER=relay requires SPINE_LLM_ENDPOINT: the relay\'s host');
  const clients = {} as TaskClients;
  for (const task of Object.values(tasks)) {
    if (task.name === 'agent') { clients.agent = new RelayAgent({ endpoint, model: config.model }) as unknown as TaskClients['agent']; continue; }
    // The relay's adapter bound the schema and the token cap; the answer comes back parsed.
    clients[task.name] = RunnableLambda.from(async (input: BaseLanguageModelInput, options?: { signal?: AbortSignal }) => {
      const res = await postToRelay(endpoint, `/v1/task/${task.name}`, { model: config.model, messages: mapChatMessagesToStoredMessages(messagesOf(input)) }, options?.signal);
      return ((await res.json()) as { result: unknown }).result;
    });
  }
  return clients;
}
