import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildTestApp, loginAs } from './helpers/app.js';
import { OWNER_EMAIL, createTestUser } from './helpers/seed.js';
import { getAccountsStore } from 'spine-core/store/index.js';
import { resetMailer, type Mailer, type MailMessage } from '../mail/index.js';
import { runCli } from '../cli.js';
import { loadConfig } from '../config.js';
import { ConfigError } from 'spine-core/config.js';

/**
 * SPINE_REGISTRATION=approval: anyone can ask for an account, and it holds no session until the administrator approves it, from the
 * command line or from the app (SPINE_ADMIN_EMAILS). Mail is optional: with none, approval stands for confirming the address.
 */

let app: Awaited<ReturnType<typeof buildTestApp>>;
let sent: MailMessage[];
let mailerEnabled: boolean;

const fakeMailer: Mailer = {
  get enabled() { return mailerEnabled; },
  async send(message) { sent.push(message); },
};

const ADMIN_EMAIL = 'admin@spine.test';
const PASSWORD = 'a-brand-new-password';
const CONSENT = { consent_health_data: true, accept_terms: true };

beforeEach(async () => {
  sent = [];
  mailerEnabled = false;
  resetMailer(fakeMailer);
  app = await buildTestApp({
    accounts: { registration: 'approval', instance: 'private' },
    admin: { admins: () => new Set([ADMIN_EMAIL]) },
  });
});
afterEach(async () => { await app.close(); resetMailer(null); });

const post = (url: string, payload: unknown, cookie?: string) =>
  app.inject({ method: 'POST', url, payload: payload as object, headers: cookie ? { cookie } : undefined });
const register = (email: string) => post('/api/auth/register', { email, password: PASSWORD, ...CONSENT });
const signIn = (email: string) => post('/api/auth/login', { email, password: PASSWORD });

describe('asking for an account', () => {
  it('says the instance is private and that accounts are approved', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/auth/options' })).json())
      .toMatchObject({ registration: 'approval', instance: 'private' });
  });

  it('creates a waiting account and, with no mailer, sends nothing', async () => {
    const res = await register('new@example.com');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ pending: true });
    const user = await getAccountsStore().users.findByEmail('new@example.com');
    expect(user?.approved).toBe(0);
    // Nothing to confirm an address by: the administrator's approval stands for it.
    expect(user?.email_verified_at).not.toBeNull();
    await new Promise(r => setTimeout(r, 30));
    expect(sent).toHaveLength(0);
  });

  it('asks for the address to be confirmed too when there is a mailer', async () => {
    mailerEnabled = true;
    await register('mailed@example.com');
    await new Promise(r => setTimeout(r, 30));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('/verify#');
    expect((await getAccountsStore().users.findByEmail('mailed@example.com'))?.email_verified_at).toBeNull();
  });

  it('answers a taken address exactly as it answers a new one', async () => {
    const fresh = await register('fresh@example.com');
    const taken = await register(OWNER_EMAIL);
    expect(taken.statusCode).toBe(fresh.statusCode);
    expect(taken.json()).toEqual(fresh.json());
  });
});

describe('a waiting account', () => {
  it('cannot sign in, and is told why only with the right password', async () => {
    await register('wait@example.com');
    const right = await signIn('wait@example.com');
    expect(right.statusCode).toBe(403);
    expect(right.json()).toMatchObject({ code: 'awaiting_approval' });
    expect(right.cookies.find(c => c.name === 'spine_device')).toBeUndefined();
    const wrong = await post('/api/auth/login', { email: 'wait@example.com', password: 'not-the-password-at-all' });
    expect(wrong.statusCode).toBe(401);
  });

  it('is let in once approved from the command line', async () => {
    await register('wait@example.com');
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(l), readPassword: async () => '' };
    expect(await runCli(['list-users'], io)).toBe(0);
    expect(out.join('\n')).toContain('WAITING FOR APPROVAL');
    expect(await runCli(['approve-user', 'wait@example.com'], io)).toBe(0);
    expect((await signIn('wait@example.com')).statusCode).toBe(200);
    // Approving twice is not a thing the account needs: it says so.
    expect(await runCli(['approve-user', 'wait@example.com'], io)).toBe(1);
  });

  it('loses its session at once if it somehow had one and is not approved', async () => {
    const waiting = await createTestUser('waiting@example.com', { approved: false, password: PASSWORD });
    expect(waiting.id).toBeTruthy();
    expect((await signIn('waiting@example.com')).statusCode).toBe(403);
  });
});

