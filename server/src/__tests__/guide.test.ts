import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { buildTestApp, loginAs, loginSession } from './helpers/app.js';
import { OWNER_ID, createTestUser, seedDocument, seedSourceFile, seedShareLink } from './helpers/seed.js';
import { ScriptedModel } from 'spine-core/testing/scripted-model.js';
import { getStore } from 'spine-core/store/index.js';
import { resetChatLlm, type ChatLlm } from 'spine-core/llm/index.js';
import { HELP_TOPICS, START_TOPICS, helpTopic } from 'spine-core/help.js';
import { TOOL_KINDS } from 'spine-core/chat/agent.js';

/**
 * What helps a person start (core's routes/guide.ts and help.ts): what was shown is kept per person, how far they have got comes from their
 * own records, and the answers about Spine are fixed text written into a conversation without asking a model. The assistant can read the
 * same answers with a tool that only reads.
 */
let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
let other: string;
const llmWith = (m: ScriptedModel | null) => ({ agentModel: () => m, answerQuestion: async () => null }) as unknown as ChatLlm;

beforeAll(async () => {
  app = await buildTestApp();
  cookie = await loginSession(app);
  await createTestUser('guide-other@example.com');
  other = await loginAs(app, 'guide-other@example.com');
});
afterAll(async () => { await app.close(); });
beforeEach(async () => {
  for (const f of await getStore().sourceFiles.listFor(OWNER_ID)) await getStore().sourceFiles.delete(OWNER_ID, f.id);
  await getStore().conversations.removeAll(OWNER_ID);
});
afterEach(() => { resetChatLlm(); });

const get = (who = cookie) => app.inject({ method: 'GET', url: '/api/guide', headers: { cookie: who } });
const post = (url: string, payload?: object, who = cookie) => app.inject({ method: 'POST', url, payload, headers: { cookie: who } });

describe('what was shown to help the person start', () => {
  it('counts each showing, keeps the first time it was done with, and refuses a key it does not know', async () => {
    expect((await post('/api/guide/tip.grouping/shown')).statusCode).toBe(200);
    expect((await post('/api/guide/tip.grouping/shown')).statusCode).toBe(200);
    expect((await get()).json().marks['tip.grouping']).toMatchObject({ shown: 2, done_at: null });

    await post('/api/guide/tip.grouping/done');
    const first = (await get()).json().marks['tip.grouping'].done_at;
    expect(first).toEqual(expect.any(String));
    await new Promise(r => setTimeout(r, 5));
    await post('/api/guide/tip.grouping/done');
    expect((await get()).json().marks['tip.grouping'].done_at).toBe(first);

    expect((await post('/api/guide/anything/shown')).statusCode).toBe(404);
    expect((await post('/api/guide/anything/done')).statusCode).toBe(404);
  });

  it('is each person’s own', async () => {
    await post('/api/guide/welcome/shown');
    expect((await get()).json().marks.welcome.shown).toBeGreaterThan(0);
    expect((await get(other)).json().marks.welcome).toBeUndefined();
  });

  it('tells how far the person has got from their own uploads, reviews and links, not the sample records', async () => {
    expect((await get()).json().progress).toEqual({ uploads: 0, grouping_confirmed: 0, grouping_waiting: 0, reviewed: 0, shares: expect.any(Number) });
    const shares = (await get()).json().progress.shares;

    const sample = await seedSourceFile({ status: 'done', sample: true });
    const { id: sampleDoc } = await seedDocument({ sourceFileId: sample });
    await getStore().documents.update(OWNER_ID, sampleDoc, { reviewed: true });
    expect((await get()).json().progress).toMatchObject({ uploads: 0, reviewed: 0 });

    const waiting = await seedSourceFile({ status: 'done' });
    await getStore().sourceFiles.setGroupingConfirmed(OWNER_ID, waiting, false);
    const confirmed = await seedSourceFile({ status: 'done' });
    const { id: doc } = await seedDocument({ sourceFileId: confirmed });
    await seedShareLink({});
    expect((await get()).json().progress).toEqual({ uploads: 2, grouping_confirmed: 1, grouping_waiting: 1, reviewed: 0, shares: shares + 1 });
    await getStore().documents.update(OWNER_ID, doc, { reviewed: true });
    expect((await get()).json().progress.reviewed).toBe(1);
    expect((await get()).json().topics).toEqual(HELP_TOPICS.map(t => t.id));
  });

  it('offers in the welcome only topics that exist, and has one answer for each question', () => {
    expect(START_TOPICS.every(id => helpTopic(id))).toBe(true);
    expect(new Set(HELP_TOPICS.map(t => t.id)).size).toBe(HELP_TOPICS.length);
    expect(new Set(HELP_TOPICS.map(t => t.question)).size).toBe(HELP_TOPICS.length);
  });
});

