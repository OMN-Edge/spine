import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { buildTestApp, loginSession } from './helpers/app.js';
import { shareShellRoutes } from '../routes/shared.js';

/** The address a recipient is given is answered by the server with the app shell, and by nothing that reads a record (stage 5). */
describe('GET /share/:id (server)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'spine-shell-'));
  const shell = path.join(dir, 'index.html');
  let owner: string;
  let seed: Awaited<ReturnType<typeof buildTestApp>>;
  let shellApp: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    process.env.DATA_DIR = dir;
    writeFileSync(shell, '<!doctype html><title>Spine shell</title>');
    seed = await buildTestApp();
    owner = await loginSession(seed);
    shellApp = Fastify();
    await shellApp.register(shareShellRoutes, { appShellPath: shell });
  });
  afterAll(async () => { await seed.close(); await shellApp.close(); rmSync(dir, { recursive: true, force: true }); });

  it('serves the app for a share that exists, and a plain page for one that does not', async () => {
    const id = randomBytes(16).toString('base64url');
    const put = await seed.inject({
      method: 'PUT', url: `/api/shared/${id}`, payload: randomBytes(100),
      headers: { cookie: owner, 'content-type': 'application/octet-stream', 'x-spine-expires': new Date(Date.now() + 3_600_000).toISOString() },
    });
    expect(put.statusCode).toBe(201);

    const found = await shellApp.inject({ method: 'GET', url: `/share/${id}` });
    expect(found.statusCode).toBe(200);
    expect(found.body).toContain('Spine shell');

    const unknown = await shellApp.inject({ method: 'GET', url: `/share/${randomBytes(16).toString('base64url')}` });
    expect(unknown.statusCode).toBe(410);
    expect(unknown.body).not.toContain('Spine shell');
    expect((await shellApp.inject({ method: 'GET', url: '/share/short' })).statusCode).toBe(410);
  });
});
