import { afterEach, describe, expect, it } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import { createRelayChat, useRelayHooks } from '../llm/adapters/relay.js';
import type { TaskSpecs } from '../llm/tasks.js';
import type { ChatLlmConfig } from '../llm/types.js';

/**
 * The device reads the relay's streamed reply in whatever browser it runs in. Safari's response bodies have a reader but cannot be iterated
 * with `for await` (Chrome's and Node's can), and reading them that way failed every streamed call on an iPhone: the owner's chat fell back to
 * answering without tools and a share's recipient got no answer. The body here is shaped like Safari's.
 */
afterEach(() => useRelayHooks({}));

function safariBody(lines: string[]): ReadableStream<Uint8Array> {
  const real = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      // Split across pieces mid-line, as a network delivers it.
      const all = encoder.encode(lines.map(l => `${l}\n`).join(''));
      controller.enqueue(all.slice(0, 7));
      controller.enqueue(all.slice(7));
      controller.close();
    },
  });
  return { getReader: () => real.getReader() } as unknown as ReadableStream<Uint8Array>;
}

describe('the relay agent on the device', () => {
  it('reads a streamed reply from a body that has only a reader', async () => {
    useRelayHooks({
      tokenProvider: async () => 'pass',
      fetchImpl: (async () => ({ ok: true, status: 200, body: safariBody([JSON.stringify({ chunk: { content: 'Hello ' } }), JSON.stringify({ chunk: { content: 'there' } })]) })) as unknown as typeof fetch,
    });
    const agent = createRelayChat({ endpoint: 'relay.test', model: 'm' } as ChatLlmConfig, { agent: { name: 'agent' } } as unknown as TaskSpecs).agent as unknown as { stream(m: HumanMessage[]): Promise<AsyncIterable<{ content: unknown }>> };
    let text = '';
    for await (const chunk of await agent.stream([new HumanMessage('hi')])) text += String(chunk.content);
    expect(text).toBe('Hello there');
  });

  it('passes on an error the relay wrote into the stream', async () => {
    useRelayHooks({
      tokenProvider: async () => 'pass',
      fetchImpl: (async () => ({ ok: true, status: 200, body: safariBody([JSON.stringify({ error: 'the provider failed' })]) })) as unknown as typeof fetch,
    });
    const agent = createRelayChat({ endpoint: 'relay.test', model: 'm' } as ChatLlmConfig, { agent: { name: 'agent' } } as unknown as TaskSpecs).agent as unknown as { stream(m: HumanMessage[]): Promise<AsyncIterable<unknown>> };
    await expect((async () => { for await (const _ of await agent.stream([new HumanMessage('hi')])) void _; })()).rejects.toThrow('the provider failed');
  });
});