describe('answers about Spine', () => {
  it('are written into Getting started without a model, as data the page draws and in English for the assistant', async () => {
    // No model at all: a call to one would fail the request.
    resetChatLlm(llmWith(null));
    const res = await post('/api/chat/help', { topic: 'privacy' });
    expect(res.statusCode).toBe(200);
    const { conversation } = res.json();
    expect(conversation).toMatchObject({ title: 'Getting started', origin: 'guide' });

    const { messages, unread } = (await app.inject({ method: 'GET', url: `/api/chat/conversations/${conversation.id}`, headers: { cookie } })).json();
    expect(unread).toBe(false);
    expect(messages).toMatchObject([
      { role: 'user', kind: 'help', data: { topic: 'privacy' }, content: helpTopic('privacy')!.question },
      { role: 'assistant', kind: 'help', data: { topic: 'privacy' } },
    ]);
    expect(messages[1].content).toContain(helpTopic('privacy')!.paragraphs[0]);

    // A second question goes into the same conversation, not a new one each time.
    const again = (await post('/api/chat/help', { topic: 'sharing' })).json();
    expect(again.conversation.id).toBe(conversation.id);
    expect((await getStore().conversations.list(OWNER_ID, 10)).filter(c => c.origin === 'guide')).toHaveLength(1);
  });

  it('go into the conversation the person is in when it is named, and only if it is theirs', async () => {
    await getStore().conversations.create(OWNER_ID, { id: 'mine-1', title: 'A question', createdAt: new Date().toISOString() });
    const res = await post('/api/chat/help', { topic: 'grouping', conversation_id: 'mine-1' });
    expect(res.json().conversation).toMatchObject({ id: 'mine-1', origin: null });
    expect(await getStore().conversations.messages(OWNER_ID, 'mine-1')).toHaveLength(2);

    expect((await post('/api/chat/help', { topic: 'grouping', conversation_id: 'mine-1' }, other)).statusCode).toBe(404);
    expect(await getStore().conversations.messages(OWNER_ID, 'mine-1')).toHaveLength(2);
  });

  it('refuse a topic that does not exist, and are off with the chat', async () => {
    expect((await post('/api/chat/help', { topic: 'nothing' })).statusCode).toBe(400);
    expect((await post('/api/chat/help', {})).statusCode).toBe(400);
    const saved = process.env.SPINE_CHAT;
    process.env.SPINE_CHAT = 'off';
    try {
      expect((await post('/api/chat/help', { topic: 'privacy' })).statusCode).toBe(409);
    } finally {
      if (saved === undefined) delete process.env.SPINE_CHAT; else process.env.SPINE_CHAT = saved;
    }
  });

  it('are what the assistant reads when asked how the app works, with a tool that only reads', async () => {
    expect(TOOL_KINDS.explain_spine).toBe('read');
    const model = new ScriptedModel([
      { tools: [{ name: 'explain_spine', args: { topic: 'password' } }] },
      { say: 'Your key is kept only while the page is open.' },
    ]);
    resetChatLlm(llmWith(model));
    const res = await post('/api/chat', { question: 'why does it ask for my password every time?' });
    expect(res.statusCode).toBe(200);
    const tool = model.seen.at(-1)!.filter(x => x.getType() === 'tool').map(x => String(x.content)).join('\n');
    expect(tool).toContain(helpTopic('password')!.paragraphs[0]);
  });
});
