import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { pointerRoutes, repoBase } from '../routes/pointers.js';

describe('/source, /docs and /security', () => {
  const before = process.env.SPINE_REPO_URL;
  afterEach(() => {
    if (before === undefined) delete process.env.SPINE_REPO_URL; else process.env.SPINE_REPO_URL = before;
  });

  async function get(path: string) {
    const app = Fastify();
    await app.register(pointerRoutes);
    const res = await app.inject({ url: path });
    await app.close();
    return res;
  }

  it('redirect to the repository named in SPINE_REPO_URL, where nginx is not there to do it', async () => {
    process.env.SPINE_REPO_URL = 'https://git.example.org/me/spine/';
    expect((await get('/source')).headers.location).toBe('https://git.example.org/me/spine');
    expect((await get('/docs')).headers.location).toBe('https://git.example.org/me/spine/tree/main/docs');
    const security = await get('/security');
    expect(security.statusCode).toBe(302);
    expect(security.headers.location).toBe('https://git.example.org/me/spine/blob/main/SECURITY.md');
  });

  it('are left out with no address, and with one that is not http(s)', async () => {
    delete process.env.SPINE_REPO_URL;
    expect((await get('/security')).statusCode).toBe(404);
    process.env.SPINE_REPO_URL = 'javascript:alert(1)';
    expect((await get('/security')).statusCode).toBe(404);
    expect(repoBase('not a url')).toBeNull();
  });
});
