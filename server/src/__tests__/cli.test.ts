import { holdsRecordsInThisRun } from 'spine-core/testing/store-kind.js';
import { fakeVaultKeys } from 'spine-core/testing/vault.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach } from 'vitest';
import { runCli, type CliIo } from '../cli.js';
import { getStore, resetStore, getAccountsStore } from 'spine-core/store/index.js';
import { verifyPassword, MIN_PASSWORD_LENGTH } from '../passwords.js';
import { hashUserToken } from '../user-tokens.js';
import { seedDocument, seedSourceFile, createTestUser, OWNER_ID } from './helpers/seed.js';
import { buildTestApp, loginAs } from './helpers/app.js';

/** The operator CLI is the only way to create an account until signup exists. */

function io(stdin = ''): CliIo & { out_: string[]; err_: string[] } {
  const out_: string[] = [];
  const err_: string[] = [];
  return {
    out_, err_,
    out: line => out_.push(line),
    err: line => err_.push(line),
    readPassword: async () => stdin,
  };
}

beforeEach(() => resetStore());

const records = holdsRecordsInThisRun(); // `npm run test:accounts` runs the server's own store, which has none (SECURITY.md M-37)

describe('create-user', () => {
  it('creates an account and prints a generated password once', async () => {
    const console_ = io();
    expect(await runCli(['create-user', 'New@Example.com'], console_)).toBe(0);

    const printed = console_.out_.find(line => line.startsWith('password'))!;
    const password = printed.split(': ')[1];
    expect(password.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);

    const user = await getAccountsStore().users.findByEmail('new@example.com'); // lower-cased
    expect(user).not.toBeNull();
    expect(await verifyPassword(user!.password_hash, password)).toBe(true);
  });

  it('never stores the password it printed', async () => {
    const console_ = io();
    await runCli(['create-user', 'store@example.com'], console_);
    const password = console_.out_.find(l => l.startsWith('password'))!.split(': ')[1];

    const user = await getAccountsStore().users.findByEmail('store@example.com');
    expect(user!.password_hash).not.toContain(password);
    expect(user!.password_hash).toMatch(/^\$argon2id\$/);
  });

  it('takes a password from stdin and does not print it', async () => {
    const console_ = io('a-password-from-stdin!');
    expect(await runCli(['create-user', 'stdin@example.com', '--password-stdin'], console_)).toBe(0);

    expect(console_.out_.join('\n')).not.toContain('a-password-from-stdin!');
    const user = await getAccountsStore().users.findByEmail('stdin@example.com');
    expect(await verifyPassword(user!.password_hash, 'a-password-from-stdin!')).toBe(true);
  });

  it('refuses a stdin password that is too short', async () => {
    const console_ = io('short');
    expect(await runCli(['create-user', 'weak@example.com', '--password-stdin'], console_)).toBe(1);
    expect(console_.err_.join()).toMatch(/at least 12/);
    expect(await getAccountsStore().users.findByEmail('weak@example.com')).toBeNull();
  });

  it('refuses a duplicate email, in any case', async () => {
    await runCli(['create-user', 'dupe@example.com'], io());
    const console_ = io();
    expect(await runCli(['create-user', 'DUPE@example.com'], console_)).toBe(1);
    expect(console_.err_.join()).toMatch(/already exists/);
  });

  it('refuses something that is not an email', async () => {
    const console_ = io();
    expect(await runCli(['create-user', 'not-an-email'], console_)).toBe(2);
    expect(await runCli(['create-user'], io())).toBe(2);
  });

  it.skipIf(!records)('gives a new user their own starter tags', async () => {
    await runCli(['create-user', 'tags@example.com'], io());
    const user = await getAccountsStore().users.findByEmail('tags@example.com');
    const names = (await getStore().tags.listFor(user!.id)).map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['allergy', 'cardiology', 'lab']));
  });
});

describe('set-password', () => {
  it('changes the password and ends existing sessions', async () => {
    await runCli(['create-user', 'reset@example.com', '--password-stdin'], io('the-first-password'));
    const before = await getAccountsStore().users.findByEmail('reset@example.com');

    const console_ = io('the-second-password');
    expect(await runCli(['set-password', 'reset@example.com', '--password-stdin'], console_)).toBe(0);

    const after = await getAccountsStore().users.findByEmail('reset@example.com');
    expect(after!.auth_version).toBe(before!.auth_version + 1);
    expect(await verifyPassword(after!.password_hash, 'the-second-password')).toBe(true);
    expect(await verifyPassword(after!.password_hash, 'the-first-password')).toBe(false);
    expect(console_.out_.join()).toMatch(/signed out/);
  });

  it('refuses an account with a vault, whose password the operator cannot choose', async () => {
    await runCli(['create-user', 'vaulted@example.com', '--password-stdin'], io('the-first-password'));
    const user = await getAccountsStore().users.findByEmail('vaulted@example.com');
    await getAccountsStore().vault.putKeys(user!.id, { ...fakeVaultKeys(), kdf_params: JSON.stringify(fakeVaultKeys().kdf_params) }, new Date().toISOString());
    const console_ = io('the-second-password');
    expect(await runCli(['set-password', 'vaulted@example.com', '--password-stdin'], console_)).toBe(1);
    expect(console_.err_.join()).toMatch(/has a vault/);
    expect(await verifyPassword((await getAccountsStore().users.findByEmail('vaulted@example.com'))!.password_hash, 'the-first-password')).toBe(true);
  });

  it('reports an unknown account', async () => {
    const console_ = io();
    expect(await runCli(['set-password', 'ghost@example.com'], console_)).toBe(1);
    expect(console_.err_.join()).toMatch(/no account/);
  });
});

