import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { BaseChatModel, type BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { buildTestApp, loginAs, loginSession } from './helpers/app.js';
import { OWNER_ID, createTestUser, seedDocument } from './helpers/seed.js';
import { getStore } from 'spine-core/store/index.js';
import { resetChatLlm, type ChatLlm } from 'spine-core/llm/index.js';
import { TOOL_KINDS, splitCitations } from 'spine-core/chat/agent.js';
import { checkScreen } from 'spine-core/chat/screen.js';

/**
 * The chat as an agent. The model is a scripted stand-in that asks for the tool calls a test gives it and then answers, so
 * these tests cover what is ours: what a tool can reach, what the loop is allowed to do, and how the answer is tied back.
 */
type Step = { tools: Array<{ name: string; args: Record<string, unknown> }> } | { say: string };

class ScriptedModel extends BaseChatModel {
  seen: BaseMessage[][] = [];
  bound: string[] = [];
  private i = 0;
  constructor(private steps: Step[], params: BaseChatModelParams = {}) { super(params); }
  _llmType() { return 'scripted'; }
  bindTools(tools: Array<{ name: string }>) { this.bound = tools.map(t => t.name); return this; }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push(messages);
    const step = this.steps[Math.min(this.i++, this.steps.length - 1)];
    const message = 'say' in step
      ? new AIMessage(step.say)
      : new AIMessage({ content: '', tool_calls: step.tools.map((t, n) => ({ id: `call-${this.i}-${n}`, name: t.name, args: t.args, type: 'tool_call' as const })) });
    return { generations: [{ text: typeof message.content === 'string' ? message.content : '', message }] };
  }
}

let model: ScriptedModel;
const llmWith = (m: ScriptedModel | null) => ({ agentModel: () => m, answerQuestion: async () => ({ answer: 'from the fixed pipeline', sources: [] }) }) as unknown as ChatLlm;

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
let otherId: string;
beforeAll(async () => {
  app = await buildTestApp();
  cookie = await loginSession(app);
  otherId = (await createTestUser('other@spine.test')).id;
  void loginAs;
});
afterAll(async () => { await app.close(); });
beforeEach(async () => {
  for (const userId of [OWNER_ID, otherId]) for (const f of await getStore().sourceFiles.listFor(userId)) await getStore().sourceFiles.delete(userId, f.id);
});
afterEach(() => {
  resetChatLlm();
});

const ask = (body: unknown) => app.inject({ method: 'POST', url: '/api/chat', payload: body as object, headers: { cookie } });
async function doc(title: string, summary: string, userId = OWNER_ID, date = '2026-01-10', docType: 'lab_result' | 'consultation_note' = 'lab_result') {
  const d = await seedDocument({ userId, docType, docDate: date, provider: null, aiSummary: summary });
  await getStore().documents.update(userId, d.id, { title });
  return d;
}
async function result(documentId: string, pageId: string | null, canonical: string, value: string, date: string, userId = OWNER_ID) {
  await getStore().measurements.create(userId, { id: uuidv4(), documentId, pageId: pageId!, name: 'Hemoglobina', canonical, valueText: value, valueNum: Number(value), unit: 'g/dL', refLow: 12, refHigh: 16, flag: null, takenOn: date, sourceSnippet: null, bbox: null, confidence: 1 });
}
const toolOutputs = (m: ScriptedModel) => m.seen.at(-1)!.filter(x => x.getType() === 'tool').map(x => String(x.content));

