import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getAccountsStore } from 'spine-core/store/index.js';
import { fakeVaultKeys } from 'spine-core/testing/vault.js';
import { runCli, type CliIo } from '../cli.js';
import { buildTestApp } from './helpers/app.js';
import { createTestUser } from './helpers/seed.js';

/** `npm run cli -- legacy`: what is left of the paths kept for things made before the review's fixes, counted, so the strict release is deployed when it is 0. */
const cli = () => {
  const out: string[] = [];
  const io: CliIo = { out: l => out.push(l), err: l => out.push(l), readPassword: async () => '' };
  return runCli(['legacy'], io).then(code => ({ code, out: out.join('\n') }));
};
const check = (a: string) => a.repeat(43).slice(0, 43);

describe('the report of what is left of the paths for older things', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let userId = '';
  beforeAll(async () => {
    app = await buildTestApp();
    userId = (await createTestUser('legacy@spine.test', { id: 'user-legacy-report' })).id;
  });
  afterAll(async () => { await app.close(); });

  const store = () => getAccountsStore();
  const soon = () => new Date(Date.now() + 3_600_000).toISOString();

  it('counts each old thing, says how it goes, and exits 1 while any is left', async () => {
    const keys = fakeVaultKeys();
    await store().vault.putKeys(userId, { ...keys, kdf_params: JSON.stringify(keys.kdf_params) }, new Date().toISOString());
    await store().shared.put(userId, { id: 'share-legacy-aaaaaaaaaaaaaaaa', expiresAt: soon(), requireApproval: false, size: 1, blobs: 0, blobBytes: 0 }, new Date().toISOString());
    await store().shared.put(userId, { id: 'card-legacy-aaaaaaaaaaaaaaaaaa', expiresAt: '9999-12-31T00:00:00.000Z', requireApproval: false, size: 1, blobs: 0, blobBytes: 0, kind: 'card' }, new Date().toISOString());
    await store().delegations.invite(userId, { id: check('i'), profileId: 'profile-legacy-0001', role: 'viewer', wrapped: 'w'.repeat(100), proofHash: 'a'.repeat(64), now: new Date().toISOString(), expiresAt: soon() });
    const { code, out } = await cli();
    expect(code).toBe(1);
    expect(out).toMatch(/1\tlive share links with no key check/);
    expect(out).toMatch(/1\tlive emergency cards with no key check/);
    expect(out).toMatch(/1\tvaults with no reset verifier/);
    expect(out).toMatch(/1\tinvitations waiting with no binding/);
    expect(out).toMatch(/recovery codes made before they were stored slowly: cannot be counted/);
    expect(out).toMatch(/not yet/);
  });

  it('exits 0 and says the strict release can go out when none is left', async () => {
    await store().shared.put(userId, { id: 'share-legacy-aaaaaaaaaaaaaaaa', expiresAt: soon(), requireApproval: false, size: 1, blobs: 0, blobBytes: 0, passCheck: check('c') }, new Date().toISOString());
    await store().shared.put(userId, { id: 'card-legacy-aaaaaaaaaaaaaaaaaa', expiresAt: '9999-12-31T00:00:00.000Z', requireApproval: false, size: 1, blobs: 0, blobBytes: 0, kind: 'card', passCheck: check('d') }, new Date().toISOString());
    // a vault with a verifier is made with one: the strict release has no way to add one afterwards
    await store().vault.erase(userId);
    const keys = fakeVaultKeys();
    await store().vault.putKeys(userId, { ...keys, kdf_params: JSON.stringify(keys.kdf_params), reset_verifier: check('v') }, new Date().toISOString());
    await store().delegations.cancelInvite(userId, check('i'));
    const { code, out } = await cli();
    expect(out).toMatch(/nothing counted is left/);
    expect(code).toBe(0);
  });
});