describe('disable-2fa', () => {
  it('turns off the second factor, ends their sessions, and removes the secret and codes', async () => {
    await runCli(['create-user', 'lost@example.com', '--password-stdin'], io('the-first-password'));
    const user = (await getAccountsStore().users.findByEmail('lost@example.com'))!;
    await getAccountsStore().users.beginTotp(user.id, 'v1.x', new Date().toISOString());
    await getAccountsStore().users.enableTotp(user.id, 1, ['h1', 'h2'], new Date().toISOString());
    const before = (await getAccountsStore().users.findById(user.id))!;

    const console_ = io();
    expect(await runCli(['disable-2fa', 'lost@example.com'], console_)).toBe(0);

    expect(console_.out_.join()).toMatch(/turned off.*signed out/);
    expect(await getAccountsStore().users.getTotp(user.id)).toBeNull();
    expect(await getAccountsStore().users.countRecoveryCodes(user.id)).toBe(0);
    expect((await getAccountsStore().users.findById(user.id))!.auth_version).toBe(before.auth_version + 1);
  });

  it('leaves an account without one alone, and says so', async () => {
    await runCli(['create-user', 'plain@example.com'], io());
    const user = (await getAccountsStore().users.findByEmail('plain@example.com'))!;
    const console_ = io();

    expect(await runCli(['disable-2fa', 'plain@example.com'], console_)).toBe(0);
    expect(console_.out_.join()).toMatch(/no two-factor/);
    expect((await getAccountsStore().users.findById(user.id))!.auth_version).toBe(user.auth_version);
  });

  it('reports an unknown account', async () => {
    const console_ = io();
    expect(await runCli(['disable-2fa', 'ghost@example.com'], console_)).toBe(1);
    expect(console_.err_.join()).toMatch(/no account/);
  });
});

describe('list-users', () => {
  it('lists accounts without any password material', async () => {
    await runCli(['create-user', 'listed@example.com'], io());
    const console_ = io();
    expect(await runCli(['list-users'], console_)).toBe(0);

    const text = console_.out_.join('\n');
    expect(text).toContain('listed@example.com');
    expect(text).not.toMatch(/argon2/);
  });

  it('says so when there are none', async () => {
    const console_ = io();
    await runCli(['list-users'], console_);
    expect(console_.out_).toEqual(['no accounts']);
  });
});

describe('unknown command', () => {
  it('prints usage and exits 2', async () => {
    const console_ = io();
    expect(await runCli(['frobnicate'], console_)).toBe(2);
    expect(console_.err_.join()).toMatch(/create-user/);
  });
});


describe('reset-link', () => {
  it('prints a one-time link without needing a mailer', async () => {
    await runCli(['create-user', 'link@example.com'], io());
    const console_ = io();
    expect(await runCli(['reset-link', 'link@example.com'], console_)).toBe(0);

    const link = console_.out_.find(line => line.includes('/reset#'))!;
    const token = link.split('#')[1];
    expect(token).toHaveLength(43);

    const user = await getAccountsStore().users.findByEmail('link@example.com');
    const now = new Date().toISOString();
    expect(await getAccountsStore().users.consumeToken(hashUserToken(token), 'reset', now)).toBe(user!.id);
    // And only once.
    expect(await getAccountsStore().users.consumeToken(hashUserToken(token), 'reset', now)).toBeNull();
  });

  it('reports an unknown account and a silly lifetime', async () => {
    expect(await runCli(['reset-link', 'ghost@example.com'], io())).toBe(1);
    await runCli(['create-user', 'life@example.com'], io());
    expect(await runCli(['reset-link', 'life@example.com', '--hours=500'], io())).toBe(2);
  });
});

describe('list-users', () => {
  it('marks an account that has not confirmed its address', async () => {
    await createTestUser('unconfirmed@example.com', { verified: false });
    const console_ = io();
    await runCli(['list-users'], console_);
    expect(console_.out_.join('\n')).toMatch(/unconfirmed@example\.com.*UNVERIFIED/);
  });
});