describe('the agent decides what to look up', () => {
  it('searches, opens what it found, and answers with citations tied back to documents', async () => {
    const d = await doc('Blood count', 'Complete blood count');
    await result(d.id, d.pageId, 'hemoglobin', '13.5', '2026-01-10');
    model = new ScriptedModel([
      { tools: [{ name: 'search_documents', args: { query: 'blood count' } }] },
      { tools: [{ name: 'get_document', args: { label: 'D1' } }] },
      { say: 'Your haemoglobin was 13.5 g/dL on 2026-01-10 [D1.results], [D1, D9].' },
    ]);
    resetChatLlm(llmWith(model));
    const res = await ask({ question: 'what was my haemoglobin?' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.answer).toBe('Your haemoglobin was 13.5 g/dL on 2026-01-10 [D1.results], [D1][D9].');
    // D9 was never shown to the model; D1.results was, by get_document.
    expect(body.sources).toEqual([
      { label: 'D1.results', id: d.id, title: 'Blood count', doc_type: 'lab_result', doc_date: '2026-01-10', section: 'results' },
      { label: 'D1', id: d.id, title: 'Blood count', doc_type: 'lab_result', doc_date: '2026-01-10' },
    ]);
    expect(body.looked).toEqual(['searched “blood count”', 'opened D1']);
    expect(toolOutputs(model).join('\n')).toMatch(/Hemoglobina: 13\.5 g\/dL/);
    expect([...model.bound].sort()).toEqual(Object.keys(TOOL_KINDS).sort());
  });

  it('keeps nothing of one question for the next, though the graph is built once', async () => {
    await doc('Alpha report', 'alpha findings');
    model = new ScriptedModel([
      { tools: [{ name: 'search_documents', args: { query: 'alpha' } }] },
      { say: 'First.' },
      // A new question: D1 was only a label of the one before.
      { tools: [{ name: 'get_document', args: { label: 'D1' } }] },
      { say: 'Second.' },
    ]);
    resetChatLlm(llmWith(model));
    expect((await ask({ question: 'alpha?' })).statusCode).toBe(200);
    expect((await ask({ question: 'and D1?' })).statusCode).toBe(200);
    expect(toolOutputs(model).at(-1)).toMatch(/There is no document D1/);
  });

  it('answers a question about the screen without any tool, with the document on screen in sections', async () => {
    const d = await doc('Blood count', 'Complete blood count');
    await result(d.id, d.pageId, 'hemoglobin', '13.5', '2026-01-10');
    model = new ScriptedModel([{ say: 'It is a blood count [D1.summary].' }]);
    resetChatLlm(llmWith(model));
    const res = await ask({ question: 'what is this?', screen: { page: 'document', documentId: d.id } });
    expect(res.statusCode).toBe(200);
    const sent = model.seen[0].map(m => String(m.content)).join('\n');
    expect(sent).toContain('[S0]');
    expect(sent).toContain('The document on screen is D1');
    expect(sent).toMatch(/\[D1\.results\]\nHemoglobina: 13\.5/);
    expect(res.json().sources).toMatchObject([{ label: 'D1.summary', section: 'summary', id: d.id }]);
    expect(res.json().looked).toEqual([]);
  });

  it('can reach only the signed-in person’s shown documents, and never by id', async () => {
    const mine = await doc('Cholesterol mine', 'My cholesterol panel');
    await doc('Cholesterol theirs', 'Cholesterol of someone else', otherId);
    const hidden = await doc('Cholesterol hidden', 'Hidden by the owner');
    await getStore().pages.setHiddenForDocument(OWNER_ID, hidden.id, true);
    const waiting = await doc('Cholesterol waiting', 'In an unconfirmed upload');
    await getStore().sourceFiles.setGroupingConfirmed(OWNER_ID, waiting.sourceFileId, false);
    model = new ScriptedModel([
      { tools: [{ name: 'search_documents', args: { query: 'cholesterol' } }, { name: 'get_document', args: { label: mine.id } }, { name: 'get_document', args: { label: 'D44' } }] },
      { say: 'done' },
    ]);
    resetChatLlm(llmWith(model));
    await ask({ question: 'cholesterol' });
    const out = toolOutputs(model).join('\n');
    expect(out).toContain('Cholesterol mine');
    for (const other of ['theirs', 'hidden', 'waiting']) expect(out).not.toContain(`Cholesterol ${other}`);
    // A real document id is not a label, and a label it was never given opens nothing.
    expect(out).toContain(`There is no document ${mine.id}`);
    expect(out).toContain('There is no document D44');
  });

  it('gives a test’s values over time with their documents, and lists the tests', async () => {
    const a = await doc('Blood count', 'Complete blood count', OWNER_ID, '2026-01-10');
    const b = await doc('Control', 'Control blood count', OWNER_ID, '2026-04-10');
    await result(a.id, a.pageId, 'hemoglobin', '13.5', '2026-01-10');
    await result(b.id, b.pageId, 'hemoglobin', '12.1', '2026-04-10');
    model = new ScriptedModel([{ tools: [{ name: 'list_tests', args: {} }, { name: 'get_test_series', args: { test: 'hemoglobin' } }] }, { say: 'It fell [D1][D2].' }]);
    resetChatLlm(llmWith(model));
    const res = await ask({ question: 'how did my hemoglobin change?' });
    const out = toolOutputs(model).join('\n');
    expect(out).toMatch(/hemoglobin\): 2 values, latest 12\.1 g\/dL on 2026-04-10/);
    expect(out).toMatch(/2026-01-10: 13\.5 g\/dL \[D1\]\n2026-04-10: 12\.1 g\/dL \[D2\]/);
    expect(res.json().sources.map((s: { id: string }) => s.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('follows the connections of a document', async () => {
    const consult = await doc('Cardiology visit', 'Recommended tests: lipid panel', OWNER_ID, '2026-03-01', 'consultation_note');
    const lab = await doc('Lipid panel', 'Cholesterol results', OWNER_ID, '2026-03-20');
    await getStore().links.add(OWNER_ID, { from_document_id: consult.id, to_document_id: lab.id, kind: 'requests', source: 'owner', state: 'confirmed', reason: null }, '2026-04-01T00:00:00Z');
    model = new ScriptedModel([
      { tools: [{ name: 'search_documents', args: { query: 'lipid' } }] },
      { tools: [{ name: 'get_connected_documents', args: { label: 'D1' } }] },
      { say: 'The cardiologist asked for it.' },
    ]);
    resetChatLlm(llmWith(model));
    await ask({ question: 'lipid panel' });
    expect(toolOutputs(model).join('\n')).toMatch(/D\d asked for D\d/);
  });
});

describe('what is on screen', () => {
  it('lists only the shown documents of the signed-in person, and says what the screen is', async () => {
    const mine = await doc('Blood count', 'Complete blood count');
    const theirs = await doc('Their blood count', 'Complete blood count', otherId);
    const hidden = await doc('Hidden count', 'Hidden by the owner');
    await getStore().pages.setHiddenForDocument(OWNER_ID, hidden.id, true);
    model = new ScriptedModel([{ say: 'fine' }]);
    resetChatLlm(llmWith(model));
    await ask({ question: 'what is on this page?', screen: { page: 'timeline', documentIds: [mine.id, theirs.id, hidden.id], filters: { doc_type: 'lab_result' } } });
    const sent = model.seen[0].map(m => String(m.content)).join('\n');
    expect(sent).toContain('the Timeline');
    expect(sent).toContain('doc_type = lab_result');
    expect(sent).toContain('D1: Blood count');
    expect(sent).not.toContain('Their blood count');
    expect(sent).not.toContain('Hidden count');
  });

  it('shows an upload’s grouping, including documents still waiting for it to be confirmed, and tells the search apart', async () => {
    const waiting = await doc('Waiting panel', 'Thyroid panel');
    await getStore().sourceFiles.setGroupingConfirmed(OWNER_ID, waiting.sourceFileId, false);
    model = new ScriptedModel([{ say: 'ok' }]);
    resetChatLlm(llmWith(model));
    await ask({ question: 'is this grouped right?', screen: { page: 'upload_pages', uploadId: waiting.sourceFileId } });
    const sent = model.seen[0].map(m => String(m.content)).join('\n');
    expect(sent).toContain('grouping NOT yet confirmed');
    expect(sent).toContain('Waiting panel');
  });

  it('resolves the selected field or result, and ignores an id that is not this document’s', async () => {
    const d = await doc('Blood count', 'Complete blood count');
    await result(d.id, d.pageId, 'hemoglobin', '13.5', '2026-01-10');
    const [m] = await getStore().measurements.listForDocument(OWNER_ID, d.id);
    model = new ScriptedModel([{ say: 'a' }, { say: 'b' }]);
    resetChatLlm(llmWith(model));
    await ask({ question: 'why is this flagged?', screen: { page: 'document', documentId: d.id, selectedId: m.id } });
    expect(model.seen[0].map(x => String(x.content)).join('\n')).toContain('selected result Hemoglobina: 13.5 g/dL');
    await ask({ question: 'and this?', screen: { page: 'document', documentId: d.id, selectedId: 'not-an-id-of-mine' } });
    expect(model.seen[1].map(x => String(x.content)).join('\n')).not.toContain('selected');
  });

  it('is also given to the fixed pipeline, which cites a section the same way', async () => {
    const d = await doc('Blood count', 'Complete blood count');
    await result(d.id, d.pageId, 'hemoglobin', '13.5', '2026-01-10');
    const seen: Array<{ label: string; text: string }[]> = [];
    resetChatLlm({
      agentModel: () => null,
      answerQuestion: async (_q: string, records: Array<{ label: string; text: string }>) => { seen.push(records); return { answer: 'It was 13.5 [D1.results].', sources: ['D1.results'] }; },
    } as unknown as ChatLlm);
    const res = await ask({ question: 'what is this value?', screen: { page: 'document', documentId: d.id } });
    expect(seen[0].map(r => r.label)).toEqual(expect.arrayContaining(['S0', 'D1.summary', 'D1.results']));
    expect(res.json().sources).toMatchObject([{ label: 'D1.results', section: 'results', id: d.id }]);
  });
});

describe('the limits of the loop', () => {
  it('stops after the allowed rounds and makes the model answer without tools', async () => {
    await doc('Blood count', 'Complete blood count');
    // The model never stops asking. After the rounds are used the pending request is replaced by an instruction, and the next reply is the answer.
    let calls = 0;
    const loop = new (class extends ScriptedModel {
      async _generate(messages: BaseMessage[]): Promise<ChatResult> {
        calls++;
        const last = messages.at(-1);
        if (last && String(last.content).startsWith('Tools are no longer available')) {
          return { generations: [{ text: 'Answering with what I have.', message: new AIMessage('Answering with what I have.') }] };
        }
        return super._generate(messages);
      }
    })([{ tools: [{ name: 'search_documents', args: { query: 'blood' } }] }]);
    resetChatLlm(llmWith(loop));
    const res = await ask({ question: 'blood' });
    expect(res.statusCode).toBe(200);
    expect(res.json().answer).toBe('Answering with what I have.');
    // Eight rounds of tools, then the instruction, then the answer.
    expect(calls).toBeLessThanOrEqual(11);
  });

  it('cuts what a tool returns and stops reading when the budget for the question is used', async () => {
    for (let i = 0; i < 4; i++) {
      const d = await doc(`Panel ${i}`, 'Long panel', OWNER_ID, `2026-02-0${i + 1}`);
      for (let n = 0; n < 40; n++) await result(d.id, d.pageId, `test${n}`, '1', `2026-02-0${i + 1}`);
    }
    model = new ScriptedModel([
      { tools: [{ name: 'search_documents', args: { query: 'panel' } }] },
      { tools: [1, 2, 3, 4].map(n => ({ name: 'get_document', args: { label: `D${n}`, sections: ['results'] } })) },
      { say: 'ok' },
    ]);
    resetChatLlm(llmWith(model));
    await ask({ question: 'panel' });
    const out = toolOutputs(model);
    expect(out.every(o => o.length <= 12_200)).toBe(true);
  });
});

describe('fallbacks and switches', () => {
  it('answers without tools when the model cannot take them and when the agent fails', async () => {
    await doc('Blood count', 'Complete blood count');
    resetChatLlm(llmWith(null));
    expect((await ask({ question: 'blood count' })).json().answer).toBe('from the fixed pipeline');

    const broken = new (class extends ScriptedModel { async _generate(): Promise<ChatResult> { throw new Error('provider down'); } })([]);
    resetChatLlm(llmWith(broken));
    const reply = (await ask({ question: 'blood count' })).json();
    expect(reply.answer).toBe('from the fixed pipeline');
    // Said, so the page can tell the person no change could be prepared.
    expect(reply.limited).toBe(true);
  });

  it('asks the agent on an empty archive too, since the question may be about Spine itself', async () => {
    model = new ScriptedModel([{ tools: [{ name: 'explain_spine', args: { topic: 'adding' } }] }, { say: 'Add a PDF on the Upload page.' }]);
    resetChatLlm(llmWith(model));
    expect((await ask({ question: 'how do I start?' })).json()).toMatchObject({ answer: 'Add a PDF on the Upload page.', sources: [] });
    expect(model.seen.length).toBeGreaterThan(0);
  });
});

describe('what is held to, in code', () => {
  it('has no tool that changes anything: an action tool only proposes (chat-actions.test.ts runs them)', () => {
    for (const [name, kind] of Object.entries(TOOL_KINDS)) expect(name.startsWith('propose_')).toBe(kind === 'action');
  });

  it('turns grouped citations into one marker each', () => {
    expect(splitCitations('A [D1, d2.Results] and [see D3] and [D4].')).toBe('A [D1][D2.results] and [see D3] and [D4].');
  });

  it('checks what the screen says', () => {
    expect(checkScreen({ page: 'document', documentId: 'abc', editing: true })).toEqual({ page: 'document', documentId: 'abc', editing: true });
    expect(checkScreen({ page: 'nowhere' })).toMatch(/page/);
    expect(checkScreen({ page: 'timeline', documentIds: Array.from({ length: 31 }, (_, i) => `d${i}`) })).toMatch(/at most 30/);
    expect(checkScreen({ page: 'timeline', filters: { a: 1 } })).toMatch(/filters/);
    expect(checkScreen({ page: 'document', documentId: 'x'.repeat(65) })).toMatch(/id/);
  });

  it('rejects a bad screen with a 400', async () => {
    expect((await ask({ question: 'x', screen: { page: 'nowhere' } })).statusCode).toBe(400);
  });
});
