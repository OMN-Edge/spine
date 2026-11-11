import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { fakeAuthValue, fakeVaultKeys } from 'spine-core/testing/vault.js';
import { getAccountsStore } from 'spine-core/store/index.js';
import { MAX_REMINDERS } from 'spine-core/reminders/index.js';
import { buildTestApp, loginAs, loginSession } from './helpers/app.js';
import { createTestUser } from './helpers/seed.js';
import { resetMailer, type MailMessage } from '../mail/index.js';
import { remindDue } from '../routes/reminders.js';

const K = (c: string) => c.repeat(100).slice(0, 100);
const hex = (v: string) => createHash('sha256').update(v).digest('hex');
const PROFILE = 'profile-aaaa-0001';
const OTHER = 'profile-bbbb-0002';
const BINDING = { hello: K('h'), owner_pin: K('p') };

/** The dates of follow-up reminders and the mail on the day: SECURITY.md M-53, docs/scenarios.md 16.x. */
describe('the dates of reminders', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let owner: string;
  let ownerId = '';
  const mails: MailMessage[] = [];
  const store = () => getAccountsStore();
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, who: string, payload?: unknown) => app.inject({ method, url, headers: { cookie: who }, payload: payload as never });
  const keys = (who: string) => app.inject({ method: 'PUT', url: '/api/vault/keys', headers: { cookie: who }, payload: { auth_value: fakeAuthValue(), keys: fakeVaultKeys() } });
  const profile = (who: string, id: string) => app.inject({ method: 'PUT', url: `/api/vault/objects/${id}`, headers: { cookie: who, 'content-type': 'application/octet-stream', 'x-spine-kind': 'profile', 'x-spine-profile': id, 'x-spine-wrapped-key': K('k'), 'x-spine-base-seq': '0' }, payload: Buffer.from('sealed profile') });
  const dates = (who: string, items: Array<{ id: string; due_on: string }>, p = PROFILE) => call('PUT', '/api/reminder-dates', who, { profile: p, items });
  const row = (id: string) => ({ id: `${id}`.padEnd(8, 'x'), due_on: '2027-01-15' });
  let n = 0;
  const rid = () => `rem-${String(++n).padStart(6, '0')}`;

  beforeAll(async () => {
    resetMailer({ enabled: true, send: async m => { mails.push(m); } });
    app = await buildTestApp();
    owner = await loginSession(app);
    ownerId = (await store().users.findByEmail('owner@spine.test'))!.id;
    await keys(owner);
    await profile(owner, PROFILE);
    await profile(owner, OTHER);
  });
  afterEach(() => { mails.length = 0; });

  it('are told for a profile of the account, as an id and a day, and replace what was held for it', async () => {
    const [a, b] = [rid(), rid()];
    expect((await dates(owner, [{ id: a, due_on: '2027-01-15' }, { id: b, due_on: '2027-02-01' }])).statusCode).toBe(200);
    expect(await store().reminderDates.count(ownerId)).toBeGreaterThanOrEqual(2);
    // A date not named is dropped, and another profile’s are not touched.
    const c = rid();
    await dates(owner, [{ id: c, due_on: '2027-03-01' }], OTHER);
    const before = await store().reminderDates.count(ownerId);
    await dates(owner, [{ id: a, due_on: '2027-01-15' }]);
    expect(await store().reminderDates.count(ownerId)).toBe(before - 1);
  });

  it('refuse what is not the account’s profile, not a date, not an id, or too many, and need a sign-in', async () => {
    expect((await dates(owner, [], 'profile-nope-0000')).statusCode).toBe(404);
    expect((await call('PUT', '/api/reminder-dates', owner, { profile: 'x', items: [] })).statusCode).toBe(400);
    expect((await dates(owner, [{ id: rid(), due_on: 'tomorrow' }])).statusCode).toBe(400);
    expect((await dates(owner, [{ id: 'x', due_on: '2027-01-01' }])).statusCode).toBe(400);
    const same = rid();
    expect((await dates(owner, [{ id: same, due_on: '2027-01-01' }, { id: same, due_on: '2027-01-02' }])).statusCode).toBe(400);
    const many = Array.from({ length: MAX_REMINDERS + 1 }, () => ({ id: rid(), due_on: '2027-01-01' }));
    expect((await dates(owner, many)).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/reminder-dates', payload: { profile: PROFILE, items: [] } })).statusCode).toBe(401);
    const stranger = await createTestUser('stranger-dates@spine.test');
    const theirs = await loginAs(app, stranger.email, stranger.password);
    expect((await dates(theirs, [])).statusCode).toBe(404);
  });

  it('bound what an account holds across its profiles', async () => {
    await dates(owner, [], PROFILE);
    await dates(owner, [], OTHER);
    const full = Array.from({ length: MAX_REMINDERS }, () => ({ id: rid(), due_on: '2027-01-01' }));
    expect((await dates(owner, full)).statusCode).toBe(200);
    const over = await dates(owner, [{ id: rid(), due_on: '2027-01-01' }], OTHER);
    expect(over.statusCode).toBe(409);
    expect(over.json().code).toBe('too_many');
    await dates(owner, [], PROFILE);
  });

  describe('the mail on the day', () => {
    it('says a reminder is due and nothing of what for, once for the day, and not before the day', async () => {
      await dates(owner, [], PROFILE);
      await dates(owner, [], OTHER);
      await dates(owner, [{ id: rid(), due_on: '2027-01-15' }, { id: rid(), due_on: '2027-01-15' }]);
      expect(await remindDue(new Date('2027-01-14T09:00:00Z'))).toBe(0);
      expect(await remindDue(new Date('2027-01-15T09:00:00Z'))).toBe(1);
      expect(mails).toHaveLength(1);
      expect(mails[0]).toMatchObject({ to: 'owner@spine.test', subject: 'Reminders are due in Spine' });
      expect(mails[0]!.text).toMatch(/2 reminders/);
      expect(mails[0]!.text).not.toMatch(/control|doctor|document|results/i);
      // Mailed once: the next run has nothing to say, and a date moved is mailed again.
      expect(await remindDue(new Date('2027-01-15T10:00:00Z'))).toBe(0);
    });

    it('mails again a date that was moved, and not one that was only told again', async () => {
      await dates(owner, [], PROFILE);
      const id = rid();
      await dates(owner, [{ id, due_on: '2027-04-01' }]);
      expect(await remindDue(new Date('2027-04-01T08:00:00Z'))).toBe(1);
      await dates(owner, [{ id, due_on: '2027-04-01' }]);
      expect(await remindDue(new Date('2027-04-02T08:00:00Z'))).toBe(0);
      await dates(owner, [{ id, due_on: '2027-06-01' }]);
      expect(await remindDue(new Date('2027-05-01T08:00:00Z'))).toBe(0);
      expect(await remindDue(new Date('2027-06-01T08:00:00Z'))).toBe(1);
    });

    it('is tried again when a mail fails, and sent to no one where there is no mailer', async () => {
      await dates(owner, [], PROFILE);
      await dates(owner, [{ id: rid(), due_on: '2027-07-01' }]);
      resetMailer({ enabled: true, send: async () => { throw new Error('down'); } });
      expect(await remindDue(new Date('2027-07-01T08:00:00Z'))).toBe(0);
      resetMailer({ enabled: true, send: async m => { mails.push(m); } });
      expect(await remindDue(new Date('2027-07-01T09:00:00Z'))).toBe(1);
      resetMailer({ enabled: false, send: async () => undefined });
      await dates(owner, [{ id: rid(), due_on: '2027-08-01' }]);
      expect(await remindDue(new Date('2027-08-01T08:00:00Z'))).toBe(0);
      resetMailer({ enabled: true, send: async m => { mails.push(m); } });
      expect(await remindDue(new Date('2027-08-01T09:00:00Z'))).toBe(1);
    });
  });

  describe('for whoever looks after a person', () => {
    let guardian = '';
    let guardianId = '';
    let viewer = '';
    let viewerId = '';

    const grantTo = async (email: string, role: 'guardian' | 'viewer', who: string, invite: string) => {
      const proof = invite.repeat(43).slice(0, 43);
      const id = invite.repeat(43).slice(0, 43);
      expect((await call('POST', '/api/delegations/invites', owner, { id, profile_id: PROFILE, role, wrapped: K('w'), proof_hash: hex(proof), owner_blob: K('o') })).statusCode).toBe(201);
      const claimed = await call('POST', '/api/delegations/claim', who, { id, proof });
      const grant = claimed.json().grant.id as string;
      expect((await call('PUT', `/api/delegations/${grant}/key`, who, { wrapped_key: K('w'), ...BINDING })).statusCode).toBe(200);
      await call('PUT', `/api/delegations/${grant}/pin`, owner, { pin: K('n') });
      expect((await call('POST', `/api/delegations/${grant}/state`, owner, { state: 'active' })).statusCode).toBe(200);
      return grant;
    };

    beforeAll(async () => {
      const g = await createTestUser('guardian-dates@spine.test');
      const v = await createTestUser('viewer-dates@spine.test');
      [guardianId, viewerId] = [g.id, v.id];
      guardian = await loginAs(app, g.email, g.password);
      viewer = await loginAs(app, v.email, v.password);
      await keys(guardian);
      await keys(viewer);
    });

    it('goes to a guardian and to the owner, and not to someone who can only read, nor to one let in to another profile', async () => {
      const guardianGrant = await grantTo('guardian-dates@spine.test', 'guardian', guardian, 'g');
      await grantTo('viewer-dates@spine.test', 'viewer', viewer, 'v');
      await dates(owner, [], PROFILE);
      await dates(owner, [], OTHER);
      await dates(owner, [{ id: rid(), due_on: '2028-01-10' }]);
      await dates(owner, [{ id: rid(), due_on: '2028-01-10' }], OTHER);
      expect(await remindDue(new Date('2028-01-10T09:00:00Z'))).toBe(2);
      const reminders = mails.filter(m => /remind/i.test(m.subject));
      const to = reminders.map(m => m.to).sort();
      expect(to).toEqual(['guardian-dates@spine.test', 'owner@spine.test']);
      // The owner has two (one of each profile), the guardian one: of the profile they look after.
      expect(reminders.find(m => m.to === 'owner@spine.test')!.text).toMatch(/2 reminders/);
      expect(reminders.find(m => m.to === 'guardian-dates@spine.test')!.text).toMatch(/A reminder you set/);
      void guardianGrant; void guardianId; void viewerId;
    });

    it('can be told by a guardian’s device for the profile they look after, and not by a viewer’s', async () => {
      const guardianGrant = ((await call('GET', '/api/delegations', guardian)).json().received as Array<{ id: string }>)[0]!.id;
      const before = await store().reminderDates.count(ownerId);
      const told = await call('PUT', `/api/delegated/${guardianGrant}/reminder-dates`, guardian, { items: [{ id: rid(), due_on: '2028-05-01' }] });
      expect(told.statusCode).toBe(200);
      // They are the owner’s, for the profile of the grant: what was held for that profile is replaced, the other profile’s is not.
      expect(await store().reminderDates.count(ownerId)).toBe(before);
      expect(await store().reminderDates.count(guardianId)).toBe(0);
      const viewerGrant = ((await call('GET', '/api/delegations', viewer)).json().received as Array<{ id: string }>)[0]!.id;
      expect((await call('PUT', `/api/delegated/${viewerGrant}/reminder-dates`, viewer, { items: [] })).statusCode).toBe(404);
      void viewerId;
    });
  });
});
