import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { RunnableLambda } from '@langchain/core/runnables';
import { buildChatLlm } from '../llm/chat-llm.js';
import { buildStampReadingPrompt } from '../llm/prompts.js';
import { buildTaskSpecs, LLM_TASKS, TASK_SCHEMAS } from '../llm/tasks.js';
import type { ChatLlmConfig, LlmTask, TaskClients } from '../llm/index.js';

const config: ChatLlmConfig = {
  provider: 'fake', model: 'fake-model',
  maxTokens: { continuation: 256, extraction: 2048, page: 4096 },
  maxRetries: 0, contextChars: 300_000,
  logger: { info: () => {}, warn: () => {} },
};

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
function images(count: number): string[] {
  dir = mkdtempSync(path.join(tmpdir(), 'spine-stamp-'));
  return Array.from({ length: count }, (_, i) => { const f = path.join(dir, `s${i}.png`); writeFileSync(f, `bytes-${i}`); return f; });
}
function llmReturning(answer: unknown) {
  const received: unknown[] = [];
  const client = (task: LlmTask) => RunnableLambda.from(async (input: unknown) => {
    if (task === 'stamps') received.push(input);
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const clients = Object.fromEntries(LLM_TASKS.map(t => [t, client(t)])) as unknown as TaskClients;
  return { llm: buildChatLlm(clients, config), received };
}

describe('readStamps', () => {
  it('sends the instructions and every stamp as an image block', async () => {
    const { llm, received } = llmReturning({ doctors: [] });
    await llm.readStamps(images(2));
    const content = ((received[0] as Array<{ content: Array<{ type: string; text?: string; image_url?: { url: string } }> }>)[0]).content;
    expect(content.map(c => c.type)).toEqual(['text', 'image_url', 'image_url']);
    expect(content[0].text).toBe(buildStampReadingPrompt(2));
    expect(content[1].image_url!.url).toBe(`data:image/png;base64,${Buffer.from('bytes-0').toString('base64')}`);
    expect(content[2].image_url!.url).toBe(`data:image/png;base64,${Buffer.from('bytes-1').toString('base64')}`);
  });

  it('makes no call at all for no images', async () => {
    const { llm, received } = llmReturning({ doctors: [] });
    expect(await llm.readStamps([])).toEqual({ doctors: [] });
    expect(received).toHaveLength(0);
  });

  it('returns the doctors, tidied: names trimmed, blank specialty and code become null, nameless entries dropped', async () => {
    const { llm } = llmReturning({ doctors: [
      { name: '  Elena Marinescu ', specialty: ' medic specialist ', code: ' X23456 ' },
      { name: 'Radu Stoica', specialty: '', code: null },
      { name: 'Mihai Barbu' },
      { name: '   ', specialty: 'x', code: 'y' },
    ] });
    expect((await llm.readStamps(images(1)))!.doctors).toEqual([
      { name: 'Elena Marinescu', specialty: 'medic specialist', code: 'X23456' },
      { name: 'Radu Stoica', specialty: null, code: null },
      { name: 'Mihai Barbu', specialty: null, code: null },
    ]);
  });

  it('is null when the answer does not fit', async () => {
    expect(await llmReturning({ people: [] }).llm.readStamps(images(1))).toBeNull();
  });

  it('lets a provider failure through, as readPage does: the caller decides what it costs', async () => {
    await expect(llmReturning(new Error('provider down')).llm.readStamps(images(1))).rejects.toThrow('provider down');
  });
});

describe('the stamps task and prompt', () => {
  it('is a task like the others, with its own schema', () => {
    expect(LLM_TASKS).toContain('stamps');
    expect(buildTaskSpecs(config).stamps.jsonSchema).toHaveProperty('properties.doctors');
    expect(TASK_SCHEMAS.stamps.safeParse({ doctors: [{ name: 'a', specialty: null, code: null }] }).success).toBe(true);
    expect(TASK_SCHEMAS.stamps.safeParse({ doctors: [{ specialty: 'x' }] }).success).toBe(false);
  });
  it('asks for what is printed, never a guessed code, and ignores what is not a stamp', () => {
    const prompt = buildStampReadingPrompt(3);
    expect(prompt).toMatch(/These 3 images/);
    expect(buildStampReadingPrompt(1)).toMatch(/This image is/);
    expect(prompt).toMatch(/If any character of the code is covered by the signature or cannot be read with confidence, give code null/);
    expect(prompt).toMatch(/Ignore logos, seals, quality marks, QR codes/);
    expect(prompt).toMatch(/without "Dr\."/);
    expect(prompt).toMatch(/Do not translate, correct or complete a name/);
  });
});
