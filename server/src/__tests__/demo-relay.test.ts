import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { buildTestApp } from './helpers/app.js';
import { verifyToken } from '../relay/token.js';
import { demoUploads } from '../config.js';

const SECRET = 'demo-relay-secret-demo-relay-secret-12345';

/** SECURITY.md M-39: what a visitor's browser, with no account, is told and given for the demo's uploads. */
describe('the demo’s pass to the relay', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const saved = { ...process.env };

  beforeAll(async () => { app = await buildTestApp({ demoRelay: { tokenPerSource: { max: 3, timeWindow: '1 minute' } } }); });
  afterAll(async () => { await app.close(); });
  afterEach(() => { process.env = { ...saved }; });

  const configure = (demo = 'on') => {
    Object.assign(process.env, {
      SPINE_RELAY_URL: 'https://relay.example.run.app', SPINE_RELAY_SECRET: SECRET, SPINE_LLM_PROVIDER: 'vertex', SPINE_LLM_MODEL: 'gemini-test',
      SPINE_EMBEDDINGS: 'vertex', SPINE_EMBEDDING_MODEL: 'gemini-embedding-2', SPINE_CHAT: 'on', SPINE_PARSER: 'text', SPINE_DEMO_UPLOADS: demo,
    });
  };
  const config = () => app.inject({ method: 'GET', url: '/api/demo-relay/config' });
  const token = (ip = '203.0.113.7') => app.inject({ method: 'POST', url: '/api/demo-relay/token', remoteAddress: ip });

  it('is off unless the operator turns it on, and needs a relay', async () => {
    configure('');
    expect((await config()).statusCode).toBe(404);
    expect((await token()).json().code).toBe('demo_off');
    configure('on');
    delete process.env.SPINE_RELAY_URL;
    expect((await config()).statusCode).toBe(404);
    expect((await token('203.0.113.8')).statusCode).toBe(404);
  });

  it('tells the demo’s core its limits, and to call a model for reading uploads only', async () => {
    configure();
    const res = await config();
    expect(res.statusCode).toBe(200);
    const { env, limits } = res.json();
    expect(limits).toEqual({ uploads: 3, pages: 5 });
    expect(env).toMatchObject({ SPINE_LLM_PROVIDER: 'relay', SPINE_CHAT: 'off', SPINE_TRANSLATION: 'off', SPINE_LINKING: 'off', SPINE_DEMO_MAX_UPLOADS: '3', SPINE_DEMO_MAX_PAGES: '5' });
    expect(Object.keys(env).filter(k => k.startsWith('SPINE_EMBEDDING'))).toEqual([]);
    expect(JSON.stringify(res.json())).not.toContain(SECRET);
  });

  it('gives a pass for the address, which the relay sees only as a keyed hash', async () => {
    configure();
    const first = await token('198.51.100.4');
    expect(first.statusCode).toBe(200);
    const who = verifyToken(SECRET, first.json().token)!;
    expect(who.userId).toMatch(/^demo:[A-Za-z0-9_-]{22}$/);
    expect(who.userId).not.toContain('198.51.100.4');
    // The same address is counted as one, wherever it asks from next; another is counted apart.
    expect(verifyToken(SECRET, (await token('198.51.100.4')).json().token)!.userId).toBe(who.userId);
    expect(verifyToken(SECRET, (await token('198.51.100.5')).json().token)!.userId).not.toBe(who.userId);
  });

  it('limits how often one address is given a pass', async () => {
    configure();
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await token('192.0.2.9')).statusCode);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
  });
});

describe('demoUploads()', () => {
  it('is off by default, and a bad number gives the default', () => {
    expect(demoUploads({})).toBeNull();
    expect(demoUploads({ SPINE_DEMO_UPLOADS: 'yes' })).toBeNull();
    expect(demoUploads({ SPINE_DEMO_UPLOADS: 'ON' })).toEqual({ uploads: 3, pages: 5 });
    expect(demoUploads({ SPINE_DEMO_UPLOADS: 'on', SPINE_DEMO_MAX_UPLOADS: '1', SPINE_DEMO_MAX_PAGES: '2' })).toEqual({ uploads: 1, pages: 2 });
    expect(demoUploads({ SPINE_DEMO_UPLOADS: 'on', SPINE_DEMO_MAX_UPLOADS: '0', SPINE_DEMO_MAX_PAGES: '2.5' })).toEqual({ uploads: 3, pages: 5 });
  });
});
