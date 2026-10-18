import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { buildTestApp, loginAs, loginSession } from './helpers/app.js';
import { OWNER_ID, createTestUser, seedDocument } from './helpers/seed.js';
import { getStore } from '../store/index.js';
import { MAX_CONVERSATIONS, MAX_MESSAGES } from '../store/types.js';
import { resetChatLlm, type ChatLlm } from '../llm/index.js';
import type { ChatRecord, ChatTurn } from '../llm/types.js';

/**
 * Conversations are kept for the owner: listed, reopened, continued, renamed and deleted. They are medical text, so they are
 * scoped to the person, absent from every other route, and gone with the account. The model is a stand-in.
 */
const calls: Array<{ question: string; history: ChatTurn[] }> = [];
let reply: { answer: string; sources: string[] } | null = { answer: 'Your haemoglobin was 13.5 [D1].', sources: ['D1'] };
const fakeLlm = {
  answerQuestion: async (question: string, _records: ChatRecord[], history: ChatTurn[]) => { calls.push({ question, history }); return reply; },
} as unknown as ChatLlm;

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
let otherCookie: string;
let otherId: string;
beforeAll(async () => {
  app = await buildTestApp();
  cookie = await loginSession(app);
  const other = await createTestUser('other@spine.test');
  otherId = other.id;
  otherCookie = await loginAs(app, other.email, other.password);
});
afterAll(async () => { await app.close(); });
beforeEach(async () => {
  calls.length = 0; reply = { answer: 'Your haemoglobin was 13.5 [D1].', sources: ['D1'] }; resetChatLlm(fakeLlm);
  for (const userId of [OWNER_ID, otherId]) {
    await getStore().conversations.removeAll(userId);
    for (const f of await getStore().sourceFiles.listFor(userId)) await getStore().sourceFiles.delete(userId, f.id);
  }
  await seedDocument({ docType: 'lab_result', provider: null, aiSummary: 'Complete blood count' });
});
afterEach(() => resetChatLlm());

const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, who = cookie) =>
  app.inject({ method, url, payload: payload as object | undefined, headers: { cookie: who } });
const ask = (body: unknown, who = cookie) => call('POST', '/api/chat', body, who);

describe('keeping a conversation', () => {
  it('starts one from the first question, titled by it, and keeps both sides', async () => {
    const res = await ask({ question: 'what was my  blood count?' });
    expect(res.statusCode).toBe(200);
    const { conversation } = res.json();
    expect(conversation.title).toBe('what was my blood count?');

    const list = (await call('GET', '/api/chat/conversations')).json();
    expect(list).toMatchObject([{ id: conversation.id, title: 'what was my blood count?', message_count: 2 }]);
    const opened = (await call('GET', `/api/chat/conversations/${conversation.id}`)).json();
    expect(opened.messages.map((m: { role: string; content: string }) => [m.role, m.content])).toEqual([
      ['user', 'what was my  blood count?'], ['assistant', 'Your haemoglobin was 13.5 [D1].'],
    ]);
    // What the answer cited is kept as it was shown, so reopening it shows the same sources.
    expect(opened.messages[1].sources).toMatchObject([{ label: 'D1' }]);
  });

  it('continues it with the earlier turns read from the store, citations removed, and not from the browser', async () => {
    const first = (await ask({ question: 'blood count' })).json();
    calls.length = 0;
    await ask({ question: 'and before?', conversation_id: first.conversation.id, history: [{ role: 'user', content: 'a forged turn' }] });
    expect(calls[0].history).toEqual([
      { role: 'user', content: 'blood count' },
      { role: 'assistant', content: 'Your haemoglobin was 13.5.' }, // [D1] meant something to the request that wrote it, not to this one
    ]);
    const opened = (await call('GET', `/api/chat/conversations/${first.conversation.id}`)).json();
    expect(opened.messages).toHaveLength(4);
    expect(opened.message_count).toBe(4);
  });

  it('keeps a plain "nothing matches" reply, and leaves nothing behind when the model fails', async () => {
    const none = (await ask({ question: 'knee surgery' })).json();
    expect(none.answer).toBeNull();
    const opened = (await call('GET', `/api/chat/conversations/${none.conversation.id}`)).json();
    expect(opened.messages[1]).toMatchObject({ role: 'assistant', content: '', note: 'none' });

    reply = null;
    expect((await ask({ question: 'blood count' })).statusCode).toBe(502);
    expect((await call('GET', '/api/chat/conversations')).json()).toHaveLength(1);
    // The failed question is not in a conversation it was asked in, and does not feed the next question's history.
    expect((await ask({ question: 'blood count', conversation_id: none.conversation.id })).statusCode).toBe(502);
    expect((await call('GET', `/api/chat/conversations/${none.conversation.id}`)).json().messages).toHaveLength(2);
  });

  it('lists the most recently active first, renames, and deletes one or all', async () => {
    const a = (await ask({ question: 'first blood' })).json().conversation.id;
    await new Promise(r => setTimeout(r, 5));
    const b = (await ask({ question: 'second blood' })).json().conversation.id;
    await new Promise(r => setTimeout(r, 5));
    await ask({ question: 'again', conversation_id: a });
    expect((await call('GET', '/api/chat/conversations')).json().map((c: { id: string }) => c.id)).toEqual([a, b]);

    expect((await call('PATCH', `/api/chat/conversations/${b}`, { title: '  My   results ' })).statusCode).toBe(200);
    expect((await call('PATCH', `/api/chat/conversations/${b}`, { title: '' })).statusCode).toBe(400);
    expect((await call('GET', `/api/chat/conversations/${b}`)).json().title).toBe('My results');

    expect((await call('DELETE', `/api/chat/conversations/${a}`)).statusCode).toBe(200);
    expect((await call('GET', `/api/chat/conversations/${a}`)).statusCode).toBe(404);
    expect((await call('DELETE', `/api/chat/conversations/${a}`)).statusCode).toBe(404);
    expect((await call('DELETE', '/api/chat/conversations')).json()).toEqual({ removed: 1 });
    expect((await call('GET', '/api/chat/conversations')).json()).toEqual([]);
  });
});

