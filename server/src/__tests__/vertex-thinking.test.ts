import { describe, it, expect } from 'vitest';
import { buildTaskSpecs } from 'spine-core/llm/tasks.js';
import type { ChatLlmConfig } from 'spine-core/llm/index.js';
import { buildVertexTasks } from '../llm/adapters/vertex-tasks.js';

const config: ChatLlmConfig = {
  provider: 'vertex',
  model: 'gemini-3.5-flash',
  maxTokens: { continuation: 256, extraction: 2048, page: 4096 },
  maxRetries: 0, contextChars: 300_000,
  logger: { info: () => {}, warn: () => {} },
};

/**
 * A stand-in for ChatVertexAI that refuses `thinkingBudget` (a 400, as Gemini does beside an image) and answers with
 * `thinkingLevel`; request n is answered after `delay(n)` ms, so calls can be in flight together. `sent` records the setting of every request.
 */
function fakeChat(delay: (n: number) => number, refuses: (fields: Record<string, unknown>) => boolean) {
  const sent: string[] = [];
  class Chat {
    constructor(private readonly fields: Record<string, unknown>) {}
    withStructuredOutput() {
      const fields = this.fields;
      return {
        invoke: async () => {
          const n = sent.push('thinkingBudget' in fields ? 'budget' : 'thinkingLevel' in fields ? 'level' : 'none') - 1;
          await new Promise(resolve => setTimeout(resolve, delay(n)));
          if (refuses(fields)) throw new Error('Request failed with status code 400');
          return { regions: [] };
        },
      };
    }
  }
  return { Chat: Chat as never, sent };
}

describe('turning thinking off on Gemini', () => {
  it('does not send a call back with the setting it was just refused, when another call switched while it was out', async () => {
    // Three pages read at once, as an upload does: all go with the budget, all are refused. The first is refused at
    // once and switches to the level; the other two are refused after that, and must still try the level, not "the
    // other one" of what is now current (Nov 2: two pages of an upload were left unread this way).
    const { Chat, sent } = fakeChat(n => (n === 1 || n === 2 ? 20 : 0), fields => 'thinkingBudget' in fields);
    const clients = buildVertexTasks(config, buildTaskSpecs(config), 'example.invalid', Chat, Chat);

    const results = await Promise.allSettled([1, 2, 3].map(() => clients.page.invoke([])));

    expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    expect(sent.filter(s => s === 'budget')).toHaveLength(3);
    expect(sent.filter(s => s === 'level')).toHaveLength(3);
  });

  it('remembers the setting for each task on its own: a page that needs the level does not move the text tasks off the budget', async () => {
    // A page (an image) refuses the budget; continuation (text) refuses the level. Each keeps what worked for it.
    const { Chat, sent } = fakeChat(() => 0, fields => ('thinkingBudget' in fields) === (fields.maxOutputTokens === 4096));
    const clients = buildVertexTasks(config, buildTaskSpecs(config), 'example.invalid', Chat, Chat);

    await clients.page.invoke([]);
    sent.length = 0;
    await clients.continuation.invoke([]);
    await clients.page.invoke([]);

    expect(sent).toEqual(['budget', 'level']);
  });
});
