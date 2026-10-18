import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { BaseChatModel, type BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import { buildTestApp, loginSession } from './helpers/app.js';
import { OWNER_ID, seedDocument } from './helpers/seed.js';
import { getStore } from '../store/index.js';
import { resetChatLlm, type ChatLlm } from '../llm/index.js';

/**
 * Asking with `stream: true`: the reply is JSON lines (steps, pieces of the answer, then the whole reply), and what is kept is
 * what the plain form keeps. The model is a scripted stand-in that writes its text in pieces.
 */
type Step = { lead?: string; tools: Array<{ name: string; args: Record<string, unknown> }> } | { say: string[] } | { fail: string };

class StreamingModel extends BaseChatModel {
  private i = 0;
  constructor(private steps: Step[], params: BaseChatModelParams = {}) { super(params); }
  _llmType() { return 'streaming-scripted'; }
  bindTools() { return this; }
  async _generate(_m: BaseMessage[]): Promise<ChatResult> {
    const message = new AIMessage('unused: this model is only read as a stream');
    return { generations: [{ text: '', message }] };
  }
  async *_streamResponseChunks(): AsyncGenerator<ChatGenerationChunk> {
    const step = this.steps[Math.min(this.i++, this.steps.length - 1)];
    if ('fail' in step) throw new Error(step.fail);
    if ('say' in step) {
      for (const piece of step.say) yield new ChatGenerationChunk({ text: piece, message: new AIMessageChunk({ content: piece }) });
      return;
    }
    if (step.lead) yield new ChatGenerationChunk({ text: step.lead, message: new AIMessageChunk({ content: step.lead }) });
    yield new ChatGenerationChunk({
      text: '',
      message: new AIMessageChunk({
        content: '',
        tool_call_chunks: step.tools.map((t, n) => ({ id: `call-${this.i}-${n}`, name: t.name, args: JSON.stringify(t.args), index: n, type: 'tool_call_chunk' as const })),
      }),
    });
  }
}

const llmWith = (m: StreamingModel) => ({ agentModel: () => m, answerQuestion: async () => ({ answer: 'from the fixed pipeline', sources: [] }) }) as unknown as ChatLlm;

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
beforeAll(async () => { app = await buildTestApp(); cookie = await loginSession(app); });
afterAll(async () => { await app.close(); });
beforeEach(async () => {
  for (const f of await getStore().sourceFiles.listFor(OWNER_ID)) await getStore().sourceFiles.delete(OWNER_ID, f.id);
  for (const c of await getStore().conversations.list(OWNER_ID, 200)) await getStore().conversations.remove(OWNER_ID, c.id);
});
afterEach(() => resetChatLlm());

const ask = (body: object) => app.inject({ method: 'POST', url: '/api/chat', payload: body, headers: { cookie } });
const events = (res: { body: string }) => res.body.split('\n').filter(Boolean).map(l => JSON.parse(l) as { type: string; [k: string]: unknown });

async function blood() {
  const d = await seedDocument({ userId: OWNER_ID, docType: 'lab_result', docDate: '2026-01-10', provider: null, aiSummary: 'Complete blood count' });
  await getStore().documents.update(OWNER_ID, d.id, { title: 'Blood count' });
  return d;
}

describe('streaming a question', () => {
  it('sends the steps, the answer in pieces, and the whole reply, and keeps the conversation', async () => {
    const d = await blood();
    resetChatLlm(llmWith(new StreamingModel([
      { lead: 'Let me look. ', tools: [{ name: 'search_documents', args: { query: 'blood count' } }] },
      { tools: [{ name: 'get_document', args: { label: 'D1' } }] },
      { say: ['It is a ', 'blood count ', '[D1.summary].'] },
    ])));
    const res = await ask({ question: 'what is it?', stream: true });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/x-ndjson/);
    expect(res.headers['x-accel-buffering']).toBe('no');
    const list = events(res);
    expect(list.filter(e => e.type === 'step').map(e => [e.kind, e.detail])).toEqual([['search', 'blood count'], ['open', 'Blood count']]);
    // The lead-in was shown and then taken back; the answer came in three pieces.
    expect(list.map(e => e.type).filter(t => t !== 'ping')).toEqual(['delta', 'reset', 'step', 'step', 'delta', 'delta', 'delta', 'done']);
    expect(list.filter(e => e.type === 'delta').map(e => e.text).slice(1).join('')).toBe('It is a blood count [D1.summary].');
    const done = list.at(-1)! as unknown as { reply: { answer: string; sources: Array<{ id: string; section?: string }>; conversation: { id: string } } };
    expect(done.reply.answer).toBe('It is a blood count [D1.summary].');
    expect(done.reply.sources).toMatchObject([{ id: d.id, section: 'summary' }]);
    const kept = await getStore().conversations.messages(OWNER_ID, done.reply.conversation.id);
    expect(kept.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(kept[1].content).toBe('It is a blood count [D1.summary].');
  });

  it('refuses before the first byte, with an ordinary status', async () => {
    resetChatLlm(llmWith(new StreamingModel([{ say: ['x'] }])));
    expect((await ask({ question: '   ', stream: true })).statusCode).toBe(400);
    expect((await ask({ question: 'hi', stream: true, conversation_id: 'nope' })).statusCode).toBe(404);
  });

  it('says so in the stream when it cannot answer, and keeps nothing', async () => {
    await blood();
    // The agent fails and so does the fixed pipeline's model.
    const failing = { agentModel: () => new StreamingModel([{ fail: 'provider down' }]), answerQuestion: async () => null } as unknown as ChatLlm;
    resetChatLlm(failing);
    const res = await ask({ question: 'blood count', stream: true });
    const list = events(res).filter(e => e.type !== 'ping');
    expect(list.at(-1)).toMatchObject({ type: 'error', status: 502 });
    expect(await getStore().conversations.list(OWNER_ID, 200)).toEqual([]);
  });

  it('is the same reply as the plain form', async () => {
    await blood();
    const script = () => new StreamingModel([{ say: ['A blood count.'] }]);
    resetChatLlm(llmWith(script()));
    const plain = (await ask({ question: 'what is it?' })).json();
    resetChatLlm(llmWith(script()));
    const done = events(await ask({ question: 'what is it?', stream: true })).at(-1) as unknown as { reply: typeof plain };
    expect(done.reply.answer).toBe(plain.answer);
    expect(done.reply.sources).toEqual(plain.sources);
  });
});
