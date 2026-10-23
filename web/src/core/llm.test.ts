import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRelay } from '../../../server/src/relay/relay';
import { issueToken } from '../../../server/src/relay/token';
import { relayFetch, relayToken, useTokenUrl } from './native/relay-auth';
import { useEmbedderHooks } from '../../../server/src/embedding/index';

/**
 * A model call as the device makes it: the server's own LLM interface, built with the device's Vertex client, going through the real
 * relay code to a stand-in for Google. What reaches "Google" is what the relay sends: its own credential and nothing else of the device's.
 */
const SECRET = 'device-llm-test-secret-device-llm-test';
let relay: Server;
let tokens: Server;
const upstream: Array<{ url: string; headers: Record<string, string>; body: any }> = [];

beforeAll(async () => {
  const handle = createRelay({
    secret: SECRET, targets: [{ model: 'gemini-test', endpoint: 'aiplatform.eu.example', project: 'proj-1', region: 'eu' }, { model: 'gemini-embedding-2', endpoint: 'aiplatform.eu.example', project: 'proj-1', region: 'eu' }],
    allowedOrigin: '*', dailyCalls: 100, maxBodyBytes: 5_000_000, accessToken: async () => 'google-credential',
    fetchImpl: async (url, init) => {
      const body = JSON.parse(String(init?.body));
      upstream.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), body });
      if (String(url).includes(':embedContent')) return new Response(JSON.stringify({ embedding: { values: Array.from({ length: 128 }, (_, i) => i + 1) } }), { status: 200, headers: { 'content-type': 'application/json' } });
      const wantsTool = Array.isArray(body.tools);
      const parts = wantsTool
        ? [{ functionCall: { name: body.tools[0].functionDeclarations[0].name, args: { is_continuation: true, confidence: 0.9, reasoning: 'same table' } } }]
        : [{ text: JSON.stringify({ is_continuation: true, confidence: 0.9, reasoning: 'same table' }) }];
      return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5, totalTokenCount: 10 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  relay = createServer((req, res) => void handle(req, res));
  await new Promise<void>(r => relay.listen(0, '127.0.0.1', r));
  tokens = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); const t = issueToken(SECRET, 'device-user', 600_000); res.end(JSON.stringify({ token: t.token, expires_at: t.expiresAt })); });
  await new Promise<void>(r => tokens.listen(0, '127.0.0.1', r));
  useTokenUrl(`http://127.0.0.1:${(tokens.address() as AddressInfo).port}/api/relay/token`);
  Object.assign(process.env, {
    SPINE_LLM_PROVIDER: 'vertex', SPINE_LLM_ENDPOINT: `127.0.0.1:${(relay.address() as AddressInfo).port}`, SPINE_LLM_REGION: 'eu', SPINE_LLM_PROJECT: 'proj-1',
    SPINE_LLM_MODEL: 'gemini-test', SPINE_EMBEDDINGS: 'vertex', SPINE_EMBEDDING_MODEL: 'gemini-embedding-2', SPINE_EMBEDDING_DIMS: '128',
  });
  useEmbedderHooks({ tokenProvider: relayToken, fetchImpl: relayFetch });
});
afterAll(() => { relay.close(); tokens.close(); });

describe('a model call from the device', () => {
  it('goes through the relay to the provider, which sees the relay’s credential and not the device’s pass', async () => {
    const { getChatLlm } = await import('../../../server/src/llm/index');
    const result = await getChatLlm().detectContinuation('Hemoglobin 13.5', 'g/dL (continued)');
    expect(result.is_continuation).toBe(true);
    expect(upstream).toHaveLength(1);
    expect(upstream[0].url).toContain('https://aiplatform.eu.example/v1/projects/proj-1/locations/eu/publishers/google/models/gemini-test:');
    expect(upstream[0].headers.authorization).toBe('Bearer google-credential');
    expect(JSON.stringify(upstream[0].body)).toContain('Hemoglobin 13.5');
  });

  it('does the same for a search or a summary’s embedding', async () => {
    const { getEmbedder } = await import('../../../server/src/embedding/index');
    const [vector] = await getEmbedder().embed(['Hemoglobin results'], 'document');
    expect(vector).toHaveLength(128);
    const call = upstream[upstream.length - 1];
    expect(call.url).toContain(':embedContent');
    expect(call.headers.authorization).toBe('Bearer google-credential');
  });
});
