import type { Database } from 'better-sqlite3';
import type { NewUser, UserRecord, UserRepository, UserTokenKind } from '../types.js';

/** What a new user starts with. They can add their own; tags are per-user. */
const STARTER_TAGS = [
  'allergy',
  'chronic',
  'vaccine',
  'medication',
  'imaging',
  'follow-up-needed',
  'cardiology',
  'oncology',
  'lab',
] as const;

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
    'share_link_access_log',
    'share_links',
    'document_tags',
    'extracted_fields',
    'documents',
    'pages',
    'source_files',
    'tags',
    'user_tokens',
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
  };
}
