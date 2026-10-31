import type { NewUser, PasskeyRecord, TotpRecord, UserRecord, UserRepository, UserTokenKind } from '../types.js';
import { changed, many, one, type Begin, type Query } from './query.js';

/** The account tables a user owns, children before parents (foreign keys). */
const OWNED_TABLES = [
  'shared_requests', 'shared_opens', 'shared_bundles', 'user_sessions', 'cookie_sessions', 'model_usage', 'user_devices', 'user_tokens',
  'user_passkeys', 'device_enrolments', 'vault_objects', 'vault_keys', 'user_recovery_codes', 'user_totp',
];

const asPasskey = (r: Record<string, unknown>): PasskeyRecord => ({
  id: r.id as string, user_id: r.user_id as string, public_key: r.public_key as string, counter: Number(r.counter),
  transports: r.transports ? (JSON.parse(r.transports as string) as string[]) : null, name: r.name as string,
  backed_up: r.backed_up === 1, created_at: r.created_at as string, last_used_at: (r.last_used_at as string | null) ?? null,
  wrapped_key: (r.wrapped_key as string | null) ?? null,
});

/**
 * `begin` runs `work` in a transaction on one connection (the store's `transaction`), so the steps that must be one unit are, as the SQLite
 * adapter's synchronous `db.transaction` makes them.
 */
