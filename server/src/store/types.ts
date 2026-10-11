import type {
  Document,
  DocType,
  ExtractedField,
  Page,
  ShareLink,
  SourceFile,
  UnstructuredElement,
} from '../types.js';

/**
 * The store interface.
 *
 * SECURITY.md P12 — isolation is structural, not remembered. Every method takes
 * the acting user's id and scopes its query by owner. There is deliberately no
 * `find(id)` without a user: a method that *can* return a row the acting user
 * does not own is a defect, and the absence of such a signature is what makes
 * that checkable at review time rather than at runtime. Route handlers cannot
 * write queries, so isolation cannot be forgotten in one.
 *
 * What a method does with a record the user does not own:
 *  - a read returns null or an empty list, indistinguishable from "not found";
 *  - an update or delete changes nothing (and `revoke` says so by returning false);
 *  - a create that names such a record throws, because silently dropping a create
 *    would lose data. Ids are server-issued, so this is a bug at the call site.
 * Routes check existence first and answer 404, never 403, so a record cannot be
 * probed for.
 *
 * **Every method is async even though the only adapter is synchronous.** That
 * is the point of the interface: a networked store is async, and a synchronous
 * interface would weld it to `better-sqlite3`. The SQLite adapter returns
 * already-resolved values, which costs a microtask per call.
 *
 * Four exceptions to the user-scoping rule, each named here so that a fifth
 * has to be argued for:
 *
 *  1. `shareLinks.findLiveByTokenHash` and `documents.listForShare` — scoped by
 *     the *link's* owner, resolved from the token, never from a session (P12).
 *  2. `shareLinks.logAccess` — the caller is an unauthenticated reader by
 *     definition (P7).
 *  3. `maintenance.*` — boot-time operations across all rows, run by the
 *     process itself with no acting user.
 *  4. `users.*` — the identity layer. Login has to find a user by email before
 *     there is an acting user, and every request resolves its session to a user
 *     here.
 */
export interface Store {
  users: UserRepository;
  sourceFiles: SourceFileRepository;
  pages: PageRepository;
  documents: DocumentRepository;
  fields: ExtractedFieldRepository;
  tags: TagRepository;
  shareLinks: ShareLinkRepository;
  maintenance: MaintenanceRepository;

  /**
   * Ingestion writes a document, its tags and its fields together; a partial
   * write leaves a document with no fields and no error.
   *
   * The callback receives a `Store`, so repository code is identical inside and
   * outside a transaction and no caller ever needs the driver. It is async
   * because the repositories are — which rules out `better-sqlite3`'s own
   * `db.transaction()`, since that throws on a callback returning a promise.
   */
  transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T>;

  close(): Promise<void>;
}

export interface UserRecord {
  id: string;
  email: string;
  password_hash: string;
  /** Bumped on a password change; a session issued under an older value is refused. */
  auth_version: number;
  email_verified_at: string | null;
  created_at: string;
}

export interface NewUser {
  id: string;
  /** Already normalised (trimmed, lower-cased) by the caller. */
  email: string;
  passwordHash: string;
  createdAt: string;
  /** Null for a self-registered account that has not confirmed its address yet. */
  verifiedAt: string | null;
}

/** A user's TOTP enrolment. `confirmed_at` is null until a first code has been accepted. */
export interface TotpRecord {
  secret_enc: string;
  confirmed_at: string | null;
  /** Newest time step already accepted. A code for this step or an older one is a replay. */
  last_step: number;
}

export type UserTokenKind = 'verify' | 'reset';

export interface NewUserToken {
  id: string;
  userId: string;
  kind: UserTokenKind;
  /** sha256 of the token. The token itself is never stored. */
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
}

export interface UserRepository {
  /** Also gives the user a starter tag vocabulary. Throws if the email is taken. */
  create(user: NewUser): Promise<void>;
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  /** Replaces the hash and bumps `auth_version`, ending the user's other sessions. */
  setPassword(id: string, passwordHash: string): Promise<number>;
  list(): Promise<Array<Pick<UserRecord, 'id' | 'email' | 'created_at' | 'email_verified_at'>>>;
  markVerified(id: string, at: string): Promise<void>;
  createToken(token: NewUserToken): Promise<void>;
  /**
   * Spends a token and returns whose it was, or null if it is unknown, the wrong
   * kind, already spent or expired. One atomic statement, so two requests with the
   * same token cannot both succeed.
   */
  consumeToken(tokenHash: string, kind: UserTokenKind, now: string): Promise<string | null>;
  /** Spends every unspent token of a kind, so a newer one replaces older ones. */
  invalidateTokens(userId: string, kind: UserTokenKind): Promise<void>;
  /** Removes the user and everything they own. Files on disk are the caller's. */
  delete(id: string): Promise<void>;

