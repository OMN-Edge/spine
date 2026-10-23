import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { buildTestApp, loginSession } from './helpers/app.js';
import { verifyToken } from '../relay/token.js';
import { relayEnv, relaySettings } from '../routes/relay.js';

const SECRET = 'relay-route-secret-relay-route-secret-9876';

describe('what a device is given to call the relay', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let cookie: string;
  const saved = { ...process.env };

  beforeAll(async () => {
    app = await buildTestApp();
    cookie = await loginSession(app);
  });
  afterEach(() => { process.env = { ...saved }; });

  const get = (url: string, signedIn = true) => app.inject({ method: 'GET', url, headers: signedIn ? { cookie } : {} });
  const configure = () => {
    Object.assign(process.env, {
      SPINE_RELAY_URL: 'https://relay.example.run.app', SPINE_RELAY_SECRET: SECRET, SPINE_LLM_PROVIDER: 'vertex',
      SPINE_LLM_ENDPOINT: 'aiplatform.eu.rep.googleapis.com', SPINE_LLM_REGION: 'eu', SPINE_LLM_PROJECT: 'proj-1', SPINE_LLM_MODEL: 'gemini-test',
      SPINE_PARSER: 'text', SESSION_SECRET: 'test-secret-must-be-at-least-32-chars-long!!', ANTHROPIC_API_KEY: 'sk-ant-never-sent',
    });
  };

  it('is for signed-in accounts only', async () => {
    configure();
    expect((await get('/api/relay/config', false)).statusCode).toBe(401);
    expect((await get('/api/relay/token', false)).statusCode).toBe(401);
  });

  it('says so when there is no relay, or the provider is not one it can reach', async () => {
    delete process.env.SPINE_RELAY_URL;
    expect((await get('/api/relay/config')).statusCode).toBe(503);
    expect((await get('/api/relay/token')).statusCode).toBe(503);
    configure();
    process.env.SPINE_LLM_PROVIDER = 'anthropic';
    expect((await get('/api/relay/config')).json().code).toBe('no_relay');
  });

  it('gives the settings the device needs, with the relay as the endpoint, and nothing secret', async () => {
    configure();
    const res = await get('/api/relay/config');
    expect(res.statusCode).toBe(200);
    const body = res.json<{ url: string; env: Record<string, string> }>();
    expect(body.url).toBe('https://relay.example.run.app');
    expect(body.env.SPINE_LLM_PROVIDER).toBe('vertex');
    expect(body.env.SPINE_LLM_ENDPOINT).toBe('relay.example.run.app');
    expect(body.env.SPINE_LLM_PROJECT).toBe('proj-1');
    expect(body.env.SPINE_PARSER).toBe('text');
    const text = res.body;
    for (const secret of [SECRET, 'sk-ant-never-sent', 'test-secret-must-be-at-least']) expect(text).not.toContain(secret);
  });

  it('gives a pass the relay accepts, for this account, that runs out', async () => {
    configure();
    const res = (await get('/api/relay/token')).json<{ token: string; expires_at: number }>();
    expect(verifyToken(SECRET, res.token)).toEqual({ userId: 'user-owner' });
    expect(res.expires_at - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);
    expect(verifyToken(SECRET, res.token, res.expires_at + 1)).toBeNull();
  });

  it('accepts an address only when it is https (or this machine, for trying it)', () => {
    expect(relaySettings({ SPINE_RELAY_URL: 'http://relay.example', SPINE_RELAY_SECRET: SECRET })).toBeNull();
    expect(relaySettings({ SPINE_RELAY_URL: 'http://localhost:8080', SPINE_RELAY_SECRET: SECRET })).not.toBeNull();
    expect(relaySettings({ SPINE_RELAY_URL: 'https://relay.example', SPINE_RELAY_SECRET: 'short' })).toBeNull();
    expect(relayEnv({ url: 'https://relay.example', secret: SECRET }, { SPINE_EMBEDDINGS: 'vertex' }).SPINE_EMBEDDING_ENDPOINT).toBe('relay.example');
  });
});
