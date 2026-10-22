import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { buildTestApp, loginAs } from './helpers/app.js';
import { createTestUser, seedDocument, TEST_PASSWORD } from './helpers/seed.js';
import { getStore } from '../store/index.js';
import { HEALTH_CONSENT_VERSION, TERMS_VERSION, legalText } from '../legal.js';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let app: Awaited<ReturnType<typeof buildTestApp>>;
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spine-account-'));
  process.env.DATA_DIR = dir;
  app = await buildTestApp();
});
afterEach(() => { vi.useRealTimers(); });
afterAll(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

const call = (method: 'GET' | 'POST', url: string, cookie?: string, payload?: unknown) =>
  app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload === undefined ? {} : { payload: payload as object }) });

/** An account the operator made: it has not agreed to anything yet. */
async function newcomer(email = 'newcomer@spine.test') {
  const u = await createTestUser(email, { consent: false });
  return { ...u, cookie: await loginAs(app, u.email, u.password) };
}

describe('the texts a person agrees to', () => {
  it('are public, carry a version, and have the operator filled in', async () => {
    for (const doc of ['privacy', 'terms', 'purpose']) {
      const res = await call('GET', `/api/legal/${doc}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ doc, version: doc === 'terms' ? TERMS_VERSION : HEALTH_CONSENT_VERSION });
      expect(res.json().markdown).not.toContain('{{');
    }
    expect((await call('GET', '/api/legal/nothing')).statusCode).toBe(404);
    expect((await call('GET', '/api/legal/..%2Fpackage')).statusCode).toBe(404);
  });

  it('name the operator where one is configured, and say so plainly where not', () => {
    expect(legalText('privacy', { SPINE_OPERATOR_NAME: 'Example SRL', SPINE_OPERATOR_CONTACT: 'privacy@example.test' })!.markdown).toContain('Example SRL');
    expect(legalText('privacy', {})!.markdown).toContain('the operator of this instance');
    // The intended purpose says what the product is not, in plain words.
    expect(legalText('purpose', {})!.markdown).toMatch(/does not diagnose/);
  });
});

describe('an account that has not agreed', () => {
  it('can sign in and see what it must agree to, but touches no records', async () => {
    const { cookie } = await newcomer();
    const me = (await call('GET', '/api/auth/me', cookie)).json();
    expect(me.consent_needed).toEqual({ health: true, terms: true });
    for (const url of ['/api/documents', '/api/export', '/api/tags', '/api/share-links', '/api/episodes']) {
      const res = await call('GET', url, cookie);
      expect(res.statusCode, url).toBe(403);
      expect(res.json().code).toBe('consent_required');
    }
    expect((await call('POST', '/api/demo', cookie, { language: 'en' })).statusCode).toBe(403);
  });

  it('needs both, given separately, and then is let in', async () => {
    const { id, cookie } = await newcomer('both@spine.test');
    for (const body of [{}, { health_data: true }, { terms: true }, { health_data: 'yes', terms: true }, { health_data: false, terms: true }]) {
      expect((await call('POST', '/api/account/consent', cookie, body)).statusCode).toBe(400);
    }
    expect((await call('GET', '/api/documents', cookie)).statusCode).toBe(403);

    expect((await call('POST', '/api/account/consent', cookie, { health_data: true, terms: true })).statusCode).toBe(200);
    expect((await call('GET', '/api/documents', cookie)).statusCode).toBe(200);
    const user = await getStore().users.findById(id);
    expect(user).toMatchObject({ health_consent_version: HEALTH_CONSENT_VERSION, terms_version: TERMS_VERSION });
    expect(user!.health_consent_at).toBeTruthy();
    expect((await call('GET', '/api/auth/me', cookie)).json().consent_needed).toEqual({ health: false, terms: false });
  });

  it('is asked again when the text it agreed to is older', async () => {
    const { id, cookie } = await newcomer('older@spine.test');
    await getStore().users.recordConsent(id, { healthVersion: '2020-01-01', termsVersion: TERMS_VERSION }, new Date().toISOString());
    expect((await call('GET', '/api/documents', cookie)).statusCode).toBe(403);
    expect((await call('GET', '/api/auth/me', cookie)).json().consent_needed).toEqual({ health: true, terms: false });
    expect((await call('POST', '/api/account/consent', cookie, { health_data: true })).statusCode).toBe(200); // only what changed is asked
    expect((await call('GET', '/api/documents', cookie)).statusCode).toBe(200);
  });
});

describe('signing up', () => {
  it('records both agreements with the version shown', async () => {
    const u = await createTestUser('signup@spine.test');
    const user = await getStore().users.findById(u.id);
    expect(user).toMatchObject({ health_consent_version: HEALTH_CONSENT_VERSION, terms_version: TERMS_VERSION });
  });
});

describe('leaving', () => {
  it('deletes the account and its records only after the password is typed again and the address is written out', async () => {
    const u = await createTestUser('leaving@spine.test');
    const cookie = await loginAs(app, u.email, u.password);
    await seedDocument({ userId: u.id });
    // A sign-in just made counts as the password just typed; ten minutes later it no longer does.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await getStore().sessions.touch(u.id, (await getStore().sessions.list(u.id))[0].id, new Date().toISOString());
    expect((await call('POST', '/api/account/delete', cookie, { confirm: u.email })).statusCode).toBe(403);

    expect((await call('POST', '/api/auth/reauth', cookie, { password: TEST_PASSWORD })).statusCode).toBe(200);
    expect((await call('POST', '/api/account/delete', cookie, { confirm: 'someone@else.test' })).statusCode).toBe(400);
    expect(await getStore().users.findById(u.id)).not.toBeNull();

    const gone = await call('POST', '/api/account/delete', cookie, { confirm: u.email.toUpperCase() });
    expect(gone.statusCode).toBe(200);
    expect(gone.json()).toMatchObject({ deleted: true, documents: 1 });
    expect(await getStore().users.findById(u.id)).toBeNull();
    expect(existsSync(join(dir, 'originals', u.id))).toBe(false);
    expect((await call('GET', '/api/documents', cookie)).statusCode).toBe(401);
  });

  it('can be done by an account that never agreed (declining means leaving)', async () => {
    const { id, email, cookie } = await newcomer('decline@spine.test');
    await call('POST', '/api/auth/reauth', cookie, { password: TEST_PASSWORD });
    expect((await call('POST', '/api/account/delete', cookie, { confirm: email })).statusCode).toBe(200);
    expect(await getStore().users.findById(id)).toBeNull();
  });

  it('is not possible without signing in', async () => {
    expect((await call('POST', '/api/account/delete', undefined, { confirm: 'x' })).statusCode).toBe(401);
  });
});