describe('the administrator in the app', () => {
  const adminCookie = async () => { await createTestUser(ADMIN_EMAIL, { password: PASSWORD }); return loginAs(app, ADMIN_EMAIL, PASSWORD); };

  it('lists the accounts waiting, to an administrator only', async () => {
    await register('wait@example.com');
    const other = await createTestUser('someone@example.com', { password: PASSWORD });
    expect(other.id).toBeTruthy();
    const nobody = await app.inject({ method: 'GET', url: '/api/admin/accounts' });
    expect(nobody.statusCode).toBe(401);
    const notAdmin = await app.inject({ method: 'GET', url: '/api/admin/accounts', headers: { cookie: await loginAs(app, 'someone@example.com', PASSWORD) } });
    expect(notAdmin.statusCode).toBe(403);
    const list = await app.inject({ method: 'GET', url: '/api/admin/accounts', headers: { cookie: await adminCookie() } });
    expect(list.statusCode).toBe(200);
    expect(list.json().pending.map((p: { email: string }) => p.email)).toEqual(['wait@example.com']);
  });

  it('approves one, which then signs in, and mails them only when there is a mailer', async () => {
    await register('wait@example.com');
    const cookie = await adminCookie();
    const id = (await getAccountsStore().users.findByEmail('wait@example.com'))!.id;
    mailerEnabled = true;
    expect((await post(`/api/admin/accounts/${id}/approve`, {}, cookie)).statusCode).toBe(200);
    await new Promise(r => setTimeout(r, 30));
    expect(sent.map(m => m.to)).toEqual(['wait@example.com']);
    expect((await signIn('wait@example.com')).statusCode).toBe(200);
    // Not waiting any more.
    expect((await post(`/api/admin/accounts/${id}/approve`, {}, cookie)).statusCode).toBe(404);
  });

  it('refuses one, which removes it, and never touches an approved account', async () => {
    await register('wait@example.com');
    const approved = await createTestUser('member@example.com', { password: PASSWORD });
    const cookie = await adminCookie();
    const waitingId = (await getAccountsStore().users.findByEmail('wait@example.com'))!.id;
    expect((await post(`/api/admin/accounts/${approved.id}/refuse`, {}, cookie)).statusCode).toBe(404);
    expect(await getAccountsStore().users.findByEmail('member@example.com')).not.toBeNull();
    expect((await post(`/api/admin/accounts/${waitingId}/refuse`, {}, cookie)).statusCode).toBe(200);
    expect(await getAccountsStore().users.findByEmail('wait@example.com')).toBeNull();
  });

  it('is refused to anyone who is not an administrator, whatever they send', async () => {
    await register('wait@example.com');
    await createTestUser('someone@example.com', { password: PASSWORD });
    const cookie = await loginAs(app, 'someone@example.com', PASSWORD);
    const id = (await getAccountsStore().users.findByEmail('wait@example.com'))!.id;
    expect((await post(`/api/admin/accounts/${id}/approve`, { email: ADMIN_EMAIL }, cookie)).statusCode).toBe(403);
    expect((await getAccountsStore().users.findById(id))?.approved).toBe(0);
  });
});

describe('SPINE_INSTANCE', () => {
  const base = { SESSION_SECRET: 'x'.repeat(40), SPINE_MAILER: 'none' };
  it('is public unless it says private, and refuses anything else', () => {
    expect(loadConfig({ ...base })).toMatchObject({ instance: 'public' });
    expect(loadConfig({ ...base, SPINE_INSTANCE: 'private' })).toMatchObject({ instance: 'private' });
    expect(() => loadConfig({ ...base, SPINE_INSTANCE: 'secret' })).toThrow(ConfigError);
  });

  it('never accepts open signup when private, and accepts approval and operator', () => {
    expect(() => loadConfig({ ...base, SPINE_INSTANCE: 'private', SPINE_REGISTRATION: 'open', SPINE_MAILER: 'brevo', BREVO_API_KEY: 'k', SPINE_MAIL_SENDER: 's', SPINE_DOMAIN: 'x.test' })).toThrow(/does not accept/);
    expect(loadConfig({ ...base, SPINE_INSTANCE: 'private', SPINE_REGISTRATION: 'approval' })).toMatchObject({ registration: 'approval' });
    expect(loadConfig({ ...base, SPINE_INSTANCE: 'private' })).toMatchObject({ registration: 'operator' });
  });
});

describe('an account the operator made', () => {
  it('is approved, and signs in under approval mode', async () => {
    await createTestUser('made@example.com', { password: PASSWORD });
    expect((await signIn('made@example.com')).statusCode).toBe(200);
  });
});
