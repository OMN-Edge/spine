import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { RunnableLambda } from '@langchain/core/runnables';
import { buildChatLlm } from '../llm/chat-llm.js';
import { useNativeTools, type NativeTools } from '../native-tools.js';
import type { ChatLlmConfig, LlmTask, TaskClients } from '../llm/index.js';

/**
 * `readPage` is the one call that sends an image off the host (SECURITY.md M-7).
 * These cover what is sent and what is done with the answer. Whether a given
 * provider accepts the image is not testable here without credentials — the message
 * shape is verified against both providers' request builders instead (see the
 * parser notes in docs/architecture/interfaces.md).
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
  const tasksUsed: LlmTask[] = [];
  const client = (task: LlmTask) => RunnableLambda.from(async (input: unknown) => {
    if (task === 'page' || task === 'pageThinking') { received.push(input); tasksUsed.push(task); }
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const clients: TaskClients = {
    continuation: client('continuation'), extraction: client('extraction'), page: client('page'), pageThinking: client('pageThinking'), stamps: client('stamps'), translation: client('translation'), linking: client('linking'), grouping: client('grouping'), chat: client('chat'), agent: client('agent'),
  };
  return { llm: buildChatLlm(clients, config), received, tasksUsed };
}

describe('readPage', () => {
  it('sends a shrunk JPEG, not the stored PNG, so a photographed page is a request a phone can carry', async () => {
    const asked: Array<{ maxSide: number; maxPixels: number }> = [];
    useNativeTools({ uprightJpeg: async (_src: string, options: { maxSide: number; maxPixels: number }) => { asked.push(options); return { jpeg: Buffer.from('small-jpeg'), width: 10, height: 10, channels: 3 }; } } as unknown as NativeTools);
    try {
      const { llm, received } = llmReturning({ regions: [] });
      await llm.readPage(page('a-very-large-png'));
      const image = (received[0] as Array<{ content: Array<Record<string, any>> }>)[0].content[1];
      expect(image.image_url.url).toBe(`data:image/jpeg;base64,${Buffer.from('small-jpeg').toString('base64')}`);
      expect(asked[0].maxSide).toBeLessThanOrEqual(2000);
      // The pixel count is the tool's guard against opening a picture, not the size sent: a page photographed at a few megapixels must pass it.
      expect(asked[0].maxPixels).toBeGreaterThanOrEqual(50_000_000);
    } finally {
      useNativeTools(null);
    }
  });

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

  it('reads with the thinking client only when asked to', async () => {
    const { llm, tasksUsed } = llmReturning({ regions: [] });
    await llm.readPage(page());
    await llm.readPage(page(), { thinking: false });
    await llm.readPage(page(), { thinking: true });
    expect(tasksUsed).toEqual(['page', 'page', 'pageThinking']);
  });

  it('returns the text the model read', async () => {
    const { llm } = llmReturning({ regions: [{ text: 'Diagnostic: anemie' }] });
    expect(await llm.readPage(page())).toEqual({ regions: [{ text: 'Diagnostic: anemie' }] });
  });

  it('asks for no positions, and ignores any the model adds anyway', async () => {
    const { llm, received } = llmReturning({ regions: [{ text: 'edge', x0: -0.05, y0: 0.9, x1: 1.04, y1: 1.2 }] });
    expect(await llm.readPage(page())).toEqual({ regions: [{ text: 'edge' }] });

    const prompt = ((received[0] as Array<{ content: Array<Record<string, any>> }>)[0]).content[0].text as string;
    expect(prompt).not.toMatch(/x0|y0|fractions/);
    expect(prompt).toMatch(/Do not give positions/);
  });

  it('drops blocks with no text, and accepts a blank page', async () => {
    const { llm } = llmReturning({ regions: [{ text: '  ' }] });
    expect(await llm.readPage(page())).toEqual({ regions: [] });
  });

  it('returns null, not a guess, when the answer is not the shape asked for', async () => {
    expect(await llmReturning({ text: 'plain text' }).llm.readPage(page())).toBeNull();
    expect(await llmReturning({ regions: [{ text: 5 }] }).llm.readPage(page())).toBeNull();
  });

  it('lets a transport error propagate, so the caller decides', async () => {
    const { llm } = llmReturning(new Error('503 from provider'));
    await expect(llm.readPage(page())).rejects.toThrow('503 from provider');
  });
});