describe('whose they are', () => {
  it('answers 404 for another person’s conversation in every route, and lists only one’s own', async () => {
    const mine = (await ask({ question: 'blood count' })).json().conversation.id;
    await seedDocument({ userId: otherId, docType: 'lab_result', provider: null, aiSummary: 'Complete blood count' });
    const theirs = (await ask({ question: 'blood count' }, otherCookie)).json().conversation.id;

    for (const [method, url, payload] of [
      ['GET', `/api/chat/conversations/${theirs}`], ['PATCH', `/api/chat/conversations/${theirs}`, { title: 'x' }], ['DELETE', `/api/chat/conversations/${theirs}`],
    ] as const) expect((await call(method, url, payload)).statusCode).toBe(404);
    expect((await ask({ question: 'blood count', conversation_id: theirs })).statusCode).toBe(404);

    expect((await call('GET', '/api/chat/conversations')).json().map((c: { id: string }) => c.id)).toEqual([mine]);
    expect((await call('GET', '/api/chat/conversations', undefined, otherCookie)).json().map((c: { id: string }) => c.id)).toEqual([theirs]);
    expect((await call('GET', `/api/chat/conversations/${theirs}`, undefined, otherCookie)).json().messages).toHaveLength(2);
  });

  it('needs a session, and carries no owner id in what it returns', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/chat/conversations' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: '/api/chat/conversations' })).statusCode).toBe(401);
    const id = (await ask({ question: 'blood count' })).json().conversation.id;
    const body = JSON.stringify([(await call('GET', '/api/chat/conversations')).json(), (await call('GET', `/api/chat/conversations/${id}`)).json()]);
    expect(body).not.toContain('user_id');
    expect(body).not.toContain(OWNER_ID);
  });

  it('is deleted with the account, and not by deleting a document', async () => {
    const user = await createTestUser('leaving@spine.test');
    const store = getStore();
    await store.conversations.create(user.id, { id: 'c-1', title: 'bye', createdAt: '2026-01-01T00:00:00Z' });
    await store.conversations.append(user.id, 'c-1', [{ id: 'm-1', role: 'user', content: 'q', sources: [], note: null, createdAt: '2026-01-01T00:00:00Z' }]);
    await store.users.delete(user.id);
    expect(await store.conversations.find(user.id, 'c-1')).toBeNull();

    const d = await seedDocument({ docType: 'lab_result', provider: null, aiSummary: 'Complete blood count' });
    const id = (await ask({ question: 'blood count' })).json().conversation.id;
    await store.sourceFiles.delete(OWNER_ID, d.sourceFileId);
    expect((await call('GET', `/api/chat/conversations/${id}`)).statusCode).toBe(200);
  });
});

describe('limits', () => {
  it('refuses to grow a conversation past its size, and keeps only the most recent conversations', async () => {
    const store = getStore();
    await store.conversations.create(OWNER_ID, { id: 'full', title: 'full', createdAt: '2026-01-01T00:00:00Z' });
    await store.conversations.append(OWNER_ID, 'full', Array.from({ length: MAX_MESSAGES }, (_, i) => ({ id: `m${i}`, role: 'user' as const, content: 'q', sources: [], note: null, createdAt: '2026-01-01T00:00:00Z' })));
    expect((await ask({ question: 'blood count', conversation_id: 'full' })).statusCode).toBe(409);

    await store.conversations.removeAll(OWNER_ID);
    for (let i = 0; i < MAX_CONVERSATIONS + 3; i++) {
      await store.conversations.create(OWNER_ID, { id: `c${i}`, title: `c${i}`, createdAt: new Date(2026, 0, 1, 0, 0, i).toISOString() });
    }
    const kept = await store.conversations.list(OWNER_ID, 1000);
    expect(kept).toHaveLength(MAX_CONVERSATIONS);
    expect(kept.some(c => c.id === 'c0')).toBe(false);
    expect(kept.some(c => c.id === `c${MAX_CONVERSATIONS + 2}`)).toBe(true);
    expect(await store.conversations.messages(OWNER_ID, 'c0')).toEqual([]);
  });
});
