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
  error_message TEXT,
  -- An upload's documents are held back (out of the timeline, search, shares and trends) from when it is read until the
  -- owner confirms how its pages were grouped. 1 for uploads made before this, for restores and for anything the owner has confirmed.
  grouping_confirmed INTEGER NOT NULL DEFAULT 1,
  -- The conversation the file was attached in, if it was attached in the chat: what happens to it is reported there.
  chat_conversation_id TEXT
);

-- What the analysis of a mixed upload found: which pages belong together (JSON, see regroup/analyze.ts). One per upload, replaced
-- when the analysis is run again and dropped when the upload is read again or regrouped, since its page ids would no longer mean the same.
CREATE TABLE IF NOT EXISTS regroup_plans (
  source_file_id TEXT PRIMARY KEY REFERENCES source_files(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  plan TEXT NOT NULL
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
  language TEXT, -- what the document is written in (a two-letter code), as extraction found it; null if unknown
  -- The headline columns (title, doc_date, provider, doc_type, ai_summary) the owner has set, comma separated. Reading the
  -- document again leaves them as they are.
  owner_edited TEXT NOT NULL DEFAULT ''
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
  confidence REAL,
  owner_edited INTEGER NOT NULL DEFAULT 0 -- 1: the owner added or changed it; reading the document again keeps it
);

-- What the owner removed from a document's reading, so reading it again does not bring it back. `key` says which value
-- (store/reading-keys.ts); `kind` is 'field' or 'measurement'.
CREATE TABLE IF NOT EXISTS removed_readings (
  user_id TEXT NOT NULL REFERENCES users(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  PRIMARY KEY (document_id, kind, key)
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
  -- The professional code this document printed for the doctor, if it did. The directory holds one code per doctor, so when a
  -- document prints another the difference is only visible here; the owner is asked about it (matching/).
  printed_code TEXT,
  PRIMARY KEY (document_id, doctor_id, role)
);

-- What the owner answered when asked whether two entries are the same: kept so the question is not asked again. `kind` is doctor,
-- test, tag, provider or code (a doctor's code the owner chose to keep). `pair_key` names the pair (sorted, so order does not matter).
CREATE TABLE IF NOT EXISTS match_decisions (
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  pair_key TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  PRIMARY KEY (user_id, kind, pair_key)
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
  confidence REAL,
  owner_edited INTEGER NOT NULL DEFAULT 0 -- 1: the owner added or changed it; reading the document again keeps it
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
  language TEXT, -- the language the recipient's page starts in, if the owner chose one
  require_approval INTEGER NOT NULL DEFAULT 0, -- 1: a visitor's browser must be approved by the owner before it reads anything
  allow_chat INTEGER NOT NULL DEFAULT 0 -- 1: the recipient may ask questions about what the link shares
);

-- A visitor's browser asking to open a link that needs approval. `visitor_hash` is sha256 of a random value held in
-- that browser's cookie (never stored raw, P6): the approval belongs to that browser and works nowhere else. One row
-- per link and browser. `note`, `ip_address` and `user_agent` come from the visitor and are shown to the owner as text.
CREATE TABLE IF NOT EXISTS share_access_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id), -- the link's owner
  share_link_id TEXT NOT NULL REFERENCES share_links(id),
  visitor_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'denied'
  note TEXT,
  ip_address TEXT,
  user_agent TEXT,
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  UNIQUE (share_link_id, visitor_hash)
);

-- What happened to a link after it was made: changed (what, from, to), revoked, a request approved or denied. The owner reads it
-- to see what access a link has had. `detail` is JSON of small values (never a token, a note or a document's text).
CREATE TABLE IF NOT EXISTS share_link_events (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  share_link_id TEXT NOT NULL REFERENCES share_links(id),
  at TEXT NOT NULL,
  kind TEXT NOT NULL, -- 'created' | 'changed' | 'revoked' | 'approved' | 'denied'
  detail TEXT
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

-- A link between two of the owner's documents: the earlier asked for the later (`requests`), the later follows up the
-- earlier (`follow_up`), or both belong to one episode (`same_episode`, stored once with the earlier first). `source`
-- says who made it; an automatic link starts `proposed` and the owner confirms or dismisses it, and a dismissed pair is
-- never proposed again. Re-reading replaces only the proposed automatic links of a document. Regenerable except for the
-- owner's decisions, so it is not exported.
CREATE TABLE IF NOT EXISTS document_links (
  user_id TEXT NOT NULL REFERENCES users(id),
  from_document_id TEXT NOT NULL REFERENCES documents(id),
  to_document_id TEXT NOT NULL REFERENCES documents(id),
  kind TEXT NOT NULL CHECK (kind IN ('requests', 'follow_up', 'same_episode')),
  source TEXT NOT NULL CHECK (source IN ('auto', 'owner')),
  state TEXT NOT NULL CHECK (state IN ('proposed', 'confirmed', 'dismissed')),
  reason TEXT,
  confidence REAL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_document_id, to_document_id, kind),
  CHECK (from_document_id <> to_document_id)
);
CREATE INDEX IF NOT EXISTS idx_document_links_user ON document_links(user_id);
CREATE INDEX IF NOT EXISTS idx_document_links_to ON document_links(to_document_id);

-- The owner's conversations with the chat. Questions and answers are medical text, so they are the owner's like their
-- documents: scoped by user_id, deleted with the account, never in a share link, and not exported. `sources` is a JSON
-- list of the documents an answer cited (id, title, section); `note` is set for a reply with nothing to say.
CREATE TABLE IF NOT EXISTS chat_conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  unread INTEGER NOT NULL DEFAULT 0, -- 1: the assistant started it (an upload finished) and the owner has not opened it
  origin TEXT -- null: the owner started it; 'upload': the app did, when an upload finished
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  sources TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  kind TEXT, -- null: ordinary text; 'upload': a notice the app wrote, drawn by the page from `data`
  data TEXT -- JSON for a notice
);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_user ON chat_conversations(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(conversation_id, seq);

CREATE INDEX IF NOT EXISTS idx_source_files_user ON source_files(user_id);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id, doc_date);
CREATE INDEX IF NOT EXISTS idx_share_links_user ON share_links(user_id);
CREATE INDEX IF NOT EXISTS idx_share_events_link ON share_link_events(share_link_id, at);
CREATE INDEX IF NOT EXISTS idx_share_requests_user ON share_access_requests(user_id, status);

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
