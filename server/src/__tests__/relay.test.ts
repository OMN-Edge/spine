import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from 'spine-core/store/sqlite/connection.js';
import { openNative } from 'spine-core/testing/driver-native.js';
import { usageRepository } from 'spine-core/store/sqlite/usage.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { HumanMessage, mapChatMessagesToStoredMessages } from '@langchain/core/messages';
import { LlmBlockedError } from 'spine-core/llm/types.js';
import { standInClients, type StandInCall } from '../testing/stand-in.js';
import type { TaskClients } from 'spine-core/llm/tasks.js';
import { createRelay } from '../relay/relay.js';
import { issueToken, verifyToken } from '../relay/token.js';

const SECRET = 'relay-test-secret-relay-test-secret-0123';
const MODEL = 'gemini-test-flash';
const TASK = '/v1/task/continuation';

describe('the relay pass', () => {
  it('is valid for its user until it runs out, and for no one else', () => {
    const { token } = issueToken(SECRET, 'user-1', 60_000, 1_000_000);
    expect(verifyToken(SECRET, token, 1_000_000 + 30_000)).toEqual({ userId: 'user-1' });
    expect(verifyToken(SECRET, token, 1_000_000 + 61_000)).toBeNull();
    expect(verifyToken('another-secret-another-secret-another-secret', token, 1_000_000)).toBeNull();
    const [h, , s] = token.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ sub: 'user-2', exp: 9_999_999_999 })).toString('base64url')}.${s}`;
    expect(verifyToken(SECRET, forged)).toBeNull();
    expect(verifyToken(SECRET, 'not.a.token')).toBeNull();
    expect(() => issueToken('short', 'u', 1000)).toThrow();
  });
});

describe('the relay', () => {
  let server: Server;
  let base = '';
  let calls: StandInCall[];
  let logs: Array<Record<string, unknown>>;
  let limit = 100;
  let sharedLimit = 100;
  let demoLimit = 100;
  let demoTotal = 100;
  let clock = Date.UTC(2026, 9, 23, 12);
  const mint = (user = 'user-1') => issueToken(SECRET, user, 600_000, clock).token;
  const messages = (text: string) => mapChatMessagesToStoredMessages([new HumanMessage(text)]);

  beforeEach(async () => {
    logs = [];
    limit = 100;
    sharedLimit = 100;
    demoLimit = 100;
    demoTotal = 100;
    const stand = standInClients({ continuation: { is_continuation: true, confidence: 0.9, reasoning: 'same table' } });
    calls = stand.calls;
    const clients: TaskClients = { ...stand.clients, translation: { invoke: async () => { throw new LlmBlockedError('Prompt blocked: SAFETY'); } } as never };
    const handle = createRelay({
      secret: SECRET, allowedOrigin: 'https://app.example', get dailyCalls() { return limit; }, get dailySharedCalls() { return sharedLimit; }, get dailyDemoCalls() { return demoLimit; }, get dailyDemoTotalCalls() { return demoTotal; }, maxBodyBytes: 2000, usage: usageRepository(openDatabase(':memory:', openNative, undefined, 'accounts')),
      clients: model => (model === undefined || model === MODEL ? clients : null),
      embedder: () => ({ enabled: true, id: 'test:3', dims: 3, embed: async texts => texts.map(() => Float32Array.from([1, 0, 0])) }),
      log: l => logs.push(l), now: () => clock,
    });
    server = createServer((req, res) => void handle(req, res));
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>(r => server.close(() => r())));

  const post = (path: string, body: unknown, token: string | null = mint(), extra: Record<string, string> = {}) =>
    fetch(base + path, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra } });

  it('runs a task through the relay’s own model and answers the parsed result', async () => {
    const res = await post(TASK, { model: MODEL, messages: messages('Hemoglobin 13.5') }, mint(), { cookie: 'session=secret' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { is_continuation: true, confidence: 0.9, reasoning: 'same table' } });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0].messages)).toContain('Hemoglobin 13.5');
  });

  it('gives the agent the tools the device names as declarations and hands back what the model asked for', async () => {
    const tool = { type: 'function', function: { name: 'find_documents', description: 'finds', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } };
    const res = await post('/v1/task/agent', { messages: messages('what do I have?'), tools: [tool] });
    const { message } = (await res.json()) as { message: { type: string; data: { tool_calls: Array<{ name: string; args: unknown }> } } };
    expect(message.type).toBe('ai');
    expect(message.data.tool_calls[0]).toMatchObject({ name: 'find_documents', args: { query: 'sample' } });
  });

  it('streams the agent’s reply one line a piece', async () => {
    const res = await post('/v1/task/agent', { messages: messages('hello'), stream: true });
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const lines = (await res.text()).trim().split('\n').map(l => JSON.parse(l));
    expect(lines.map(l => l.chunk?.content).join('')).toBe('A sample answer.');
  });

  it('says a refusal by the model as a refusal, without the provider’s words', async () => {
    const res = await post('/v1/task/translation', { messages: messages('x') });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'the model refused these words', code: 'blocked' });
  });

  it('embeds texts and says which vector space they are in', async () => {
    const res = await post('/v1/embed', { texts: ['a', 'b'], kind: 'document' });
    expect(await res.json()).toEqual({ vectors: [[1, 0, 0], [1, 0, 0]], id: 'test:3' });
  });

  it('refuses without a valid pass, and anything it was not set up to run', async () => {
    expect((await post(TASK, { messages: messages('x') }, null)).status).toBe(401);
    expect((await post(TASK, { messages: messages('x') }, 'forged.token.here')).status).toBe(401);
    expect((await post('/v1/task/notatask', { messages: messages('x') })).status).toBe(404);
    expect((await post('/v1/projects/p/locations/eu/publishers/google/models/m:generateContent', {})).status).toBe(404);
    expect((await post(`${TASK}?key=abc`, { messages: messages('x') })).status).toBe(400);
    expect((await fetch(base + TASK, { method: 'GET', headers: { authorization: `Bearer ${mint()}` } })).status).toBe(404);
    expect((await post(TASK, { model: 'another-model', messages: messages('x') })).status).toBe(400);
    expect((await post(TASK, { messages: [{ type: 'function', data: { content: 'x' } }] })).status).toBe(400);
    expect((await post(TASK, 'not json')).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('counts the demo per address and for every address together, apart from accounts and shares (M-39)', async () => {
    limit = 5;
    demoLimit = 2;
    demoTotal = 3;
    const call = (subject: string) => post(TASK, { messages: messages('x') }, mint(subject));
    expect((await call('demo:addressA')).status).toBe(200);
    expect((await call('demo:addressA')).status).toBe(200);
    // This address has had its day.
    expect((await call('demo:addressA')).status).toBe(429);
    // Another address has its own, until all of them together have had the instance's.
    expect((await call('demo:addressB')).status).toBe(200);
    expect((await call('demo:addressB')).status).toBe(429);
    expect((await call('demo:addressC')).status).toBe(429);
    expect(calls).toHaveLength(3);
    // Accounts and shares are not touched by it.
    expect((await call('user-1')).status).toBe(200);
    expect((await call('share:s1')).status).toBe(200);
    // And it starts again the next day.
    clock += 24 * 60 * 60 * 1000;
    expect((await call('demo:addressC')).status).toBe(200);
  });

  it('allows no demo call at all with a count of 0', async () => {
    demoLimit = 0;
    expect((await post(TASK, { messages: messages('x') }, mint('demo:addressA'))).status).toBe(429);
    demoLimit = 5;
    demoTotal = 0;
    expect((await post(TASK, { messages: messages('x') }, mint('demo:addressA'))).status).toBe(429);
    expect(calls).toHaveLength(0);
  });

  it('gives a share its own, smaller allowance, apart from every account', async () => {
    limit = 5;
    sharedLimit = 1;
    const call = (subject: string) => post(TASK, { messages: messages('x') }, mint(subject));
    expect((await call('share:s1')).status).toBe(200);
    expect((await call('share:s1')).status).toBe(429);
    expect((await call('share:s2')).status).toBe(200);
    expect((await call('a')).status).toBe(200);
    expect((await call('a')).status).toBe(200);
  });

  it('counts each user’s calls apart, and starts again the next day', async () => {
    limit = 2;
    const call = (user: string) => post(TASK, { messages: messages('x') }, mint(user));
    expect((await call('a')).status).toBe(200);
    expect((await call('a')).status).toBe(200);
    expect((await call('a')).status).toBe(429);
    expect((await call('b')).status).toBe(200);
    clock += 24 * 60 * 60 * 1000;
    expect((await call('a')).status).toBe(200);
  });

  it('refuses a body over the limit before running anything', async () => {
    expect((await post(TASK, 'x'.repeat(2001))).status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it('answers the browser’s check and tells it which address may call', async () => {
    const res = await fetch(base + TASK, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  it('writes down the task, the model, the status and the sizes, and none of the content', async () => {
    await post(TASK, { model: MODEL, messages: messages('Hemoglobin 13.5 for Jane Example') });
    expect(logs).toHaveLength(1);
    expect(Object.keys(logs[0]).sort()).toEqual(['bytes_in', 'model', 'ms', 'status', 'task']);
    expect(JSON.stringify(logs)).not.toMatch(/Hemoglobin|Jane/);
  });

  it('stores nothing but a count: no files, no repository but `usage` (a number a day), no log of bodies', () => {
    const source = readFileSync(new URL('../relay/relay.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map(m => m[1]);
    expect(imports.sort()).toEqual(['./token.js', '@langchain/core/language_models/chat_models', '@langchain/core/messages', 'node:http', 'spine-core/embedding/types.js', 'spine-core/llm/tasks.js', 'spine-core/llm/types.js', 'spine-core/relay/protocol.js', 'spine-core/store/types.js']);
    expect(source).toContain("import type { UsageRepository } from 'spine-core/store/types.js'"); // a type only: the relay is given the repository, it opens no store
  });
});
