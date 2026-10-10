import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { buildTestApp, loginSession } from './helpers/app.js';

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookies: string;
let tmp: string;
let pageId: string;
let missingPageId: string;

// Smallest valid 1x1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AARAADAAEAACAAAAAASUVORK5CYII=',
  'base64',
);

beforeAll(async () => {
  app = await buildTestApp();
  cookies = await loginSession(app);
  tmp = mkdtempSync(path.join(tmpdir(), 'spine-img-'));

  const imagePath = path.join(tmp, 'page-1.png');
  writeFileSync(imagePath, PNG);

  const { seedSourceFile, seedPage } = await import('./helpers/seed.js');
  const sourceFileId = await seedSourceFile({ status: 'done' });

  pageId = await seedPage(sourceFileId, { pageNumber: 1, imagePath });
  missingPageId = await seedPage(sourceFileId, {
    pageNumber: 2,
    imagePath: path.join(tmp, 'does-not-exist.png'),
  });
});

afterAll(async () => {
  await app.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('GET /api/pages/:id/image', () => {
  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/pages/${pageId}/image` });
    expect(res.statusCode).toBe(401);
  });

  it('serves the PNG to an authenticated session', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/pages/${pageId}/image`, headers: { cookie: cookies },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['cache-control']).toContain('private');
    expect(res.rawPayload.equals(PNG)).toBe(true);
  });

  it('returns 404 for an unknown page id', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/pages/${uuidv4()}/image`, headers: { cookie: cookies },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when the row exists but the file is gone', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/pages/${missingPageId}/image`, headers: { cookie: cookies },
    });
    expect(res.statusCode).toBe(404);
  });
});
