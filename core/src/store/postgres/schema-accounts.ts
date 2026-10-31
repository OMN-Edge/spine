/**
 * The accounts' tables for Postgres: the same tables and columns as `sqlite/schema-accounts.ts`, so a repository reads the same row in
 * either. A flag is an integer (0 or 1) and a time is the ISO text the application writes, as there, so no code converts between engines.
 * What differs is the engine's own: an e-mail address is unique ignoring case through an index (SQLite's `COLLATE NOCASE`), a counter that
 * the engine hands out is `BIGSERIAL`, and sizes are `BIGINT` because a total of them passes two gigabytes.
 *
 * Idempotent `CREATE TABLE IF NOT EXISTS`, applied at every start under an advisory lock (two instances starting together must not both
 * run it). It cannot alter a table: a column added later is added with `ADD COLUMN IF NOT EXISTS` in `postgres/store.ts`, before this runs.
 */
export const accountsSchema = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  auth_version INTEGER NOT NULL DEFAULT 0,
  email_verified_at TEXT,
  approved INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  health_consent_at TEXT,
  health_consent_version TEXT,
  terms_accepted_at TEXT,
  terms_version TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (lower(email));

CREATE TABLE IF NOT EXISTS user_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS user_totp (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  secret_enc TEXT NOT NULL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  last_step BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  public_key TEXT NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  transports TEXT,
  name TEXT NOT NULL,
  backed_up INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  wrapped_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_passkeys_user ON user_passkeys(user_id);

CREATE TABLE IF NOT EXISTS device_enrolments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  wrapped TEXT NOT NULL,
  auth_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'offered',
  token_hash TEXT,
  requested_at TEXT,
  requester_agent TEXT,
  requester_country TEXT
);
CREATE INDEX IF NOT EXISTS idx_device_enrolments_user ON device_enrolments(user_id);

CREATE TABLE IF NOT EXISTS user_recovery_codes (
  user_id TEXT NOT NULL REFERENCES users(id),
  code_hash TEXT NOT NULL,
  used_at TEXT,
  PRIMARY KEY (user_id, code_hash)
);

CREATE TABLE IF NOT EXISTS cookie_sessions (
  sid_hash TEXT PRIMARY KEY,
  user_id TEXT,
  data TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cookie_sessions_user ON cookie_sessions(user_id);

CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);

CREATE TABLE IF NOT EXISTS model_usage (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  calls BIGINT NOT NULL,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS user_devices (
  user_id TEXT NOT NULL REFERENCES users(id),
  device_hash TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (user_id, device_hash)
);

CREATE TABLE IF NOT EXISTS vault_keys (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  kdf_salt TEXT NOT NULL,
  kdf_params TEXT NOT NULL,
  wrapped_by_master TEXT NOT NULL,
  wrapped_by_recovery TEXT NOT NULL,
  public_key TEXT NOT NULL,
  wrapped_private_key TEXT NOT NULL,
  seq BIGINT NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_objects (
  user_id TEXT NOT NULL REFERENCES users(id),
  id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  seq BIGINT NOT NULL,
  size BIGINT NOT NULL,
  wrapped_key TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_vault_objects_seq ON vault_objects(user_id, seq);

CREATE TABLE IF NOT EXISTS shared_bundles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  require_approval INTEGER NOT NULL DEFAULT 0,
  size BIGINT NOT NULL DEFAULT 0,
  blobs INTEGER NOT NULL DEFAULT 0,
  blob_bytes BIGINT NOT NULL DEFAULT 0,
  revoked_at TEXT,
  kind TEXT NOT NULL DEFAULT 'share' -- 'share' | 'card' (the owner's emergency card: one, with no end)
);
ALTER TABLE shared_bundles ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'share';

CREATE TABLE IF NOT EXISTS shared_requests (
  id TEXT PRIMARY KEY,
  bundle_id TEXT NOT NULL REFERENCES shared_bundles(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  visitor_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  wrapped_key TEXT,
  note TEXT,
  country TEXT,
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  pulled INTEGER NOT NULL DEFAULT 0,
  UNIQUE (bundle_id, visitor_key)
);

CREATE TABLE IF NOT EXISTS shared_opens (
  id BIGSERIAL PRIMARY KEY,
  bundle_id TEXT NOT NULL REFERENCES shared_bundles(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  at TEXT NOT NULL,
  country TEXT,
  document_id TEXT,
  count_view INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_shared_bundles_user ON shared_bundles(user_id);
CREATE INDEX IF NOT EXISTS idx_shared_requests_user ON shared_requests(user_id, pulled);
CREATE INDEX IF NOT EXISTS idx_shared_opens_user ON shared_opens(user_id);

-- What an account pays for (docs/billing.md, SECURITY.md M-45). One row per account, written by the payment provider's webhooks and by the
-- operator's CLI. No card number and no address is ever here: the provider keeps those; this keeps only which plan, until when.
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  provider TEXT NOT NULL, -- 'paddle' | 'operator'
  customer_id TEXT,
  subscription_id TEXT,
  billing_interval TEXT, -- 'month' | 'year'
  status TEXT NOT NULL,
  founding INTEGER NOT NULL DEFAULT 0,
  current_period_end TEXT,
  cancel_scheduled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_subscription ON subscriptions(subscription_id) WHERE subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(customer_id);

-- The ids of the provider's events already applied, so a delivery repeated is applied once. Pruned after a few weeks.
CREATE TABLE IF NOT EXISTS billing_events (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL
);

-- AI processing an account has used in a period ('trial', or 'YYYY-MM'), in thousandths of a page. Only a number, never what was read.
CREATE TABLE IF NOT EXISTS ai_usage (
  user_id TEXT NOT NULL,
  period TEXT NOT NULL,
  amount BIGINT NOT NULL,
  PRIMARY KEY (user_id, period)
);

-- Whether the loops in the marketing plan work: a sign-up that came from a shared page, a share opened. A number a day under a name, never who.
CREATE TABLE IF NOT EXISTS metrics (
  name TEXT NOT NULL,
  day TEXT NOT NULL,
  n BIGINT NOT NULL,
  PRIMARY KEY (name, day)
);

-- People who asked to be told when Spine opens: an address and a time, not accounts.
CREATE TABLE IF NOT EXISTS waitlist (
  email TEXT NOT NULL ,
  created_at TEXT NOT NULL,
  source TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_email ON waitlist (lower(email));

-- Another account's access to one profile of an owner's vault (SECURITY.md M-49). An invitation holds the profile key sealed under a key that
-- only the code makes (the server holds an id and a hash of a proof it cannot reverse); a grant holds it sealed to the delegate's public key.
CREATE TABLE IF NOT EXISTS profile_invites (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  profile_id TEXT NOT NULL,
  role TEXT NOT NULL,
  wrapped TEXT NOT NULL,
  proof_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'offered'
);
CREATE INDEX IF NOT EXISTS idx_profile_invites_owner ON profile_invites(owner_user_id);

CREATE TABLE IF NOT EXISTS delegations (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  profile_id TEXT NOT NULL,
  delegate_user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  wrapped_key TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delegations_owner ON delegations(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_delegations_delegate ON delegations(delegate_user_id);
`;
