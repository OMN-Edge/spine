-- Idempotent: re-applied every boot. `CREATE TABLE IF NOT EXISTS` cannot alter an
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
  created_at TEXT NOT NULL
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
CREATE TABLE IF NOT EXISTS user_recovery_codes (
  user_id TEXT NOT NULL REFERENCES users(id),
  code_hash TEXT NOT NULL,
  used_at TEXT,
  PRIMARY KEY (user_id, code_hash)
);

-- Every table below carries user_id, and every query on it filters by it (P12).

CREATE TABLE IF NOT EXISTS source_files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  uploaded_at TEXT NOT NULL,
  original_filename TEXT,
  file_path TEXT NOT NULL,
  mime_type TEXT,
  page_count INTEGER,
  checksum TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'processing' | 'done' | 'error'
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  source_file_id TEXT NOT NULL REFERENCES source_files(id),
  page_number INTEGER NOT NULL,
  image_path TEXT NOT NULL,
  image_width INTEGER NOT NULL,
  image_height INTEGER NOT NULL,
  raw_text TEXT,
  elements TEXT, -- JSON array of UnstructuredElement[]
  extraction_source TEXT, -- 'native_text' | 'ocr' | 'mixed'
  is_continuation INTEGER, -- SQLite boolean
  continuation_confidence REAL,
  continuation_reasoning TEXT,
  reviewed INTEGER DEFAULT 0,
  UNIQUE(source_file_id, page_number)
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  source_file_id TEXT NOT NULL REFERENCES source_files(id),
  page_start INTEGER NOT NULL,
  page_end INTEGER NOT NULL,
  doc_date TEXT,
  provider TEXT,
  doc_type TEXT,
  ai_summary TEXT,
  user_notes TEXT,
  reviewed INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS extracted_fields (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  page_id TEXT NOT NULL REFERENCES pages(id),
  label TEXT NOT NULL,
  value TEXT NOT NULL,
  source_snippet TEXT,
  bbox_x0 REAL,
  bbox_y0 REAL,
  bbox_x1 REAL,
  bbox_y1 REAL,
  confidence REAL
);

-- Per-user vocabulary: a shared one would leak the existence of other users'
-- categories and let one user's rename affect another's records.
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS document_tags (
  user_id TEXT NOT NULL REFERENCES users(id),
  document_id TEXT REFERENCES documents(id),
  tag_id INTEGER REFERENCES tags(id),
  PRIMARY KEY (document_id, tag_id)
);

-- Search results are filtered by joining back to documents.user_id, so the index
-- itself can stay shared without leaking (see DocumentRepository.listFor).
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  doc_type, provider, ai_summary, user_notes,
  content='documents', content_rowid='rowid'
);

CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token TEXT UNIQUE NOT NULL, -- sha256 of the token, never the token (P6)
  label TEXT,
  scope TEXT NOT NULL, -- 'all' | 'tag' | 'document_ids' | 'date_range'
  scope_value TEXT, -- JSON
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked INTEGER DEFAULT 0,
  view_count INTEGER DEFAULT 0,
  last_accessed_at TEXT
);

CREATE TABLE IF NOT EXISTS share_link_access_log (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id), -- the link's owner
  share_link_id TEXT REFERENCES share_links(id),
  accessed_at TEXT NOT NULL,
  ip_address TEXT
);

CREATE INDEX IF NOT EXISTS idx_source_files_user ON source_files(user_id);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id, doc_date);
CREATE INDEX IF NOT EXISTS idx_share_links_user ON share_links(user_id);

-- FTS sync triggers
CREATE TRIGGER IF NOT EXISTS documents_fts_insert AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, doc_type, provider, ai_summary, user_notes)
  VALUES (new.rowid, new.doc_type, new.provider, new.ai_summary, new.user_notes);
END;

CREATE TRIGGER IF NOT EXISTS documents_fts_update AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, doc_type, provider, ai_summary, user_notes)
  VALUES ('delete', old.rowid, old.doc_type, old.provider, old.ai_summary, old.user_notes);
  INSERT INTO documents_fts(rowid, doc_type, provider, ai_summary, user_notes)
  VALUES (new.rowid, new.doc_type, new.provider, new.ai_summary, new.user_notes);
END;

CREATE TRIGGER IF NOT EXISTS documents_fts_delete AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, doc_type, provider, ai_summary, user_notes)
  VALUES ('delete', old.rowid, old.doc_type, old.provider, old.ai_summary, old.user_notes);
END;
