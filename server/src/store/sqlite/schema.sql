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
  hidden INTEGER NOT NULL DEFAULT 0, -- 1: kept, but left out of the document's view, search and reading
  source_page INTEGER NOT NULL DEFAULT 0, -- the page's index in the file, which reading it again needs; page_number is its place in the upload, which the owner can change
  extraction_source TEXT, -- 'native_text' | 'ocr' | 'mixed' | 'multimodal' | 'unread' (the model could not read it and nothing else did)
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
  -- The document's own title if it prints one, otherwise one extraction made up; the
  -- owner can edit it. What the UI shows instead of the upload's file name.
  title TEXT,
  doc_date TEXT,
  provider TEXT,
  doc_type TEXT,
  ai_summary TEXT,
  user_notes TEXT,
  reviewed INTEGER DEFAULT 0,
  language TEXT -- what the document is written in (a two-letter code), as extraction found it; null if unknown
);

-- Numeric results (lab values, vitals): what trends over time are drawn from. A field is
-- text to read; a measurement is a number with a unit that can be compared across documents.
CREATE TABLE IF NOT EXISTS measurements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  page_id TEXT NOT NULL REFERENCES pages(id),
  name TEXT NOT NULL,        -- as printed: "Hemoglobina"
  canonical TEXT NOT NULL,   -- the same test under one name: "hemoglobin"; what a trend groups by
  value_text TEXT NOT NULL,  -- as printed: "13,5", "<0.5", "pozitiv"
  value_num REAL,            -- NULL unless it is a plain number
  unit TEXT,
  ref_low REAL,
  ref_high REAL,
  flag TEXT,                 -- 'low' | 'high' | 'normal' | NULL
  taken_on TEXT,             -- YYYY-MM-DD: the document's date, or the row's own if it has one
  source_snippet TEXT,
  bbox_x0 REAL,
  bbox_y0 REAL,
  bbox_x1 REAL,
  bbox_y1 REAL,
  confidence REAL
);

-- People who appear on documents, built up as documents are read. `key` is the name with
-- titles, accents, case and word order removed, so "Dr. Popescu Ion" and "Ion Popescu" are one.
-- "These two names are one test": once a person merges two tests, later documents that use the old
-- name are filed under the new one. `canonical` is always a name that measurements use.
CREATE TABLE IF NOT EXISTS measurement_aliases (
  user_id TEXT NOT NULL REFERENCES users(id),
  alias TEXT NOT NULL,
  canonical TEXT NOT NULL,
  PRIMARY KEY (user_id, alias)
);

CREATE TABLE IF NOT EXISTS doctors (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  key TEXT NOT NULL,
  specialty TEXT,
  clinic TEXT,
  -- The professional code printed under a signature ("Cod X12345"), upper case without punctuation.
  -- One doctor per code, so two spellings of one name that carry the same code are one person.
  license_code TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, key)
);
CREATE UNIQUE INDEX IF NOT EXISTS doctors_license_code ON doctors(user_id, license_code) WHERE license_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS document_doctors (
  user_id TEXT NOT NULL REFERENCES users(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  doctor_id TEXT NOT NULL REFERENCES doctors(id),
  role TEXT NOT NULL, -- 'author' | 'prescriber' | 'referrer' | 'other'
  -- Where the link came from: 'text' (the document's text, or the owner) or 'stamp' (a signature stamp read
  -- from an image). Reading the text again replaces only the first, so it cannot erase what an image gave.
  source TEXT NOT NULL DEFAULT 'text',
  PRIMARY KEY (document_id, doctor_id, role)
);

CREATE TABLE IF NOT EXISTS extracted_fields (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  page_id TEXT NOT NULL REFERENCES pages(id),
  label TEXT NOT NULL,
  value TEXT NOT NULL,
  -- Fields that belong together share a number within a document: the drug, dose and
  -- frequency of one prescription line, or one vaccine's name, lot and site. NULL = on its own.
  group_no INTEGER,
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

-- Search: one row per document, holding what a person would type to find it: its title, type,
-- provider, summary and notes, and in `body` the text of its pages, its extracted values, its
-- measurements' names and its doctors' names. Kept in step by the triggers below, so no code path can
-- change one of those and forget the index. Results are filtered by joining back to documents.user_id,
-- and `body` is built only from that user's rows, so the index itself leaks nothing (M-2).
-- Accents are folded ("lombara" finds "lombară").
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  title, doc_type, provider, ai_summary, user_notes, body,
  tokenize = 'unicode61 remove_diacritics 2'
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
  last_accessed_at TEXT,
  include_scans INTEGER NOT NULL DEFAULT 0, -- 1: the recipient may also see the page images
  language TEXT -- the language the recipient's page starts in, if the owner chose one
);

CREATE TABLE IF NOT EXISTS share_link_access_log (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id), -- the link's owner
  share_link_id TEXT REFERENCES share_links(id),
  accessed_at TEXT NOT NULL,
  ip_address TEXT
);

