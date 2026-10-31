import { starterTagId } from '../ids.js';
import type { Database } from './driver.js';
import type { NewUser, PasskeyRecord, TotpRecord, UserRecord, UserRepository, UserTokenKind } from '../types.js';

import { STARTER_TAGS } from '../../tags.js';

export function userRepository(db: Database): UserRepository {
  const insert = db.prepare(`
    INSERT INTO users (id, email, password_hash, created_at, email_verified_at, approved, health_consent_at, health_consent_version, terms_accepted_at, terms_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const listPasskeys = db.prepare('SELECT * FROM user_passkeys WHERE user_id = ? ORDER BY created_at, id');
  const findPasskey = db.prepare('SELECT * FROM user_passkeys WHERE id = ?');
  const addPasskey = db.prepare('INSERT OR IGNORE INTO user_passkeys (id, user_id, public_key, counter, transports, name, backed_up, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const touchPasskey = db.prepare('UPDATE user_passkeys SET counter = MAX(counter, ?), last_used_at = ? WHERE id = ?');
  const renamePasskey = db.prepare('UPDATE user_passkeys SET name = ? WHERE id = ? AND user_id = ?');
  const removePasskey = db.prepare('DELETE FROM user_passkeys WHERE id = ? AND user_id = ?');
  const setPasskeyKey = db.prepare('UPDATE user_passkeys SET wrapped_key = ? WHERE id = ? AND user_id = ?');
  const asPasskey = (r: Record<string, unknown>): PasskeyRecord => ({
    id: r.id as string, user_id: r.user_id as string, public_key: r.public_key as string, counter: r.counter as number,
    transports: r.transports ? (JSON.parse(r.transports as string) as string[]) : null, name: r.name as string,
    backed_up: r.backed_up === 1, created_at: r.created_at as string, last_used_at: (r.last_used_at as string | null) ?? null,
    wrapped_key: (r.wrapped_key as string | null) ?? null,
  });
  const setConsent = db.prepare('UPDATE users SET health_consent_at = ?, health_consent_version = ?, terms_accepted_at = ?, terms_version = ? WHERE id = ?');
  // Which tables exist: the server's database has none for records (scope `accounts`), so a user has no starter tags there and deleting
  // one has only the account's tables to empty.
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(t => t.name));
  const insertTag = tables.has('tags') ? db.prepare('INSERT OR IGNORE INTO tags (id, user_id, name) VALUES (?, ?, ?)') : null;
  const findByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
  const findById = db.prepare('SELECT * FROM users WHERE id = ?');
  const setPassword = db.prepare(
    'UPDATE users SET password_hash = ?, auth_version = auth_version + 1 WHERE id = ?',
  );
  const authVersion = db.prepare('SELECT auth_version FROM users WHERE id = ?');
  const list = db.prepare(
    'SELECT id, email, created_at, email_verified_at, approved FROM users ORDER BY created_at',
  );
  const approve = db.prepare('UPDATE users SET approved = 1, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ? AND approved = 0');
  const markVerified = db.prepare(
    'UPDATE users SET email_verified_at = ? WHERE id = ? AND email_verified_at IS NULL',
  );
  const insertToken = db.prepare(`
    INSERT INTO user_tokens (id, user_id, kind, token_hash, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  // Spending and checking are the same statement, which is what makes a token
  // single-use under concurrent requests.
  const consumeToken = db.prepare(`
    UPDATE user_tokens SET used_at = ?
    WHERE token_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?
    RETURNING user_id
  `);
  const peekToken = db.prepare('SELECT user_id FROM user_tokens WHERE token_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?');
  const invalidateTokens = db.prepare(
    'UPDATE user_tokens SET used_at = ? WHERE user_id = ? AND kind = ? AND used_at IS NULL',
  );

  const getTotp = db.prepare('SELECT secret_enc, confirmed_at, last_step FROM user_totp WHERE user_id = ?');
  // Replaces an unconfirmed enrolment; the WHERE leaves a confirmed one alone.
  const beginTotp = db.prepare(`
    INSERT INTO user_totp (user_id, secret_enc, created_at, confirmed_at, last_step)
    VALUES (?, ?, ?, NULL, 0)
    ON CONFLICT(user_id) DO UPDATE SET secret_enc = excluded.secret_enc,
      created_at = excluded.created_at, last_step = 0
    WHERE user_totp.confirmed_at IS NULL
  `);
  const confirmTotp = db.prepare(
    'UPDATE user_totp SET confirmed_at = ?, last_step = ? WHERE user_id = ? AND confirmed_at IS NULL',
  );
  const bumpAuthVersion = db.prepare('UPDATE users SET auth_version = auth_version + 1 WHERE id = ?');
  // Newer than anything accepted, and only for a confirmed enrolment. This is the
  // replay guard: the check and the write are the same statement.
  const claimStep = db.prepare(
    'UPDATE user_totp SET last_step = ? WHERE user_id = ? AND confirmed_at IS NOT NULL AND last_step < ?',
  );
  const insertCode = db.prepare('INSERT OR IGNORE INTO user_recovery_codes (user_id, code_hash) VALUES (?, ?)');
  const useCode = db.prepare(
    'UPDATE user_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
  );
  const deleteCodes = db.prepare('DELETE FROM user_recovery_codes WHERE user_id = ?');
  const countCodes = db.prepare(
    'SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL',
  );
  const deleteTotp = db.prepare('DELETE FROM user_totp WHERE user_id = ?');

  const enable = db.transaction((userId: string, step: number, hashes: string[], now: string) => {
    if (confirmTotp.run(now, step, userId).changes === 0) return null;
    deleteCodes.run(userId);
    for (const hash of hashes) insertCode.run(userId, hash);
    bumpAuthVersion.run(userId);
    return (authVersion.get(userId) as { auth_version: number }).auth_version;
  });
  const replaceCodes = db.transaction((userId: string, hashes: string[]) => {
    deleteCodes.run(userId);
    for (const hash of hashes) insertCode.run(userId, hash);
  });
  const disable = db.transaction((userId: string) => {
    deleteCodes.run(userId);
    deleteTotp.run(userId);
    bumpAuthVersion.run(userId);
    return (authVersion.get(userId) as { auth_version: number }).auth_version;
  });

  // The user and their tags are one unit. Synchronous, so better-sqlite3's own
  // transaction helper is fine here — unlike Store.transaction, which wraps
  // async callbacks.
  const createWithTags = db.transaction((user: NewUser) => {
    const c = user.consent;
    insert.run(user.id, user.email, user.passwordHash, user.createdAt, user.verifiedAt, user.approved === false ? 0 : 1, c ? user.createdAt : null, c?.healthVersion ?? null, c ? user.createdAt : null, c?.termsVersion ?? null);
    if (insertTag && user.starterTags !== false) for (const name of STARTER_TAGS) insertTag.run(starterTagId(user.id, name), user.id, name);
  });

  // Children before parents, because foreign keys are enforced. The FTS triggers
  // on documents keep the search index in step.
  const OWNED_TABLES = [
    'share_link_keys',
    'shared_requests',
    'shared_opens',
    'shared_bundles',
    'match_decisions',
    'share_link_events',
    'share_link_access_log',
    'share_access_requests',
    'share_links',
    'document_tags',
    'extracted_fields',
    'measurements',
    'measurement_aliases',
    'document_doctors',
    'document_translations',
    'document_embeddings',
    'chat_messages',
    'chat_conversations',
    'document_links',
    'episode_documents',
    'episodes',
    'removed_readings',
    'documents',
    'doctors',
    'pages',
    'regroup_plans',
    'source_files',
    'tags',
    'user_sessions',
    'cookie_sessions',
    'model_usage',
    'user_devices',
    'user_tokens',
    'user_passkeys',
    'device_enrolments',
    'vault_objects',
    'vault_keys',
    'user_recovery_codes',
    'user_totp',
  ];
  const deleteFrom = OWNED_TABLES.filter(table => tables.has(table)).map(table => db.prepare(`DELETE FROM ${table} WHERE user_id = ?`));
  const deleteUser = db.prepare('DELETE FROM users WHERE id = ?');
  const deleteEverything = db.transaction((id: string) => {
    for (const statement of deleteFrom) statement.run(id);
    deleteUser.run(id);
  });

  return {
    async create(user) {
      createWithTags(user);
    },

    async findByEmail(email) {
      return (findByEmail.get(email) as UserRecord | undefined) ?? null;
    },

    async peekToken(tokenHash, kind, now) {
      return ((peekToken.get(tokenHash, kind, now) as { user_id: string } | undefined)?.user_id) ?? null;
    },

    async listPasskeys(userId) {
      return (listPasskeys.all(userId) as Array<Record<string, unknown>>).map(asPasskey);
    },

    async findPasskey(credentialId) {
      const row = findPasskey.get(credentialId) as Record<string, unknown> | undefined;
      return row ? asPasskey(row) : null;
    },

    async addPasskey(userId, p) {
      return addPasskey.run(p.id, userId, p.public_key, p.counter, p.transports ? JSON.stringify(p.transports) : null, p.name, p.backed_up ? 1 : 0, p.created_at).changes === 1;
    },

    async touchPasskey(credentialId, counter, at) {
      touchPasskey.run(counter, at, credentialId);
    },

    async renamePasskey(userId, id, name) {
      return renamePasskey.run(name, id, userId).changes === 1;
    },

    async removePasskey(userId, id) {
      return removePasskey.run(id, userId).changes === 1;
    },

    async setPasskeyWrappedKey(userId, id, wrapped) {
      return setPasskeyKey.run(wrapped, id, userId).changes === 1;
    },

    async recordConsent(id, consent, at) {
      setConsent.run(at, consent.healthVersion, at, consent.termsVersion, id);
    },

    async findById(id) {
      return (findById.get(id) as UserRecord | undefined) ?? null;
    },

    async setPassword(id, passwordHash) {
      setPassword.run(passwordHash, id);
      return (authVersion.get(id) as { auth_version: number }).auth_version;
    },

    async list() {
      return list.all() as Array<
        Pick<UserRecord, 'id' | 'email' | 'created_at' | 'email_verified_at' | 'approved'>
      >;
    },

    async markVerified(id, at) {
      markVerified.run(at, id);
    },

    async approve(id, at) {
      return approve.run(at, id).changes === 1;
    },

    async createToken(token) {
      insertToken.run(
        token.id, token.userId, token.kind, token.tokenHash, token.createdAt, token.expiresAt,
      );
    },

    async consumeToken(tokenHash, kind: UserTokenKind, now) {
      const row = consumeToken.get(now, tokenHash, kind, now) as { user_id: string } | undefined;
      return row?.user_id ?? null;
    },

    async invalidateTokens(userId, kind: UserTokenKind) {
      invalidateTokens.run(new Date().toISOString(), userId, kind);
    },

    async delete(id) {
      deleteEverything(id);
    },

    async getTotp(userId) {
      return (getTotp.get(userId) as TotpRecord | undefined) ?? null;
    },

    async beginTotp(userId, secretEnc, now) {
      return beginTotp.run(userId, secretEnc, now).changes === 1;
    },

    async enableTotp(userId, step, codeHashes, now) {
      return enable(userId, step, codeHashes, now);
    },

    async claimTotpStep(userId, step) {
      return claimStep.run(step, userId, step).changes === 1;
    },

    async useRecoveryCode(userId, codeHash, now) {
      return useCode.run(now, userId, codeHash).changes === 1;
    },

    async replaceRecoveryCodes(userId, codeHashes) {
      replaceCodes(userId, codeHashes);
    },

    async countRecoveryCodes(userId) {
      return (countCodes.get(userId) as { n: number }).n;
    },

    async disableTotp(userId) {
      return disable(userId);
    },
  };
}
