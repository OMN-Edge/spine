import { beforeEach, describe, expect, it } from 'vitest';
import { RunnableLambda } from '@langchain/core/runnables';
import { ModelBudgetError, spendModelCall } from '../llm/budget.js';
import { getStore, resetStore } from '../store/index.js';
import { llmDailyCalls } from '../config.js';
import { buildChatLlm } from '../llm/chat-llm.js';
import type { ChatLlmConfig, TaskClients } from '../llm/index.js';

/** SECURITY.md S-35: one allowance for the instance, whoever asks. */

beforeEach(() => resetStore());

describe('the daily allowance', () => {
  it('lets the limit through and refuses the next call', async () => {
    const day = new Date('2026-10-18T10:00:00Z');
    for (let i = 0; i < 3; i++) await spendModelCall(day, 3);
    await expect(spendModelCall(day, 3)).rejects.toThrow(ModelBudgetError);
    await expect(spendModelCall(day, 3)).rejects.toThrow(/daily limit of 3/);
  });

  it('starts again the next UTC day', async () => {
    await spendModelCall(new Date('2026-10-18T23:59:00Z'), 1);
    await expect(spendModelCall(new Date('2026-10-18T23:59:30Z'), 1)).rejects.toThrow(ModelBudgetError);
    await expect(spendModelCall(new Date('2026-10-19T00:00:10Z'), 1)).resolves.toBeUndefined();
  });

  it('zero means no ceiling, and does not count', async () => {
    for (let i = 0; i < 50; i++) await spendModelCall(new Date(), 0);
    expect(await getStore().usage.spend('instance', new Date().toISOString().slice(0, 10), 1)).toBe(1); // nothing was counted before this
  });

  it('is kept in the store, so a second look at the same store sees the count', async () => {
    const day = new Date('2026-10-18T10:00:00Z');
    await spendModelCall(day, 2);
    expect(await getStore().usage.spend('instance', '2026-10-18', 2)).toBe(2);
    await expect(spendModelCall(day, 2)).rejects.toThrow(ModelBudgetError);
  });

  it('reads SPINE_LLM_DAILY_CALLS, and a bad value gives the default rather than no ceiling', () => {
    expect(llmDailyCalls({} as NodeJS.ProcessEnv)).toBe(5000);
    expect(llmDailyCalls({ SPINE_LLM_DAILY_CALLS: '250' } as NodeJS.ProcessEnv)).toBe(250);
    expect(llmDailyCalls({ SPINE_LLM_DAILY_CALLS: '0' } as NodeJS.ProcessEnv)).toBe(0);
    expect(llmDailyCalls({ SPINE_LLM_DAILY_CALLS: 'lots' } as NodeJS.ProcessEnv)).toBe(5000);
    expect(llmDailyCalls({ SPINE_LLM_DAILY_CALLS: '-5' } as NodeJS.ProcessEnv)).toBe(5000);
  });
});

describe('where it is applied', () => {
  it('every task call through the interface counts, and none reaches the provider once it is spent', async () => {
    let reached = 0;
    const fake = RunnableLambda.from(async () => { reached += 1; return { continues: false, confidence: 0.5, reason: 'x' }; });
    const tasks = ['continuation', 'extraction', 'page', 'pageThinking', 'stamps', 'translation', 'linking', 'grouping', 'chat', 'agent'] as const;
    const config: ChatLlmConfig = { provider: 'fake', model: 'fake', maxTokens: { continuation: 256, extraction: 2048, page: 4096 }, maxRetries: 0, contextChars: 300_000, logger: { info: () => {}, warn: () => {} } };
    const llm = buildChatLlm(Object.fromEntries(tasks.map(t => [t, fake])) as unknown as TaskClients, config);

    process.env.SPINE_LLM_DAILY_CALLS = '2';
    try {
      await llm.detectContinuation('a', 'b');
      await llm.detectContinuation('a', 'b');
      await expect(llm.detectContinuation('a', 'b')).rejects.toThrow(ModelBudgetError);
      expect(reached).toBe(2);
    } finally {
      delete process.env.SPINE_LLM_DAILY_CALLS;
    }
  });
});