/** S-18: deleting an account removes its rows and its files, and only its own. */
describe('delete-user', () => {
  let dataDir: string;
  let backupDir: string;
  const saved = { data: process.env.DATA_DIR, backup: process.env.SPINE_BACKUP_DIR };

  afterEach(() => {
    process.env.DATA_DIR = saved.data; process.env.SPINE_BACKUP_DIR = saved.backup;
    if (saved.data === undefined) delete process.env.DATA_DIR;
    if (saved.backup === undefined) delete process.env.SPINE_BACKUP_DIR;
    for (const dir of [dataDir, backupDir]) if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function setUp() {
    dataDir = mkdtempSync(path.join(tmpdir(), 'spine-del-data-'));
    backupDir = mkdtempSync(path.join(tmpdir(), 'spine-del-backup-'));
    process.env.DATA_DIR = dataDir;
    process.env.SPINE_BACKUP_DIR = backupDir;
  }

  function filesFor(userId: string, sourceFileId: string) {
    const original = path.join(dataDir, 'originals', userId, '2026');
    const page = path.join(dataDir, 'pages', sourceFileId);
    const mirrored = path.join(backupDir, 'originals', userId, '2026');
    for (const dir of [original, page, mirrored]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'f'), 'x');
    }
    return { original: path.dirname(original), page, mirrored: path.dirname(mirrored) };
  }

  it('shows what it would remove and does nothing without --yes', async () => {
    setUp();
    await createTestUser();
    const keys = fakeVaultKeys();
    const now = new Date().toISOString();
    await getAccountsStore().vault.putKeys(OWNER_ID, { ...keys, kdf_params: JSON.stringify(keys.kdf_params) }, now);
    await getAccountsStore().vault.put(OWNER_ID, { id: 'object-0001', profileId: 'profile-0001', kind: 'bundle', size: 4, wrappedKey: 'k', baseSeq: 0 }, now, 1 << 20);
    const console_ = io();

    expect(await runCli(['delete-user', 'owner@spine.test'], console_)).toBe(1);
    expect(console_.err_.join()).toMatch(/has 1 sealed object\(s\).*--yes/);
    expect(await getAccountsStore().users.findByEmail('owner@spine.test')).not.toBeNull();
  });

  it.skipIf(!records)('removes the account, its rows, its files and its backup copy', async () => {
    setUp();
    await createTestUser();
    const { sourceFileId } = await seedDocument();
    const paths = filesFor(OWNER_ID, sourceFileId);

    const console_ = io();
    expect(await runCli(['delete-user', 'owner@spine.test', '--yes'], console_)).toBe(0);

    expect(await getAccountsStore().users.findByEmail('owner@spine.test')).toBeNull();
    expect(await getStore().sourceFiles.listFor(OWNER_ID)).toEqual([]);
    expect(await getStore().documents.listFor(OWNER_ID, { limit: 10, offset: 0 })).toEqual([]);
    expect(existsSync(paths.original)).toBe(false);
    expect(existsSync(paths.mirrored)).toBe(false);
    expect(console_.out_.join()).toMatch(/snapshots already taken/);
  });

  it.skipIf(!records)('leaves every other user’s records and files alone', async () => {
    setUp();
    await createTestUser();
    const other = await createTestUser('other@example.com');
    const mine = await seedDocument({ userId: OWNER_ID });
    const theirs = await seedDocument({ userId: other.id, tags: ['lab'], aiSummary: 'other user summary' });
    filesFor(OWNER_ID, mine.sourceFileId);
    const theirPaths = filesFor(other.id, theirs.sourceFileId);

    await runCli(['delete-user', 'owner@spine.test', '--yes'], io());

    expect(await getStore().documents.findFor(other.id, theirs.id)).not.toBeNull();
    expect(await getStore().tags.namesForDocument(other.id, theirs.id)).toContain('lab');
    expect((await getStore().tags.listFor(other.id)).length).toBeGreaterThan(0);
    expect(existsSync(theirPaths.original)).toBe(true);
    expect(existsSync(theirPaths.mirrored)).toBe(true);
    // Search still finds theirs, and only theirs.
    expect((await getStore().documents.listFor(other.id, { q: 'other', limit: 10, offset: 0 })).map(d => d.id))
      .toEqual([theirs.id]);
  });

  it('signs the deleted user out', async () => {
    setUp();
    const app = await buildTestApp();
    try {
      const cookie = await loginAs(app);
      expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(200);

      await runCli(['delete-user', 'owner@spine.test', '--yes'], io());

      expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
    } finally { await app.close(); }
  });

  it('reports an unknown account', async () => {
    setUp();
    expect(await runCli(['delete-user', 'ghost@example.com', '--yes'], io())).toBe(1);
  });
});