export function userRepository(q: Query, begin: Begin): UserRepository {
  const authVersion = async (run: Query, id: string) => Number((await one<{ auth_version: number }>(run, 'SELECT auth_version FROM users WHERE id = $1', [id]))!.auth_version);
  const bump = (run: Query, id: string) => run('UPDATE users SET auth_version = auth_version + 1 WHERE id = $1', [id]);
  const insertCodes = async (run: Query, userId: string, hashes: string[]) => {
    for (const hash of hashes) await run('INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, hash]);
  };

  return {
    async create(user: NewUser) {
      const c = user.consent;
      // An account the server keeps has no records, so there are no starter tags to make.
      await q(
        `INSERT INTO users (id, email, password_hash, created_at, email_verified_at, approved, health_consent_at, health_consent_version, terms_accepted_at, terms_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [user.id, user.email, user.passwordHash, user.createdAt, user.verifiedAt, user.approved === false ? 0 : 1, c ? user.createdAt : null, c?.healthVersion ?? null, c ? user.createdAt : null, c?.termsVersion ?? null],
      );
    },

    async findByEmail(email) {
      return one<UserRecord>(q, 'SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
    },

    async findById(id) {
      return one<UserRecord>(q, 'SELECT * FROM users WHERE id = $1', [id]);
    },

    async list() {
      return many<Pick<UserRecord, 'id' | 'email' | 'created_at' | 'email_verified_at' | 'approved'>>(q, 'SELECT id, email, created_at, email_verified_at, approved FROM users ORDER BY created_at');
    },

    async setPassword(id, passwordHash) {
      return begin(async run => {
        await run('UPDATE users SET password_hash = $1, auth_version = auth_version + 1 WHERE id = $2', [passwordHash, id]);
        return authVersion(run, id);
      });
    },

    async markVerified(id, at) {
      await q('UPDATE users SET email_verified_at = $1 WHERE id = $2 AND email_verified_at IS NULL', [at, id]);
    },

    async approve(id, at) {
      return (await changed(q, 'UPDATE users SET approved = 1, email_verified_at = COALESCE(email_verified_at, $1) WHERE id = $2 AND approved = 0', [at, id])) === 1;
    },

    async recordConsent(id, consent, at) {
      await q('UPDATE users SET health_consent_at = $1, health_consent_version = $2, terms_accepted_at = $3, terms_version = $4 WHERE id = $5', [at, consent.healthVersion, at, consent.termsVersion, id]);
    },

    async createToken(token) {
      await q('INSERT INTO user_tokens (id, user_id, kind, token_hash, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)', [token.id, token.userId, token.kind, token.tokenHash, token.createdAt, token.expiresAt]);
    },

    // Checking and spending are the same statement, which is what makes a token single-use under concurrent requests.
    async consumeToken(tokenHash, kind: UserTokenKind, now) {
      const row = await one<{ user_id: string }>(q, 'UPDATE user_tokens SET used_at = $1 WHERE token_hash = $2 AND kind = $3 AND used_at IS NULL AND expires_at > $1 RETURNING user_id', [now, tokenHash, kind]);
      return row?.user_id ?? null;
    },

    async peekToken(tokenHash, kind, now) {
      return (await one<{ user_id: string }>(q, 'SELECT user_id FROM user_tokens WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > $3', [tokenHash, kind, now]))?.user_id ?? null;
    },

    async invalidateTokens(userId, kind: UserTokenKind) {
      await q('UPDATE user_tokens SET used_at = $1 WHERE user_id = $2 AND kind = $3 AND used_at IS NULL', [new Date().toISOString(), userId, kind]);
    },

    async listPasskeys(userId) {
      return (await many(q, 'SELECT * FROM user_passkeys WHERE user_id = $1 ORDER BY created_at, id', [userId])).map(asPasskey);
    },

    async findPasskey(credentialId) {
      const row = await one(q, 'SELECT * FROM user_passkeys WHERE id = $1', [credentialId]);
      return row ? asPasskey(row) : null;
    },

    async addPasskey(userId, p) {
      return (await changed(q, 'INSERT INTO user_passkeys (id, user_id, public_key, counter, transports, name, backed_up, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING', [p.id, userId, p.public_key, p.counter, p.transports ? JSON.stringify(p.transports) : null, p.name, p.backed_up ? 1 : 0, p.created_at])) === 1;
    },

    async touchPasskey(credentialId, counter, at) {
      await q('UPDATE user_passkeys SET counter = GREATEST(counter, $1), last_used_at = $2 WHERE id = $3', [counter, at, credentialId]);
    },

    async renamePasskey(userId, id, name) {
      return (await changed(q, 'UPDATE user_passkeys SET name = $1 WHERE id = $2 AND user_id = $3', [name, id, userId])) === 1;
    },

    async removePasskey(userId, id) {
      return (await changed(q, 'DELETE FROM user_passkeys WHERE id = $1 AND user_id = $2', [id, userId])) === 1;
    },

    async setPasskeyWrappedKey(userId, id, wrapped) {
      return (await changed(q, 'UPDATE user_passkeys SET wrapped_key = $1 WHERE id = $2 AND user_id = $3', [wrapped, id, userId])) === 1;
    },

    async getTotp(userId) {
      const row = await one<{ secret_enc: string; confirmed_at: string | null; last_step: number }>(q, 'SELECT secret_enc, confirmed_at, last_step FROM user_totp WHERE user_id = $1', [userId]);
      return row ? ({ ...row, last_step: Number(row.last_step) } as TotpRecord) : null;
    },

    // Replaces an unconfirmed enrolment; the WHERE leaves a confirmed one alone.
    async beginTotp(userId, secretEnc, now) {
      return (await changed(q, `INSERT INTO user_totp (user_id, secret_enc, created_at, confirmed_at, last_step) VALUES ($1, $2, $3, NULL, 0)
        ON CONFLICT (user_id) DO UPDATE SET secret_enc = excluded.secret_enc, created_at = excluded.created_at, last_step = 0
        WHERE user_totp.confirmed_at IS NULL`, [userId, secretEnc, now])) === 1;
    },

    async enableTotp(userId, step, codeHashes, now) {
      return begin(async run => {
        if ((await changed(run, 'UPDATE user_totp SET confirmed_at = $1, last_step = $2 WHERE user_id = $3 AND confirmed_at IS NULL', [now, step, userId])) === 0) return null;
        await run('DELETE FROM user_recovery_codes WHERE user_id = $1', [userId]);
        await insertCodes(run, userId, codeHashes);
        await bump(run, userId);
        return authVersion(run, userId);
      });
    },

    // Newer than anything accepted, and only for a confirmed enrolment: the replay guard, the check and the write one statement.
    async claimTotpStep(userId, step) {
      return (await changed(q, 'UPDATE user_totp SET last_step = $1 WHERE user_id = $2 AND confirmed_at IS NOT NULL AND last_step < $1', [step, userId])) === 1;
    },

    async useRecoveryCode(userId, codeHash, now) {
      return (await changed(q, 'UPDATE user_recovery_codes SET used_at = $1 WHERE user_id = $2 AND code_hash = $3 AND used_at IS NULL', [now, userId, codeHash])) === 1;
    },

    async replaceRecoveryCodes(userId, codeHashes) {
      await begin(async run => {
        await run('DELETE FROM user_recovery_codes WHERE user_id = $1', [userId]);
        await insertCodes(run, userId, codeHashes);
      });
    },

    async countRecoveryCodes(userId) {
      return Number((await one<{ n: number }>(q, 'SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id = $1 AND used_at IS NULL', [userId]))!.n);
    },

    async disableTotp(userId) {
      return begin(async run => {
        await run('DELETE FROM user_recovery_codes WHERE user_id = $1', [userId]);
        await run('DELETE FROM user_totp WHERE user_id = $1', [userId]);
        await bump(run, userId);
        return authVersion(run, userId);
      });
    },

    async delete(id) {
      await begin(async run => {
        for (const table of OWNED_TABLES) await run(`DELETE FROM ${table} WHERE user_id = $1`, [id]);
        await run('DELETE FROM users WHERE id = $1', [id]);
      });
    },
  };
}