  /** The enrolment, confirmed or not; null if the user never started one. */
  getTotp(userId: string): Promise<TotpRecord | null>;
  /**
   * Starts (or restarts) enrolment with a new encrypted secret. Returns false, and
   * changes nothing, if a confirmed enrolment exists: that has to be disabled first.
   */
  beginTotp(userId: string, secretEnc: string, now: string): Promise<boolean>;
  /**
   * Confirms enrolment: records the accepted step, stores the recovery code hashes and
   * bumps `auth_version`, returning the new value. Null if there is nothing unconfirmed
   * to confirm. One transaction.
   */
  enableTotp(userId: string, step: number, codeHashes: string[], now: string): Promise<number | null>;
  /**
   * Accepts a time step only if it is newer than any accepted before. One atomic
   * statement, so two requests presenting the same code cannot both succeed.
   */
  claimTotpStep(userId: string, step: number): Promise<boolean>;
  /** Spends a recovery code. False if it is unknown or already used; atomic. */
  useRecoveryCode(userId: string, codeHash: string, now: string): Promise<boolean>;
  /** Replaces all of the user's recovery codes. */
  replaceRecoveryCodes(userId: string, codeHashes: string[]): Promise<void>;
  /** Unspent recovery codes. */
  countRecoveryCodes(userId: string): Promise<number>;
  /** Removes the secret and the codes and bumps `auth_version`, returning the new value. */
  disableTotp(userId: string): Promise<number>;
}

/** What a client may see of an upload: no server path, no checksum. */
export type SourceFileSummary = Omit<SourceFile, 'file_path' | 'checksum'>;

export interface SourceFileRepository {
  listFor(userId: string): Promise<SourceFileSummary[]>;
  /** The full row, including the server path. For the pipeline — not for a response. */
  findFor(userId: string, id: string): Promise<SourceFile | null>;
  /** Upload de-duplication. Per user: the same scan may reach two accounts. */
  findByChecksumFor(userId: string, checksum: string): Promise<SourceFile | null>;
  create(userId: string, input: NewSourceFile): Promise<void>;
  setStatus(userId: string, id: string, status: SourceFile['status'], errorMessage?: string | null): Promise<void>;
  setPageCount(userId: string, id: string, pageCount: number): Promise<void>;
  /**
   * Removes what ingestion produced from this upload — its documents, their fields and
   * tag links, and its pages — and keeps the upload itself and the user's tags. Returns
   * how many documents went. For re-reading a file.
   */
  clearDerived(userId: string, id: string): Promise<number>;
}

export interface NewSourceFile {
  id: string;
  uploadedAt: string;
  originalFilename: string | null;
  filePath: string;
  mimeType: string | null;
  checksum: string;
}

export interface PageRepository {
  create(userId: string, page: NewPage): Promise<void>;
  /** Ordered by page number — ingestion depends on that order. */
  listForSourceFile(userId: string, sourceFileId: string): Promise<PageSummary[]>;
  listForDocument(userId: string, documentId: string): Promise<PageWithoutPath[]>;
  findGroundingContext(userId: string, pageId: string): Promise<GroundingContext | null>;
  /** The absolute path is never returned to a client (S-8); this is for streaming. */
  findImagePathFor(userId: string, pageId: string): Promise<string | null>;
  /** A page read again: its text, where it is, and how it was read. False if it is not the user's. */
  updateReading(
    userId: string,
    pageId: string,
    reading: { rawText: string; elements: UnstructuredElement[]; extractionSource: Page['extraction_source'] },
  ): Promise<boolean>;
}

export interface NewPage {
  id: string;
  sourceFileId: string;
  pageNumber: number;
  imagePath: string;
  imageWidth: number;
  imageHeight: number;
  rawText: string | null;
  elements: UnstructuredElement[];
  extractionSource: Page['extraction_source'];
  isContinuation: boolean | null;
  continuationConfidence: number | null;
  continuationReasoning: string | null;
}

export type PageSummary = Pick<
  Page,
  'id' | 'page_number' | 'raw_text' | 'is_continuation' | 'image_width' | 'image_height' | 'extraction_source'
>;
export type PageWithoutPath = Omit<Page, 'image_path'>;

export interface GroundingContext {
  elements: UnstructuredElement[];
  imageWidth: number;
  imageHeight: number;
}

export interface DocumentFilter {
  /** Full-text query. Must stay owner-aware when FTS does (M-2). */
  q?: string;
  tag?: string;
  docType?: string;
  provider?: string;
  dateFrom?: string;
  dateTo?: string;
  reviewed?: boolean;
  /** The documents one upload produced. */
  sourceFileId?: string;
  limit: number;
  offset: number;
}

export interface DocumentRepository {
  listFor(userId: string, filter: DocumentFilter): Promise<Document[]>;
  findFor(userId: string, id: string): Promise<Document | null>;
  create(userId: string, doc: NewDocument): Promise<void>;
  /** Only the columns a client may write; the caller cannot name a column. */
  update(userId: string, id: string, patch: DocumentPatch): Promise<void>;
  setPageEnd(userId: string, id: string, pageEnd: number): Promise<void>;
  delete(userId: string, id: string): Promise<void>;
  /** Which of these ids are the user's. For checking a share link names only their own. */
  ownedIds(userId: string, ids: string[]): Promise<string[]>;
  /** Resolved from a share token and scoped by the link's owner — P12's exception. */
  listForShare(link: ResolvedShareLink): Promise<Document[]>;
}