-- A document's extracted details and the owner's notes, translated into another language, kept so the
-- next reader gets them at once. `source_hash` is a digest of exactly what was translated: a translation
-- is used only while the document still hashes to it, so re-extracting, editing or moving pages makes
-- it stale by itself, with nothing to remember to invalidate.
CREATE TABLE IF NOT EXISTS document_translations (
  user_id TEXT NOT NULL REFERENCES users(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  language TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  content TEXT NOT NULL, -- JSON
  created_at TEXT NOT NULL,
  PRIMARY KEY (document_id, language)
);

-- A document's meaning as a vector, for finding what resembles it. `model` names the vector space (vectors of
-- different models are never compared, so each is kept with the model that made it), and `text_hash` is a digest of
-- exactly the text that was embedded: a vector is used only while the document still produces that text, so editing
-- or re-reading a document makes it stale by itself. Regenerable from the rest of the database, so nothing here is
-- exported.
CREATE TABLE IF NOT EXISTS document_embeddings (
  user_id TEXT NOT NULL REFERENCES users(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  text_hash TEXT NOT NULL,
  vector BLOB NOT NULL, -- float32, little endian
  created_at TEXT NOT NULL,
  PRIMARY KEY (document_id, model)
);

CREATE INDEX IF NOT EXISTS idx_source_files_user ON source_files(user_id);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id, doc_date);
CREATE INDEX IF NOT EXISTS idx_share_links_user ON share_links(user_id);

-- Search index. The view is what one document contributes; each trigger rebuilds the rows of the
-- documents a change touches.
CREATE VIEW IF NOT EXISTS document_search_source AS
SELECT d.rowid AS id, d.title, d.doc_type, d.provider, d.ai_summary, d.user_notes,
  COALESCE((SELECT group_concat(p.raw_text, ' ') FROM pages p
            WHERE p.source_file_id = d.source_file_id AND p.user_id = d.user_id
              AND p.page_number BETWEEN d.page_start AND d.page_end AND p.hidden = 0), '') || ' ' ||
  COALESCE((SELECT group_concat(f.value, ' ') FROM extracted_fields f
            WHERE f.document_id = d.id AND f.user_id = d.user_id), '') || ' ' ||
  COALESCE((SELECT group_concat(m.name || ' ' || m.value_text, ' ') FROM measurements m
            WHERE m.document_id = d.id AND m.user_id = d.user_id), '') || ' ' ||
  COALESCE((SELECT group_concat(k.name, ' ') FROM document_doctors l
            JOIN doctors k ON k.id = l.doctor_id AND k.user_id = l.user_id
            WHERE l.document_id = d.id AND l.user_id = d.user_id), '') AS body
FROM documents d;

CREATE TRIGGER IF NOT EXISTS documents_fts_insert AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, title, doc_type, provider, ai_summary, user_notes, body)
  SELECT id, title, doc_type, provider, ai_summary, user_notes, body FROM document_search_source WHERE id = new.rowid;
