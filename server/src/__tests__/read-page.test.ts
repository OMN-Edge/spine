import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { RunnableLambda } from '@langchain/core/runnables';
import { buildChatLlm } from '../llm/chat-llm.js';
import type { ChatLlmConfig, LlmTask, TaskClients } from '../llm/index.js';

/**
 * `readPage` is the one call that sends an image off the host (SECURITY.md M-7).
 * These cover what is sent and what is done with the answer. Whether a given
 * provider accepts the image is not testable here without credentials — the message
 * shape is verified against both providers' request builders instead (see the
 * parser notes in ARCHITECTURE.md).
 */

const config: ChatLlmConfig = {
  provider: 'fake', model: 'fake-model',
  maxTokens: { continuation: 256, extraction: 2048, page: 4096 },
  maxRetries: 0,
  contextChars: 300_000,
  logger: { info: () => {}, warn: () => {} },
};

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function page(bytes = 'fake-png-bytes'): string {
  dir = mkdtempSync(path.join(tmpdir(), 'spine-page-'));
  const file = path.join(dir, 'page.png');
  writeFileSync(file, bytes);
  return file;
}

function llmReturning(answer: unknown) {
  const received: unknown[] = [];
  const client = (task: LlmTask) => RunnableLambda.from(async (input: unknown) => {
    if (task === 'page') received.push(input);
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const clients: TaskClients = {
    continuation: client('continuation'), extraction: client('extraction'), page: client('page'), stamps: client('stamps'),
  };
  return { llm: buildChatLlm(clients, config), received };
}

describe('readPage', () => {
  it('sends the page as a base64 image block next to the instructions', async () => {
    const { llm, received } = llmReturning({ regions: [] });
    await llm.readPage(page('fake-png-bytes'));

    const message = (received[0] as Array<{ content: Array<Record<string, any>> }>)[0];
    const [instructions, image] = message.content;
    expect(instructions.type).toBe('text');
    expect(instructions.text).toMatch(/Do not translate/);
    expect(image.type).toBe('image_url');
    expect(image.image_url.url).toBe(
      `data:image/png;base64,${Buffer.from('fake-png-bytes').toString('base64')}`,
    );
  });

  it('returns the regions the model read', async () => {
    const { llm } = llmReturning({ regions: [
      { text: 'Diagnostic: anemie', x0: 0.1, y0: 0.2, x1: 0.6, y1: 0.25 },
    ] });
    expect(await llm.readPage(page())).toEqual({
      regions: [{ text: 'Diagnostic: anemie', x0: 0.1, y0: 0.2, x1: 0.6, y1: 0.25 }],
    });
  });

  it('clamps boxes into the page and puts them the right way up', async () => {
    const { llm } = llmReturning({ regions: [
      { text: 'edge', x0: -0.05, y0: 0.9, x1: 1.04, y1: 1.2 },
      { text: 'inverted', x0: 0.6, y0: 0.5, x1: 0.2, y1: 0.4 },
    ] });
    const reading = await llm.readPage(page());

    expect(reading!.regions[0]).toMatchObject({ x0: 0, y0: 0.9, x1: 1, y1: 1 });
    expect(reading!.regions[1]).toMatchObject({ x0: 0.2, y0: 0.4, x1: 0.6, y1: 0.5 });
  });

  it('drops blocks with no text, and accepts a blank page', async () => {
    const { llm } = llmReturning({ regions: [{ text: '  ', x0: 0, y0: 0, x1: 1, y1: 1 }] });
    expect(await llm.readPage(page())).toEqual({ regions: [] });
  });

  it('returns null, not a guess, when the answer is not the shape asked for', async () => {
    expect(await llmReturning({ text: 'plain text' }).llm.readPage(page())).toBeNull();
    expect(await llmReturning({ regions: [{ text: 'x', x0: 'left' }] }).llm.readPage(page())).toBeNull();
  });

  it('lets a transport error propagate, so the caller decides', async () => {
    const { llm } = llmReturning(new Error('503 from provider'));
    await expect(llm.readPage(page())).rejects.toThrow('503 from provider');
  });
});
