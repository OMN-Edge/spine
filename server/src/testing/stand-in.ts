import { RunnableLambda } from '@langchain/core/runnables';
import { BaseChatModel, type BaseChatModelCallOptions } from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { loadLlmConfig } from 'spine-core/config.js';
import { buildTaskSpecs, type LlmTask, type TaskClients } from 'spine-core/llm/tasks.js';
import { registerLlmProvider } from 'spine-core/llm/index.js';
import { registerEmbedder } from 'spine-core/embedding/index.js';

/**
 * A model for tests and for `npm run check:app`, in no build or image: every task answers with the simplest value that fits its schema, and
 * the agent calls the first tool it was given once, then answers in words (so the graph's loop ends). It is what the relay runs when a
 * check wants the whole path from the page without a provider.
 */

/** The simplest value that satisfies a JSON schema. */
export function valueFor(schema: any, depth = 0, key = ''): unknown { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!schema || depth > 8) return null;
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf || schema.oneOf) return valueFor((schema.anyOf ?? schema.oneOf)[0], depth + 1, key);
  switch ((Array.isArray(schema.type) ? schema.type[0] : schema.type)?.toLowerCase()) {
    // The date a schema checks by a pattern, which Gemini's schema subset does not carry.
    case 'string': return key === 'doc_date' || String(schema.pattern ?? '').includes('d{4}-') ? '2026-01-15' : 'sample';
    case 'number': case 'integer': return 0;
    case 'boolean': return false;
    case 'array': return [];
    case 'object': return Object.fromEntries((schema.required ?? Object.keys(schema.properties ?? {})).map((k: string) => [k, valueFor(schema.properties?.[k], depth + 1, k)]));
    default: return null;
  }
}

export interface StandInCall { task: LlmTask; messages: BaseMessage[]; tools?: unknown[] }
type Options = BaseChatModelCallOptions & { tools?: Array<{ function: { name: string; parameters: unknown } }> };

class StandInAgent extends BaseChatModel<Options> {
  constructor(private readonly calls: StandInCall[]) { super({}); }
  _llmType() { return 'stand-in'; }
  bindTools(tools: unknown[]) { return this.withConfig({ tools: tools.map(t => convertToOpenAITool(t as never)) } as never); }

  private answer(messages: BaseMessage[], options: Options): AIMessageChunk {
    this.calls.push({ task: 'agent', messages, tools: options.tools });
    const first = options.tools?.[0]?.function;
    const done = messages.some(m => m.getType() === 'tool');
    if (first && !done) return new AIMessageChunk({ content: '', tool_call_chunks: [{ name: first.name, args: JSON.stringify(valueFor(first.parameters)), id: 'call-1', index: 0, type: 'tool_call_chunk' }] });
    return new AIMessageChunk({ content: 'A sample answer.' });
  }

  async _generate(messages: BaseMessage[], options: this['ParsedCallOptions']): Promise<ChatResult> {
    const chunk = this.answer(messages, options);
    const message = new AIMessage({ content: chunk.content, tool_calls: chunk.tool_calls });
    return { generations: [{ text: typeof chunk.content === 'string' ? chunk.content : '', message }] };
  }

  async *_streamResponseChunks(messages: BaseMessage[], options: this['ParsedCallOptions']): AsyncGenerator<ChatGenerationChunk> {
    const message = this.answer(messages, options);
    yield new ChatGenerationChunk({ text: typeof message.content === 'string' ? message.content : '', message });
  }
}

export function standInClients(results: Partial<Record<LlmTask, unknown>> = {}): { clients: TaskClients; calls: StandInCall[] } {
  const calls: StandInCall[] = [];
  const clients = {} as TaskClients;
  for (const task of Object.values(buildTaskSpecs(loadLlmConfig({})))) {
    clients[task.name] = task.name === 'agent'
      ? new StandInAgent(calls) as unknown as TaskClients['agent']
      : RunnableLambda.from(async (input: unknown) => { calls.push({ task: task.name, messages: input as BaseMessage[] }); return results[task.name] ?? valueFor(task.jsonSchema); });
  }
  return { clients, calls };
}

/**
 * Registers the stand-in as the provider `stand-in` (models and embeddings), for `stand-in-relay.ts`: the relay's own entry point with this
 * in place of a vendor, so a check runs the whole path from the page without a provider.
 */
export function useStandInProviders(): void {
  registerLlmProvider('stand-in', () => standInClients().clients);
  registerEmbedder('stand-in', () => ({ enabled: true, id: 'stand-in:768', dims: 768, embed: async texts => texts.map(() => Float32Array.from({ length: 768 }, (_, i) => (i % 7) + 1)) }));
}
