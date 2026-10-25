import { describe, it, expect } from 'vitest';
import { RunnableLambda } from '@langchain/core/runnables';
import { buildChatLlm } from '../llm/chat-llm.js';
import type { ChatLlmConfig, LlmTask, TaskClients } from '../llm/index.js';

/**
 * The labels a model writes back. The prompt gives each candidate "in square brackets"; a real model answered "[1]", and the app,
 * comparing it with "1", dropped a correct link without a word. Only a live run could show it: the fakes always answered "1".
 */
const config: ChatLlmConfig = { provider: 'fake', model: 'fake', maxTokens: { continuation: 256, extraction: 2048, page: 4096 }, maxRetries: 0, contextChars: 300_000, logger: { info: () => {}, warn: () => {} } };
const llmAnswering = (answer: unknown) => {
  const client = (task: LlmTask) => RunnableLambda.from(async () => (task === 'linking' ? answer : {}));
  const tasks = ['continuation', 'extraction', 'page', 'pageThinking', 'stamps', 'translation', 'linking', 'grouping', 'chat', 'agent'] as const;
  return buildChatLlm(Object.fromEntries(tasks.map(t => [t, client(t)])) as unknown as TaskClients, config);
};
const cards = [{ id: '1', text: 'a' }, { id: '2', text: 'b' }];
const judge = (written: string) => llmAnswering({ links: [{ candidate: written, relation: 'target_requested_candidate', reason: ' because ' }] }).link({ id: 'target', text: 't' }, cards);

describe('judging links', () => {
  it('takes the label as written, with or without the brackets the prompt showed it in', async () => {
    for (const written of ['1', '[1]', ' [1] ', '[ 1 ]']) expect((await judge(written))?.map(j => j.candidate), written).toEqual(['1']);
  });

  it('still drops a label that names no card', async () => {
    for (const written of ['3', '[3]', 'target', '']) expect(await judge(written), written).toEqual([]);
  });
});