export interface NewDocument {
  id: string;
  sourceFileId: string;
  pageStart: number;
  pageEnd: number;
  title?: string | null;
  docDate?: string | null;
  provider?: string | null;
  docType?: DocType | null;
  aiSummary?: string | null;
}

export interface DocumentPatch {
  title?: string | null;
  doc_date?: string | null;
  provider?: string | null;
  doc_type?: string;
  ai_summary?: string | null;
  user_notes?: string | null;
  reviewed?: boolean;
}

export interface ExtractedFieldRepository {
  listForDocument(userId: string, documentId: string): Promise<ExtractedField[]>;
  create(userId: string, field: NewExtractedField): Promise<void>;
  /** Merging two documents moves the fields of one onto the other. */
  reassignDocument(userId: string, fromDocumentId: string, toDocumentId: string): Promise<void>;
  /**
   * Splitting a document moves the fields on its pages from `fromPageNumber` on to the new
   * document, so each field stays with the page it was read from.
   */
  reassignFromPage(userId: string, fromDocumentId: string, toDocumentId: string, fromPageNumber: number): Promise<void>;
  /** Before a document is read again, its old fields go. */
  deleteForDocument(userId: string, documentId: string): Promise<void>;
  /** The owner correcting a field. False if it is not this user's, or not on this document. */
  update(userId: string, documentId: string, fieldId: string, change: { label: string; value: string }): Promise<boolean>;
  /** The owner removing a field. False if it is not this user's, or not on this document. */
  remove(userId: string, documentId: string, fieldId: string): Promise<boolean>;
}

export interface NewExtractedField {
  id: string;
  documentId: string;
  pageId: string;
  label: string;
  value: string;
  sourceSnippet: string | null;
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;
  confidence: number | null;
}

export interface TagRepository {
  /** Per-user vocabulary: a shared one would leak other users' categories. */
  listFor(userId: string): Promise<Array<{ id: number; name: string }>>;
  namesForDocument(userId: string, documentId: string): Promise<string[]>;
  /** Replaces the document's tags, creating any that do not exist yet. */
  setForDocument(userId: string, documentId: string, names: string[]): Promise<void>;
  removeAllForDocument(userId: string, documentId: string): Promise<void>;
}

export interface ShareLinkRepository {
  listFor(userId: string): Promise<ShareLinkSummary[]>;
  create(userId: string, link: NewShareLink): Promise<void>;
  /** False if the link is not the user's (or does not exist). */
  revoke(userId: string, id: string): Promise<boolean>;
  /** By digest, never by raw token (P6). No user: the token *is* the identity. */
  findLiveByTokenHash(tokenHash: string): Promise<ResolvedShareLink | null>;
  /** P7. The reader is unauthenticated by definition. */
  logAccess(linkId: string, accessedAt: string, ipAddress: string | null, countView: boolean): Promise<void>;
  /**
   * The audit trail for one of the owner's links. SECURITY.md's operational
   * response for a leaked link is to read this.
   */
  accessLogFor(userId: string, linkId: string): Promise<AccessLogEntry[]>;
}

export interface AccessLogEntry {
  accessed_at: string;
  ip_address: string | null;
}

/** What the owner's list view may see — never the token, not even hashed (S-8). */
export type ShareLinkSummary = Omit<ShareLink, 'token'>;

export interface NewShareLink {
  id: string;
  tokenHash: string;
  label: string | null;
  scope: ShareLink['scope'];
  scopeValue: string | null;
  createdAt: string;
  expiresAt: string;
}

/** A live link with its owner resolved, which is what scopes a share read. */
export interface ResolvedShareLink {
  id: string;
  userId: string;
  scope: string;
  scopeValue: string | null;
  expiresAt: string;
}

export interface MaintenanceRepository {
  /**
   * A consistent copy of the whole store at `destination` (P11). Adapter
   * specific by nature — SQLite uses `VACUUM INTO`, because copying the file
   * under load is unsafe in WAL mode; another store would dump differently.
   */
  snapshotTo(destination: string): Promise<void>;
  /** Startup: nothing can still be in flight, the registry is in-memory. */
  failStalledSourceFiles(): Promise<number>;
  /** S-4: rewrite any plaintext share token left by a pre-S-4 build. */
  listShareLinkTokens(): Promise<Array<{ id: string; token: string }>>;
  setShareLinkToken(id: string, tokenHash: string): Promise<void>;
}

export interface StoreConfig {
  adapter: string;
  /** Adapter-specific: a file path for SQLite, a DSN for a networked store. */
  location: string;
}

export class StoreConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreConfigError';
  }
}

export type StoreFactory = (config: StoreConfig) => Store;
