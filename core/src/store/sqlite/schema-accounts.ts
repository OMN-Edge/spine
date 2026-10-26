/** The SQL of this schema (see ARCHITECTURE.md, the schema files): idempotent \`CREATE TABLE IF NOT EXISTS\`, applied whenever a database is opened. */
export const accountsSchema = `-- Idempotent: re-applied every boot. \`CREATE TABLE IF NOT EXISTS\` cannot alter an
-- existing table, so a change to a table that already exists means recreating the
-- database, which is only safe while it holds nothing (SECURITY.md M-10).

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL, -- argon2id
  -- Bumped on a password change. A session records the value it was issued under
  -- and is refused once it no longer matches, which is how a password change ends
  -- the user's other sessions (P13).
  auth_version INTEGER NOT NULL DEFAULT 0,
  -- NULL until the address is confirmed. An unverified account never gets a
  -- session. Accounts the operator creates are verified at creation.
  email_verified_at TEXT,
  created_at TEXT NOT NULL,
  -- Consent to process health data (GDPR Art. 9(2)(a)) and acceptance of the terms: separate acts, each with the version of the
  -- text that was shown. NULL until given; an account without them is held at the consent screen (CR-GDPR-01).
  health_consent_at TEXT,
  health_consent_version TEXT,
  terms_accepted_at TEXT,
  terms_version TEXT
);

-- One-time links for email verification and password reset. Only the sha256 of
-- the token is stored, and consuming one is a single atomic UPDATE (P6).
CREATE TABLE IF NOT EXISTS user_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL, -- 'verify' | 'reset'
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- Second factor (SECURITY.md M-12). New tables rather than columns on users, because
-- CREATE TABLE IF NOT EXISTS can add these to an existing database and cannot alter users.
-- A row exists from the moment enrolment starts; the factor only applies once
-- confirmed_at is set, which needs a valid first code.
CREATE TABLE IF NOT EXISTS user_totp (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  secret_enc TEXT NOT NULL, -- AES-256-GCM; recoverable by design, see totp.ts
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  last_step INTEGER NOT NULL DEFAULT 0 -- newest time step accepted; blocks replay
);

-- sha256 of each recovery code. A code is spent by one atomic UPDATE.
-- A passkey (WebAuthn credential) the person signed up on a device with. The public key is all that is kept; the private key never
-- leaves the device. \`id\` is the credential id (base64url), unique across accounts. A passkey with user verification (a fingerprint,
-- a face, a device PIN) is a sign-in in itself and stands in for the password and the second factor together.
CREATE TABLE IF NOT EXISTS user_passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  public_key TEXT NOT NULL, -- COSE key, base64url
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,          -- JSON array or NULL
  name TEXT NOT NULL,
  backed_up INTEGER NOT NULL DEFAULT 0, -- synced between the person's devices (iCloud Keychain, Google Password Manager)
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  wrapped_key TEXT          -- the account key sealed under a key the passkey's PRF output makes on the device; ciphertext, NULL when this passkey does not open the vault
);
CREATE INDEX IF NOT EXISTS idx_user_passkeys_user ON user_passkeys(user_id);

CREATE TABLE IF NOT EXISTS user_recovery_codes (
  user_id TEXT NOT NULL REFERENCES users(id),
  code_hash TEXT NOT NULL,
  used_at TEXT,
  PRIMARY KEY (user_id, code_hash)
);

-- A sign-in the owner can see and end (SECURITY.md S-33). The cookie session itself is in memory; this row is what
-- makes it valid: a request whose session id has no row here, or whose row is past its idle or absolute limit, is
-- signed out. \`user_agent\` and \`address\` are what the connection reported and prove nothing.
CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);

-- Model calls the relay has allowed an account's device, a row a day; the relay counts here in whichever store it is
-- configured with, which need not be the server's (so no foreign key). Only a number, never what was asked.
CREATE TABLE IF NOT EXISTS model_usage (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  calls INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);

-- sha256 of a random cookie each browser holds, to tell "a browser this account has signed in from" from a new one,
-- so a new one can be mailed about. Not a credential: it grants nothing by itself.
CREATE TABLE IF NOT EXISTS user_devices (
  user_id TEXT NOT NULL REFERENCES users(id),
  device_hash TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (user_id, device_hash)
);

-- The zero-knowledge vault (docs/crypto-design.md). The server keeps what it cannot read: the account key wrapped twice (by the key the
-- person's password makes on their device, and by the recovery key they hold on paper), the X25519 pair, and sealed objects. A row here is
-- the only record that an account has a vault; an account without one is asked to make one at its next sign-in. \`seq\` is the newest
-- change number handed out for this account, which is how a device asks for "what changed since".
CREATE TABLE IF NOT EXISTS vault_keys (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  kdf_salt TEXT NOT NULL,            -- base64url, 16 random bytes
  kdf_params TEXT NOT NULL,          -- JSON: the Argon2id cost the device used, so another device derives the same key
  wrapped_by_master TEXT NOT NULL,   -- the account key, sealed under the master key
  wrapped_by_recovery TEXT NOT NULL, -- the account key, sealed under the recovery key
  public_key TEXT NOT NULL,          -- X25519, base64url
  wrapped_private_key TEXT NOT NULL, -- sealed under the account key
  seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One sealed object: its ciphertext is a file beside the others (vault/<user>/<id>), and what is kept here is what a server needs to
-- move it around and nothing it could read. \`kind\` is coarse (bundle, blob, library, embedding); \`profile_id\` is an opaque id.
CREATE TABLE IF NOT EXISTS vault_objects (
  user_id TEXT NOT NULL REFERENCES users(id),
  id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  seq INTEGER NOT NULL,
  size INTEGER NOT NULL,
  wrapped_key TEXT NOT NULL,         -- the object's data key, sealed under the profile key
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_vault_objects_seq ON vault_objects(user_id, seq);

-- A link's sealed copy of the records it shares (docs/crypto-design.md, stage 4). The server holds bytes it cannot open: the key is
-- in the address after the # (or goes to one browser, wrapped to its own key, when the owner approves). Nothing here says what is
-- shared. \`shared_requests\` and \`shared_opens\` are what the recipient's browser did, kept only until the owner's device collects them.
CREATE TABLE IF NOT EXISTS shared_bundles (
  id TEXT PRIMARY KEY, -- random, in the link
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  require_approval INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0, -- the sealed database
  blobs INTEGER NOT NULL DEFAULT 0, -- sealed files beside it (page images)
  blob_bytes INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS shared_requests (
  id TEXT PRIMARY KEY,
  bundle_id TEXT NOT NULL REFERENCES shared_bundles(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  visitor_key TEXT NOT NULL, -- the visitor browser's public key; the share key is wrapped to it on approval
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'denied'
  wrapped_key TEXT, -- the share key sealed to visitor_key: only that browser can open it
  note TEXT,
  country TEXT,
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  pulled INTEGER NOT NULL DEFAULT 0, -- 1: the owner's device has collected it
  UNIQUE (bundle_id, visitor_key)
);

CREATE TABLE IF NOT EXISTS shared_opens (
  id INTEGER PRIMARY KEY,
  bundle_id TEXT NOT NULL REFERENCES shared_bundles(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  at TEXT NOT NULL,
  country TEXT,
  document_id TEXT, -- the id inside the sealed copy of a document the recipient opened; null for opening the link
  count_view INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_shared_bundles_user ON shared_bundles(user_id);
CREATE INDEX IF NOT EXISTS idx_shared_requests_user ON shared_requests(user_id, pulled);
CREATE INDEX IF NOT EXISTS idx_shared_opens_user ON shared_opens(user_id);
`;