END;
CREATE TRIGGER IF NOT EXISTS documents_fts_update AFTER UPDATE ON documents BEGIN
  DELETE FROM documents_fts WHERE rowid = new.rowid;
  INSERT INTO documents_fts(rowid, title, doc_type, provider, ai_summary, user_notes, body)
  SELECT id, title, doc_type, provider, ai_summary, user_notes, body FROM document_search_source WHERE id = new.rowid;
END;
CREATE TRIGGER IF NOT EXISTS documents_fts_delete AFTER DELETE ON documents BEGIN
  DELETE FROM documents_fts WHERE rowid = old.rowid;
END;

-- A page belongs to the documents of its upload whose page range holds it.
CREATE TRIGGER IF NOT EXISTS pages_fts_insert AFTER INSERT ON pages BEGIN
  DELETE FROM documents_fts WHERE rowid IN (SELECT rowid FROM documents WHERE source_file_id = new.source_file_id AND user_id = new.user_id AND new.page_number BETWEEN page_start AND page_end);
  INSERT INTO documents_fts(rowid, title, doc_type, provider, ai_summary, user_notes, body)
  SELECT id, title, doc_type, provider, ai_summary, user_notes, body FROM document_search_source
  WHERE id IN (SELECT rowid FROM documents WHERE source_file_id = new.source_file_id AND user_id = new.user_id AND new.page_number BETWEEN page_start AND page_end);
END;
CREATE TRIGGER IF NOT EXISTS pages_fts_update AFTER UPDATE OF raw_text, hidden ON pages BEGIN
  DELETE FROM documents_fts WHERE rowid IN (SELECT rowid FROM documents WHERE source_file_id = new.source_file_id AND user_id = new.user_id AND new.page_number BETWEEN page_start AND page_end);
  INSERT INTO documents_fts(rowid, title, doc_type, provider, ai_summary, user_notes, body)
  SELECT id, title, doc_type, provider, ai_summary, user_notes, body FROM document_search_source
  WHERE id IN (SELECT rowid FROM documents WHERE source_file_id = new.source_file_id AND user_id = new.user_id AND new.page_number BETWEEN page_start AND page_end);
END;
CREATE TRIGGER IF NOT EXISTS pages_fts_delete AFTER DELETE ON pages BEGIN
  DELETE FROM documents_fts WHERE rowid IN (SELECT rowid FROM documents WHERE source_file_id = old.source_file_id AND user_id = old.user_id AND old.page_number BETWEEN page_start AND page_end);
  INSERT INTO documents_fts(rowid, title, doc_type, provider, ai_summary, user_notes, body)
  SELECT id, title, doc_type, provider, ai_summary, user_notes, body FROM document_search_source
  WHERE id IN (SELECT rowid FROM documents WHERE source_file_id = old.source_file_id AND user_id = old.user_id AND old.page_number BETWEEN page_start AND page_end);
END;

CREATE TRIGGER IF NOT EXISTS fields_fts_insert AFTER INSERT ON extracted_fields BEGIN
  DELETE FROM documents_fts WHERE rowid = (SELECT rowid FROM documents WHERE id = new.document_id);
  INSERT INTO documents_fts(rowid, title, doc_type, provider, ai_summary, user_notes, body)
  SELECT id, title, doc_type, provider, ai_summary, user_notes, body FROM document_search_source WHERE id = (SELECT rowid FROM documents WHERE id = new.document_id);
END;
CREATE TRIGGER IF NOT EXISTS fields_fts_update AFTER UPDATE ON extracted_fields BEGIN
  DELETE FROM documents_fts WHERE rowid = (SELECT rowid FROM documents WHERE id = new.document_id);
  INSERT INTO documents_fts(rowid, title, doc_type, provider, ai_summary, user_notes, body)
  SELECT id, title, doc_type, provider, ai_summary, user_notes, body FROM document_search_source WHERE id = (SELECT rowid FROM documents WHERE id = new.document_id);
