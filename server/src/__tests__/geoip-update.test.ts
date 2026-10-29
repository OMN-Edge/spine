import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { updateGeoip } from '../geoip-update.js';

let server: Server;
let base: string;
let answer: { status: number; body: Buffer };
let dir: string;
let file: string;

beforeAll(async () => {
  server = createServer((_req, res) => { res.writeHead(answer.status); res.end(answer.body); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/country.mmdb`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-geoip-'));
  file = path.join(dir, 'geoip', 'country.mmdb');
  answer = { status: 200, body: Buffer.alloc(1_500_000, 7) };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const accept = async () => {};
const leftovers = () => fs.existsSync(path.dirname(file)) ? fs.readdirSync(path.dirname(file)).filter(f => f.endsWith('.part')) : [];

describe('updateGeoip', () => {
  it('writes the downloaded file where it is read, making the folder, and leaves no partial file', async () => {
    expect(await updateGeoip({ url: base, file, check: accept })).toBe(1_500_000);
    expect(fs.readFileSync(file).equals(answer.body)).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it('replaces the file it had', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'old');
    await updateGeoip({ url: base, file, check: accept });
    expect(fs.statSync(file).size).toBe(1_500_000);
  });

  it('keeps the file it had when the new one fails its check', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'old');
    await expect(updateGeoip({ url: base, file, check: async () => { throw new Error('no country'); } })).rejects.toThrow('no country');
    expect(fs.readFileSync(file, 'utf8')).toBe('old');
    expect(leftovers()).toEqual([]);
  });

  it('refuses something that is not a country database, by the check it runs itself', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'old');
    await expect(updateGeoip({ url: base, file })).rejects.toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('old');
    expect(leftovers()).toEqual([]);
  });

  it('refuses an answer that is not a success, or is far too small', async () => {
    answer = { status: 404, body: Buffer.from('not found') };
    await expect(updateGeoip({ url: base, file, check: accept })).rejects.toThrow('404');
    answer = { status: 200, body: Buffer.from('tiny') };
    await expect(updateGeoip({ url: base, file, check: accept })).rejects.toThrow('smaller than expected');
    expect(fs.existsSync(file)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('downloads only over https, or from this machine', async () => {
    for (const url of ['http://example.com/c.mmdb', 'ftp://example.com/c.mmdb', 'file:///etc/passwd', 'nonsense']) {
      await expect(updateGeoip({ url, file, check: accept }), url).rejects.toThrow('https');
    }
  });
});
