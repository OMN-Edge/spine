import type { Database } from 'better-sqlite3';
import type { NewUser, TotpRecord, UserRecord, UserRepository, UserTokenKind } from '../types.js';

import { STARTER_TAGS } from '../../tags.js';

export function userRepository(db: Database): UserRepository {
  const insert = db.prepare(
    'INSERT INTO users (id, email, password_hash, created_at, email_verified_at) VALUES (?, ?, ?, ?, ?)',
  );
  const insertTag = db.prepare('INSERT OR IGNORE INTO tags (user_id, name) VALUES (?, ?)');
  const findByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
  const findById = db.prepare('SELECT * FROM users WHERE id = ?');
  const setPassword = db.prepare(
    'UPDATE users SET password_hash = ?, auth_version = auth_version + 1 WHERE id = ?',
  );
  const authVersion = db.prepare('SELECT auth_version FROM users WHERE id = ?');
  const list = db.prepare(
    'SELECT id, email, created_at, email_verified_at FROM users ORDER BY created_at',
  );
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
    insert.run(user.id, user.email, user.passwordHash, user.createdAt, user.verifiedAt);
    for (const name of STARTER_TAGS) insertTag.run(user.id, name);
  });

  // Children before parents, because foreign keys are enforced. The FTS triggers
  // on documents keep the search index in step.
  const OWNED_TABLES = [
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
    'removed_readings',
    'documents',
    'doctors',
    'pages',
    'regroup_plans',
    'source_files',
    'tags',
    'user_sessions',
    'user_devices',
    'user_tokens',
    'user_recovery_codes',
    'user_totp',
  ];
  const deleteFrom = OWNED_TABLES.map(table => db.prepare(`DELETE FROM ${table} WHERE user_id = ?`));
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

    async findById(id) {
      return (findById.get(id) as UserRecord | undefined) ?? null;
    },

    async setPassword(id, passwordHash) {
      setPassword.run(passwordHash, id);
      return (authVersion.get(id) as { auth_version: number }).auth_version;
    },

    async list() {
      return list.all() as Array<
        Pick<UserRecord, 'id' | 'email' | 'created_at' | 'email_verified_at'>
      >;
    },

    async markVerified(id, at) {
      markVerified.run(at, id);
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