END;
CREATE TRIGGER IF NOT EXISTS fields_fts_delete AFTER DELETE ON extracted_fields BEGIN
  DELETE FROM documents_fts WHERE rowid = (SELECT rowid FROM documents WHERE id = old.document_id);
  INSERT INTO documents_fts(rowid, title, doc_type, provider, ai_summary, user_notes, body)
  SELECT id, title, doc_type, provider, ai_summary, user_notes, body FROM document_search_source WHERE id = (SELECT rowid FROM documents WHERE id = old.document_id);
END;

CREATE TRIGGER IF NOT EXISTS measurements_fts_insert AFTER INSERT ON measurements BEGIN
  DELETE FROM documents_fts WHERE rowid = (SELECT rowid FROM documents WHERE id = new.document_id);
  INSERT INTO documents_fts(rowid, title, doc_type, provider, ai_summary, user_notes, body)
  SELECT id, title, doc_type, provider, ai_summary, user_notes, body FROM document_search_source WHERE id = (SELECT rowid FROM documents WHERE id = new.document_id);
END;
CREATE TRIGGER IF NOT EXISTS measurements_fts_update AFTER UPDATE ON measurements BEGIN
  DELETE FROM documents_fts WHERE rowid IN (SELECT rowid FROM documents WHERE id IN (new.document_id, old.document_id));
  INSERT INTO documents_fts(rowid, title, doc_type, provider, ai_summary, user_notes, body)
  SELECT id, title, doc_type, provider, ai_summary, user_notes, body FROM document_search_source WHERE id IN (SELECT rowid FROM documents WHERE id IN (new.document_id, old.document_id));
END;
CREATE TRIGGER IF NOT EXISTS measurements_fts_delete AFTER DELETE ON measurements BEGIN
  DELETE FROM documents_fts WHERE rowid = (SELECT rowid FROM documents WHERE id = old.document_id);
  INSERT INTO documents_fts(rowid, title, doc_type, provider, ai_summary, user_notes, body)
  SELECT id, title, doc_type, provider, ai_summary, user_notes, body FROM document_search_source WHERE id = (SELECT rowid FROM documents WHERE id = old.document_id);
END;

CREATE TRIGGER IF NOT EXISTS doctors_link_fts_insert AFTER INSERT ON document_doctors BEGIN
  DELETE FROM documents_fts WHERE rowid = (SELECT rowid FROM documents WHERE id = new.document_id);
  INSERT INTO documents_fts(rowid, title, doc_type, provider, ai_summary, user_notes, body)
  SELECT id, title, doc_type, provider, ai_summary, user_notes, body FROM document_search_source WHERE id = (SELECT rowid FROM documents WHERE id = new.document_id);
END;
CREATE TRIGGER IF NOT EXISTS doctors_link_fts_delete AFTER DELETE ON document_doctors BEGIN
  DELETE FROM documents_fts WHERE rowid = (SELECT rowid FROM documents WHERE id = old.document_id);
  INSERT INTO documents_fts(rowid, title, doc_type, provider, ai_summary, user_notes, body)
  SELECT id, title, doc_type, provider, ai_summary, user_notes, body FROM document_search_source WHERE id = (SELECT rowid FROM documents WHERE id = old.document_id);
END;
-- Renaming a doctor changes what every document naming them says.
CREATE TRIGGER IF NOT EXISTS doctors_fts_update AFTER UPDATE OF name ON doctors BEGIN
  DELETE FROM documents_fts WHERE rowid IN (SELECT d.rowid FROM documents d JOIN document_doctors l ON l.document_id = d.id WHERE l.doctor_id = new.id);
  INSERT INTO documents_fts(rowid, title, doc_type, provider, ai_summary, user_notes, body)
  SELECT id, title, doc_type, provider, ai_summary, user_notes, body FROM document_search_source
  WHERE id IN (SELECT d.rowid FROM documents d JOIN document_doctors l ON l.document_id = d.id WHERE l.doctor_id = new.id);
END;
