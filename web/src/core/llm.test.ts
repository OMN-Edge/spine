import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRelay } from '../../../server/src/relay/relay';
import { issueToken } from '../../../server/src/relay/token';
import { relayFetch, relayToken, useTokenUrl } from './native/relay-auth';
import { useRelayHooks } from '../../../server/src/llm/adapters/relay';
import { standInClients } from '../../../server/src/relay/stand-in';

/**
 * A model call as the device makes it: the server's own LLM interface, built with the relay client, going through the real relay code to a
 * stand-in model. What the relay runs is what the device sent, as messages, and nothing of the device's pass or cookies.
 */
const SECRET = 'device-llm-test-secret-device-llm-test';
let relay: Server;
let tokens: Server;
const stand = standInClients({ continuation: { is_continuation: true, confidence: 0.9, reasoning: 'same table' } });

beforeAll(async () => {
  const handle = createRelay({
    secret: SECRET, allowedOrigin: '*', dailyCalls: 100, usage: { spend: async () => 1 }, maxBodyBytes: 5_000_000,
    clients: model => (model === undefined || model === 'any-model' ? stand.clients : null),
    embedder: () => ({ enabled: true, id: 'vertex:gemini-embedding-2:128', dims: 128, embed: async texts => texts.map(() => Float32Array.from({ length: 128 }, (_, i) => (i + 1) / 128)) }),
  });
  relay = createServer((req, res) => void handle(req, res));
  await new Promise<void>(r => relay.listen(0, '127.0.0.1', r));
  tokens = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); const t = issueToken(SECRET, 'device-user', 600_000); res.end(JSON.stringify({ token: t.token, expires_at: t.expiresAt })); });
  await new Promise<void>(r => tokens.listen(0, '127.0.0.1', r));
  useTokenUrl(`http://127.0.0.1:${(tokens.address() as AddressInfo).port}/api/relay/token`);
  const host = `127.0.0.1:${(relay.address() as AddressInfo).port}`;
  Object.assign(process.env, {
    SPINE_LLM_PROVIDER: 'relay', SPINE_LLM_ENDPOINT: host, SPINE_LLM_MODEL: 'any-model',
    SPINE_EMBEDDINGS: 'relay', SPINE_EMBEDDING_ENDPOINT: host, SPINE_EMBEDDING_MODEL: 'gemini-embedding-2', SPINE_EMBEDDING_DIMS: '128', SPINE_EMBEDDING_SPACE: 'vertex:gemini-embedding-2:128',
  });
  useRelayHooks({ tokenProvider: relayToken, fetchImpl: relayFetch });
});
afterAll(() => { relay.close(); tokens.close(); });

describe('a model call from the device', () => {
  it('goes through the relay, which runs the task and answers the parsed result', async () => {
    const { getChatLlm } = await import('../../../server/src/llm/index');
    const result = await getChatLlm().detectContinuation('Hemoglobin 13.5', 'g/dL (continued)');
    expect(result.is_continuation).toBe(true);
    expect(stand.calls).toHaveLength(1);
    expect(stand.calls[0].task).toBe('continuation');
    expect(JSON.stringify(stand.calls[0].messages)).toContain('Hemoglobin 13.5');
  });

  it('gives the agent’s model the tools the graph binds and gets its tool call back', async () => {
    const { getChatLlm } = await import('../../../server/src/llm/index');
    const bound = (getChatLlm().agentModel() as unknown as { bindTools(t: unknown[]): { invoke(m: unknown[]): Promise<{ tool_calls: Array<{ name: string }> }> } }).bindTools([
      { type: 'function', function: { name: 'find_documents', description: 'finds', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
    ]);
    const reply = await bound.invoke([['human', 'what do I have?']]);
    expect(reply.tool_calls[0].name).toBe('find_documents');
  });

  it('does the same for a search or a summary’s embedding, in the vector space it had before', async () => {
    const { getEmbedder } = await import('../../../server/src/embedding/index');
    const embedder = getEmbedder();
    expect(embedder.id).toBe('vertex:gemini-embedding-2:128');
    const [vector] = await embedder.embed(['Hemoglobin results'], 'document');
    expect(vector).toHaveLength(128);
  });
});
