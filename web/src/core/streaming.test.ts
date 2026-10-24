import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { LocalApp } from './local-app';

/** The chat's reply is written line by line; the device hands each line on as it is written, and tells the route when the reader leaves. */
describe('a streamed reply on the device', () => {
  const route = (app: LocalApp, onClose: () => void, release: { go: () => void }) =>
    app.post('/api/ask', async (_req, reply) => {
      const out = new PassThrough();
      reply.raw.on('close', onClose);
      out.write('{"type":"step"}\n');
      release.go = () => { out.write('{"type":"done"}\n'); out.end(); };
      return reply.type('application/x-ndjson; charset=utf-8').send(out);
    });

  it('gives the first line before the last is written', async () => {
    const app = new LocalApp();
    const release = { go: () => undefined };
    route(app, () => undefined, release);
    const res = await app.inject({ method: 'POST', url: '/api/ask' });
    expect(res.stream).toBeDefined();
    const decoder = new TextDecoder();
    const seen: string[] = [];
    const reading = (async () => { for await (const chunk of res.stream!) seen.push(decoder.decode(chunk)); })();
    await new Promise(r => setTimeout(r, 20));
    expect(seen.join('')).toBe('{"type":"step"}\n'); // here already, the end not yet written
    release.go();
    await reading;
    expect(seen.join('')).toBe('{"type":"step"}\n{"type":"done"}\n');
  });

  it('tells the route when the reader goes away', async () => {
    const app = new LocalApp();
    let closed = 0;
    route(app, () => { closed += 1; }, { go: () => undefined });
    const res = await app.inject({ method: 'POST', url: '/api/ask' });
    res.close!();
    expect(closed).toBe(1);
  });

  it('leaves an ordinary JSON reply as it was', async () => {
    const app = new LocalApp();
    app.get('/api/x', async () => ({ ok: true }));
    const res = await app.inject({ method: 'GET', url: '/api/x' });
    expect(res.stream).toBeUndefined();
    expect(res.json()).toEqual({ ok: true });
  });
});
