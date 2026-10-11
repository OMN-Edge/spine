import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, loginSession } from './helpers/app.js';
import { seedDocument, seedPage, seedShareLink, seedSourceFile, OWNER_ID } from './helpers/seed.js';
import { getStore } from '../store/index.js';
import { hashShareToken } from '../share-token.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * S-8: a response carries what the client needs and nothing about how the server
 * is laid out or who owns what internally. Whole responses are scanned, not
 * spot-checked, so a new column added to a table does not leak by default.
 */

const FORBIDDEN_KEYS = [
  'user_id', 'file_path', 'image_path', 'checksum', 'password_hash', 'auth_version', 'token',
  // The second factor's rows (M-12): the encrypted secret, the replay marker, the code hashes.
  'secret_enc', 'last_step', 'code_hash',
];

function leaks(value: unknown, trail = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => leaks(v, `${trail}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, v]) => [
      ...(FORBIDDEN_KEYS.includes(key) ? [`${trail}.${key}`] : []),
      ...leaks(v, `${trail}.${key}`),
    ]);
  }
  // An absolute server path in a value, whatever the key is called.
  if (typeof value === 'string' && /^\/(tmp|home|var|Users|private)\//.test(value)) {
    return [`${trail} = ${value}`];
  }
  return [];
}

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
let docId: string;

beforeAll(async () => {
  app = await buildTestApp();
  cookie = await loginSession(app);

  const sf = await seedSourceFile({ status: 'done' });
  const pageId = await seedPage(sf, { imagePath: '/tmp/some/absolute/page.png' });
  const doc = await seedDocument({ sourceFileId: sf, withPage: false, tags: ['lab'], aiSummary: 'summary' });
  docId = doc.id;
  await getStore().fields.create(OWNER_ID, {
    id: uuidv4(), documentId: docId, pageId, label: 'dx', value: 'v',
    sourceSnippet: 's', bbox: { x0: 0, y0: 0, x1: 1, y1: 1 }, confidence: 0.5,
  });
  await seedShareLink({ tokenHash: hashShareToken('shape-token') });
});

afterAll(async () => { await app.close(); });

describe('responses carry no internal columns or server paths (S-8)', () => {
  const owned: Array<[string, () => string]> = [
    ['GET /api/documents', () => '/api/documents'],
    ['GET /api/documents/:id (fields, pages, tags)', () => `/api/documents/${docId}`],
    ['GET /api/source-files', () => '/api/source-files'],
    ['GET /api/share-links', () => '/api/share-links'],
    ['GET /api/tags', () => '/api/tags'],
  ];

  for (const [name, url] of owned) {
    it(name, async () => {
      const res = await app.inject({ method: 'GET', url: url(), headers: { cookie } });
      expect(res.statusCode).toBe(200);
      expect(leaks(res.json())).toEqual([]);
    });
  }

  it('GET /api/share/:token/documents — what a share recipient receives', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/share/shape-token/documents' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as unknown[]).length).toBeGreaterThan(0);
    expect(leaks(res.json())).toEqual([]);
  });

  it('the scanner itself catches a leak', () => {
    expect(leaks({ a: [{ user_id: 'x' }] })).toEqual(['$.a[0].user_id']);
    expect(leaks({ where: '/Users/someone/spine/data/x.pdf' })).toHaveLength(1);
    expect(leaks({ id: 'abc', name: 'fine' })).toEqual([]);
  });
});

describe('the second factor’s reads (M-12)', () => {
  it('never carry the secret, its ciphertext or the code hashes', async () => {
    const store = getStore();
    await store.users.beginTotp(OWNER_ID, 'v1.ciphertext-that-must-not-appear', new Date().toISOString());
    await store.users.enableTotp(OWNER_ID, 5, ['hash-that-must-not-appear'], new Date().toISOString());

    for (const [url, cookieHeader] of [['/api/auth/me', cookie], ['/api/auth/totp', cookie]] as const) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie: cookieHeader } });
      expect(leaks(res.json()), url).toEqual([]);
      expect(res.body).not.toContain('must-not-appear');
    }
    await store.users.disableTotp(OWNER_ID);
  });
});
