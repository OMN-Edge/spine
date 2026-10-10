import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkContinuation } from '../ingestion/continuation.js';
import { extractFields } from '../ingestion/extraction.js';
import { RunnableLambda } from '@langchain/core/runnables';
import { buildChatLlm } from '../llm/chat-llm.js';
import { resetChatLlm, CONTINUATION_FALLBACK, EXTRACTION_FALLBACK } from '../llm/index.js';
import type { ChatLlmConfig, LlmTask, TaskClients } from '../llm/index.js';

/**
 * The interface is tested through fake task clients — real `Runnable`s built from a
 * function — rather than a mocked vendor SDK. These tests describe what Spine
 * does with a model's answer, so they do not change when the provider does.
 */

const config: ChatLlmConfig = {
  provider: 'fake',
  model: 'fake-model',
  maxTokens: { continuation: 256, extraction: 2048, page: 4096 },
  maxRetries: 0,
  logger: { info: () => {}, warn: () => {} },
};

interface Recorder {
  clients: TaskClients;
  prompts: string[];
  tasks: LlmTask[];
}

function fakeClients(responses: unknown[]): Recorder {
  const prompts: string[] = [];
  const tasks: LlmTask[] = [];
  let i = 0;

  const clientFor = (task: LlmTask) =>
    RunnableLambda.from(async (input: unknown) => {
      tasks.push(task);
      prompts.push(typeof input === 'string' ? input : JSON.stringify(input));
      const response = responses[Math.min(i, responses.length - 1)];
      i += 1;
      if (response instanceof Error) throw response;
      return response;
    });

  return {
    prompts,
    tasks,
    clients: {
      continuation: clientFor('continuation'),
      extraction: clientFor('extraction'),
      page: clientFor('page'),
    },
  };
}

function install(responses: unknown[]): Recorder {
  const recorder = fakeClients(responses);
  resetChatLlm(buildChatLlm(recorder.clients, config));
  return recorder;
}

afterEach(() => resetChatLlm(null));

describe('checkContinuation', () => {
  it('passes through a valid continuation response', async () => {
    install([{ is_continuation: true, confidence: 0.92, reasoning: 'Same lab report' }]);

    const result = await checkContinuation('page 1 text', 'page 2 continued');

    expect(result).toEqual({
      is_continuation: true,
      confidence: 0.92,
      reasoning: 'Same lab report',
    });
  });

  it('passes through a new-document response', async () => {
    install([{ is_continuation: false, confidence: 0.81, reasoning: 'New letterhead' }]);
    const result = await checkContinuation('a', 'b');
    expect(result.is_continuation).toBe(false);
    expect(result.confidence).toBe(0.81);
  });

  it('sends only the configured slice of each page — the egress budget', async () => {
    const chat = install([{ is_continuation: false, confidence: 0.5, reasoning: 'x' }]);
    // Filler characters that do not appear in the prompt template, so the runs
    // measured below are exactly what came from the page text.
    const prev = 'Q'.repeat(900) + 'TAIL';
    const curr = 'HEAD' + 'Z'.repeat(900);

    await checkContinuation(prev, curr);

    const prompt = chat.prompts[0];
    // The tail of the previous page and the head of the current one: 500 chars
    // from each side, which is what ARCHITECTURE.md's egress table promises.
    expect(prompt).toContain('TAIL');
    expect(prompt).toContain('HEAD');
    expect(prompt.match(/Q+/)?.[0].length).toBe(496);
    expect(prompt.match(/Z+/)?.[0].length).toBe(496);
    expect(chat.tasks).toEqual(['continuation']);
  });

  it('falls back to a new document when the response fails validation', async () => {
    // confidence as a word, which JSON.parse would have accepted happily.
    install([{ is_continuation: true, confidence: 'high', reasoning: 'nope' }]);

    const result = await checkContinuation('a', 'b');

    expect(result).toEqual(CONTINUATION_FALLBACK);
    expect(result.is_continuation).toBe(false);
  });

  it('falls back when a field is missing entirely', async () => {
    install([{ is_continuation: true }]);
    expect(await checkContinuation('a', 'b')).toEqual(CONTINUATION_FALLBACK);
  });

  it('falls back when confidence is out of range', async () => {
    install([{ is_continuation: true, confidence: 4, reasoning: 'x' }]);
    expect(await checkContinuation('a', 'b')).toEqual(CONTINUATION_FALLBACK);
  });

  it('logs the validation failure rather than swallowing it', async () => {
    const warn = vi.fn();
    const { clients } = fakeClients([{ nonsense: true }]);
    resetChatLlm(buildChatLlm(clients, { ...config, logger: { info: () => {}, warn } }));

    await checkContinuation('a', 'b');

    expect(warn).toHaveBeenCalledWith(
      'llm response failed schema validation',
      expect.objectContaining({ task: 'continuation' }),
    );
  });

  it('lets a transport error propagate — the pipeline records the job as failed', async () => {
    install([new Error('503 from provider')]);
    await expect(checkContinuation('a', 'b')).rejects.toThrow('503 from provider');
  });
});

describe('extractFields', () => {
  const valid = {
    doc_date: '2026-01-15',
    provider: 'Regina Maria',
    doc_type: 'lab_result',
    ai_summary: 'A lab result.',
    suggested_tags: ['lab'],
    fields: [
      { label: 'diagnosis', value: 'anemia', source_snippet: 'anemie', page_number: 1, confidence: 0.9 },
    ],
  };

  it('passes through a valid extraction', async () => {
    install([valid]);
    const result = await extractFields('document text');
    expect(result).toEqual(valid);
  });

  it('accepts a null date and provider', async () => {
    install([{ ...valid, doc_date: null, provider: null }]);
    const result = await extractFields('x');
    expect(result.doc_date).toBeNull();
    expect(result.provider).toBeNull();
  });

  it('rejects a doc_type outside the enum', async () => {
    install([{ ...valid, doc_type: 'invoice' }]);
    expect(await extractFields('x')).toEqual(EXTRACTION_FALLBACK);
  });

  it('rejects a malformed date rather than storing it', async () => {
    install([{ ...valid, doc_date: '15/01/2026' }]);
    expect(await extractFields('x')).toEqual(EXTRACTION_FALLBACK);
  });

  it('rejects a field with a zero page number', async () => {
    install([{ ...valid, fields: [{ ...valid.fields[0], page_number: 0 }] }]);
    expect(await extractFields('x')).toEqual(EXTRACTION_FALLBACK);
  });

  it('truncates the document to the configured extraction budget', async () => {
    const chat = install([valid]);
    await extractFields('Z'.repeat(9000));
    // 'Z' does not occur in the template, so this run is exactly the slice sent.
    expect(chat.prompts[0].match(/Z+/)?.[0].length).toBe(6000);
    expect(chat.tasks).toEqual(['extraction']);
  });

  it('falls back to a reviewable marker, not an exception', async () => {
    install([{ doc_type: 'lab_result' }]);
    const result = await extractFields('x');
    expect(result.ai_summary).toContain('review manually');
    expect(result.fields).toEqual([]);
  });
});

describe('getChatLlm with nothing injected', () => {
  beforeEach(() => resetChatLlm(null));

  it('builds from configuration on first use, then memoizes', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const { getChatLlm } = await import('../llm/index.js');

    const first = getChatLlm();
    const second = getChatLlm();

    expect(first).toBe(second);
  });
});
