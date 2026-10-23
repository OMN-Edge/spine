import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { createRelay } from '../relay/relay.js';
import { issueToken, verifyToken } from '../relay/token.js';

const SECRET = 'relay-test-secret-relay-test-secret-0123';
const MODEL = 'gemini-test-flash';
const PATH = `/v1/projects/proj-1/locations/eu/publishers/google/models/${MODEL}:generateContent`;

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
  let seen: Array<{ url: string; headers: Record<string, string>; body: string }>;
  let logs: Array<Record<string, unknown>>;
  let clock = Date.UTC(2026, 9, 23, 12);
  const mint = (user = 'user-1') => issueToken(SECRET, user, 600_000, clock).token;

  beforeEach(async () => {
    seen = [];
    logs = [];
    const fake: typeof fetch = async (url, init) => {
      seen.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body) });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'an answer' }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const handle = createRelay({
      secret: SECRET, targets: [{ model: MODEL, endpoint: 'aiplatform.eu.example', project: 'proj-1', region: 'eu' }, { model: 'embed-test', endpoint: 'aiplatform.eu2.example', project: 'proj-1', region: 'eu' }], allowedOrigin: 'https://app.example',
      dailyCalls: 2, maxBodyBytes: 1000, accessToken: async () => 'google-token', fetchImpl: fake, log: l => logs.push(l), now: () => clock,
    });
    server = createServer((req, res) => void handle(req, res));
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>(r => server.close(() => r())));

  const post = (path: string, body: string, token: string | null = mint(), extra: Record<string, string> = {}) =>
    fetch(base + path, { method: 'POST', body, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra } });

  it('forwards a call with its own credential and nothing of the device’s', async () => {
    const res = await post(PATH, '{"contents":[]}', mint(), { cookie: 'session=secret', 'x-forwarded-for': '203.0.113.9' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ candidates: [{ content: { parts: [{ text: 'an answer' }] } }] });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`https://aiplatform.eu.example${PATH}`);
    expect(seen[0].headers.authorization).toBe('Bearer google-token');
    expect(Object.keys(seen[0].headers).sort()).toEqual(['authorization', 'content-type']);
    expect(seen[0].body).toBe('{"contents":[]}');
  });

  it('refuses without a valid pass, and anything it was not set up to forward', async () => {
    expect((await post(PATH, '{}', null)).status).toBe(401);
    expect((await post(PATH, '{}', 'forged.token.here')).status).toBe(401);
    expect((await post(PATH.replace(MODEL, 'another-model'), '{}')).status).toBe(404);
    expect((await post(PATH.replace('proj-1', 'other-project'), '{}')).status).toBe(404);
    expect((await post(PATH.replace(':generateContent', ':tuningJobs'), '{}')).status).toBe(404);
    expect((await post(`${PATH}?key=abc`, '{}')).status).toBe(400);
    expect((await fetch(base + PATH, { method: 'GET', headers: { authorization: `Bearer ${mint()}` } })).status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it('counts each user’s calls apart, and starts again the next day', async () => {
    expect((await post(PATH, '{}', mint('a'))).status).toBe(200);
    expect((await post(PATH, '{}', mint('a'))).status).toBe(200);
    expect((await post(PATH, '{}', mint('a'))).status).toBe(429);
    expect((await post(PATH, '{}', mint('b'))).status).toBe(200);
    clock += 24 * 60 * 60 * 1000;
    expect((await post(PATH, '{}', mint('a'))).status).toBe(200);
  });

  it('sends each model to the host stated for it', async () => {
    await post(PATH.replace(MODEL, 'embed-test').replace('generateContent', 'embedContent'), '{}');
    expect(seen[0].url).toBe('https://aiplatform.eu2.example/v1/projects/proj-1/locations/eu/publishers/google/models/embed-test:embedContent');
  });

  it('refuses a body over the limit before sending it anywhere', async () => {
    expect((await post(PATH, 'x'.repeat(1001))).status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it('answers the browser’s check and tells it which address may call', async () => {
    const res = await fetch(base + PATH, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  it('writes down the model, the status and the sizes, and none of the content', async () => {
    await post(PATH, '{"contents":[{"parts":[{"text":"Hemoglobin 13.5 for Jane Example"}]}]}');
    expect(logs).toHaveLength(1);
    expect(Object.keys(logs[0]).sort()).toEqual(['bytes_in', 'method', 'model', 'ms', 'status']);
    expect(JSON.stringify(logs)).not.toMatch(/Hemoglobin|Jane/);
  });

  it('has nothing to store with: no files, no database, no log of bodies', () => {
    const source = readFileSync(new URL('../relay/relay.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map(m => m[1]);
    expect(imports.sort()).toEqual(['./token.js', 'node:http', 'node:stream']);
  });
});
