import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, loginSession } from './helpers/app.js';
import { seedShareLink, storedTokenFor } from './helpers/seed.js';
import { getAccountsStore } from 'spine-core/store/index.js';
import {
  createShareToken,
  hashShareToken,
  looksLikeRawToken,
  looksLikeTokenDigest,
} from 'spine-core/share-token.js';

/**
 * P6 / S-4: possession of the database must not confer the ability to use the
 * share links described in it.
 */

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;

beforeAll(async () => {
  app = await buildTestApp();
  cookie = await loginSession(app);
});
afterAll(async () => { await app.close(); });

/**
 * A link row as a pre-S-4 build left it: the raw token in the column. Written
 * through the interface, which accepts any string here precisely so the rewrite has
 * something to find.
 */
async function storedToken(id: string): Promise<string> {
  const token = await storedTokenFor(id);
  if (token === undefined) throw new Error(`share_link ${id} not found`);
  return token;
}

describe('share token shapes', () => {
  it('issues 43 base64url characters — 256 bits', () => {
    const token = createShareToken();
    expect(token).toHaveLength(43);
    expect(looksLikeRawToken(token)).toBe(true);
    expect(looksLikeTokenDigest(token)).toBe(false);
  });

  it('digests are 64 hex characters, and the two shapes never collide', () => {
    const digest = hashShareToken(createShareToken());
    expect(digest).toHaveLength(64);
    expect(looksLikeTokenDigest(digest)).toBe(true);
    expect(looksLikeRawToken(digest)).toBe(false);
  });
});

describe('POST /api/share-links — the token is hashed at rest', () => {
  it('stores a digest, never the token it returned', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/share-links',
      headers: { cookie },
      payload: { scope: 'all', expires_days: 7 },
    });
    expect(res.statusCode).toBe(201);
    const { id, token } = res.json() as { id: string; token: string };

    const stored = await storedToken(id);
    expect(stored).not.toBe(token);
    expect(stored).toBe(hashShareToken(token));
    expect(looksLikeTokenDigest(stored)).toBe(true);
  });

  it('no row in the table holds anything token-shaped', async () => {
    await app.inject({
      method: 'POST', url: '/api/share-links',
      headers: { cookie }, payload: { scope: 'all' },
    });

    const rows = await getAccountsStore().maintenance.listShareLinkTokens();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(looksLikeRawToken(row.token)).toBe(false);
  });

  it('the returned token still opens the link', async () => {
    const create = await app.inject({
      method: 'POST', url: '/api/share-links',
      headers: { cookie }, payload: { scope: 'all' },
    });
    const { token } = create.json() as { token: string };

    expect((await app.inject({ method: 'GET', url: `/api/share/${token}/documents` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/share/${token}` })).statusCode).toBe(200);
  });

  it('a digest read out of the database does not work as a token', async () => {
    const create = await app.inject({
      method: 'POST', url: '/api/share-links',
      headers: { cookie }, payload: { scope: 'all' },
    });
    const { id, token } = create.json() as { id: string; token: string };
    const stolen = await storedToken(id);

    // This is the whole point of S-4: an attacker with spine.db holds this
    // string and it is not a usable link.
    expect(stolen).not.toBe(token);
    expect((await app.inject({ method: 'GET', url: `/api/share/${stolen}/documents` })).statusCode).toBe(410);
    expect((await app.inject({ method: 'GET', url: `/share/${stolen}` })).statusCode).toBe(410);
  });
});
