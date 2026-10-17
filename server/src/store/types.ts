import type {
  Doctor,
  DoctorRole,
  Document,
  DocType,
  ExtractedField,
  Measurement,
  MeasurementFlag,
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
  measurements: MeasurementRepository;
  doctors: DoctorRepository;
  tags: TagRepository;
  shareLinks: ShareLinkRepository;
  translations: TranslationRepository;
  embeddings: EmbeddingRepository;
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
  /**
   * Removes the upload and everything made from it, in one transaction. The user's tags and
   * doctors stay. Returns false, and changes nothing, if the upload is not theirs. Files on
   * disk are the caller's.
   */
  delete(userId: string, id: string): Promise<boolean>;
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
  /** The document's pages the owner has not hidden. */
  listForDocument(userId: string, documentId: string): Promise<PageWithoutPath[]>;
  /**
   * Hides or shows a page. Returns the ids of the documents whose range holds it, or null, changing
   * nothing, if the page is not the user's.
   */
  setHidden(userId: string, pageId: string, hidden: boolean): Promise<string[] | null>;
  /**
   * Hides or shows every page of one document (the pages its range holds). Returns how many pages that was:
   * 0 if the document is not the user's or holds no pages, and nothing is changed then.
   */
  setHiddenForDocument(userId: string, documentId: string, hidden: boolean): Promise<number>;
  /** The upload a page is in; null if it is not the user's. */
  sourceFileOf(userId: string, pageId: string): Promise<string | null>;
  /**
   * Puts an upload's pages in this order: the first id becomes page 1, and so on. Every page of the upload must be
   * named, once. The file index (`source_page`) is untouched.
   */
  renumber(userId: string, sourceFileId: string, orderedPageIds: string[]): Promise<void>;
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
  'id' | 'page_number' | 'source_page' | 'raw_text' | 'is_continuation' | 'image_width' | 'image_height' | 'extraction_source' | 'hidden'
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
  /** Also the documents whose every page the owner has hidden. Only the regrouping screen asks for them. */
  includeHidden?: boolean;
  limit: number;
  offset: number;
}

export interface RelatedSignal {
  document_id: string;
  /** The names of tests both have values for. */
  shared_tests: string[];
  shared_doctors: string[];
  shared_tags: string[];
  same_provider: boolean;
}

export interface DocumentRepository {
  listFor(userId: string, filter: DocumentFilter): Promise<Document[]>;
  findFor(userId: string, id: string): Promise<Document | null>;
  create(userId: string, doc: NewDocument): Promise<void>;
  /** Only the columns a client may write; the caller cannot name a column. */
  update(userId: string, id: string, patch: DocumentPatch): Promise<void>;
  setPageEnd(userId: string, id: string, pageEnd: number): Promise<void>;
  /** After pages were moved: the page numbers the document now holds. */
  setRange(userId: string, id: string, pageStart: number, pageEnd: number): Promise<void>;
  delete(userId: string, id: string): Promise<void>;
  /**
   * What each other document has in common with this one, from the data alone: tests (by canonical name), doctors, tags
   * and provider. Documents set aside are left out. For "related documents"; meaning is added by `similarity/`.
   */
  relatedSignals(userId: string, documentId: string): Promise<RelatedSignal[]>;
  /** Each provider name used on the user's documents, with how many documents. */
  providers(userId: string): Promise<Array<{ name: string; document_count: number }>>;
  /** Every document of the user whose provider is `from` gets `to` (null clears it). How many changed. */
  renameProvider(userId: string, from: string, to: string | null): Promise<number>;
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
  language?: string | null;
}

export interface DocumentPatch {
  title?: string | null;
  doc_date?: string | null;
  provider?: string | null;
  doc_type?: string;
  ai_summary?: string | null;
  user_notes?: string | null;
  reviewed?: boolean;
  language?: string | null;
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
  /** A page moved to another document: the values read from it go with it. */
  reassignPage(userId: string, pageId: string, toDocumentId: string): Promise<void>;
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
  /** Fields that belong together share a number within a document; null if on its own. */
  groupNo?: number | null;
  sourceSnippet: string | null;
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;
  confidence: number | null;
}

export interface NewMeasurement {
  id: string;
  documentId: string;
  pageId: string;
  name: string;
  canonical: string;
  valueText: string;
  valueNum: number | null;
  unit: string | null;
  refLow: number | null;
  refHigh: number | null;
  flag: MeasurementFlag | null;
  takenOn: string | null;
  sourceSnippet: string | null;
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;
  confidence: number | null;
}

/** What the owner can correct on a measurement. */
export interface MeasurementChange {
  name: string;
  canonical: string;
  valueText: string;
  valueNum: number | null;
  unit: string | null;
  refLow: number | null;
  refHigh: number | null;
  flag: MeasurementFlag | null;
  takenOn: string | null;
}

/** One test across all documents: what the list of trends shows. */
export interface MeasurementName {
  canonical: string;
  /** The name as most recently printed. */
  name: string;
  unit: string | null;
  count: number;
  latest_value_text: string;
  latest_taken_on: string | null;
  latest_flag: MeasurementFlag | null;
}

/** One value of one test, with the document it came from: one point on a chart. */
export interface MeasurementPoint {
  id: string;
  document_id: string;
  document_title: string | null;
  taken_on: string | null;
  name: string;
  value_text: string;
  value_num: number | null;
  unit: string | null;
  ref_low: number | null;
  ref_high: number | null;
  flag: MeasurementFlag | null;
}

export interface MeasurementRepository {
  listForDocument(userId: string, documentId: string): Promise<Measurement[]>;
  create(userId: string, measurement: NewMeasurement): Promise<void>;
  /** The owner correcting a value. False if it is not this user's, or not on this document. */
  update(userId: string, documentId: string, id: string, change: MeasurementChange): Promise<boolean>;
  remove(userId: string, documentId: string, id: string): Promise<boolean>;
  /** Before a document is read again. */
  deleteForDocument(userId: string, documentId: string): Promise<void>;
  /** Merging two documents. */
  reassignDocument(userId: string, fromDocumentId: string, toDocumentId: string): Promise<void>;
  /** Splitting a document: the values on its pages from this one on go with them. */
  reassignFromPage(userId: string, fromDocumentId: string, toDocumentId: string, fromPageNumber: number): Promise<void>;
  /** A page moved to another document: the values read from it go with it. */
  reassignPage(userId: string, pageId: string, toDocumentId: string): Promise<void>;
  /** The name a test is filed under: the name given, or the one it was merged into. */
  resolveCanonical(userId: string, canonical: string): Promise<string>;
  /**
   * Two names for one test become one: every value under `from` moves to `into`, and `from` is
   * remembered so later documents that use it land under `into`. Both must be tests this user has.
   */
  mergeTests(userId: string, from: string, into: string): Promise<'ok' | 'same' | 'not_found'>;
  /**
   * A test called something else everywhere: its values take the new name, and later documents that use the old one are
   * filed under the new. `merged` if that name is another test's, whose values then include these. The old name must be a
   * test this user has.
   */
  renameTest(userId: string, from: string, to: string): Promise<'ok' | 'merged' | 'same' | 'not_found' | 'invalid'>;
  /** Removes every value of a test and what remembers its old names. How many values went. */
  removeTest(userId: string, canonical: string): Promise<number>;
  /** Every test this user has a value for. */
  names(userId: string): Promise<MeasurementName[]>;
  /** Every value of one test, oldest first. */
  series(userId: string, canonical: string): Promise<MeasurementPoint[]>;
}

export interface DoctorWithCounts extends Doctor {
  document_count: number;
  /** The newest document date they appear on. */
  last_seen: string | null;
}

export interface DoctorOnDocument extends Doctor {
  role: DoctorRole;
}

export interface DoctorDocument {
  id: string;
  title: string | null;
  doc_type: DocType | null;
  doc_date: string | null;
  provider: string | null;
  role: DoctorRole;
}

export interface DoctorRepository {
  /**
   * The directory entry for this name, made if there is none. A name that reduces to the same key as an
   * existing doctor is that doctor, and so is a doctor with the same professional code under another spelling
   * (the code wins); a blank specialty, clinic or code is filled in from what is now known, never overwritten.
   */
  upsert(userId: string, doctor: { name: string; specialty?: string | null; clinic?: string | null; licenseCode?: string | null }, now: string): Promise<string | null>;
  /**
   * Names a doctor on a document. False if either is not the user's. `source` is where it came from: a
   * stamp wins over text if both name the same doctor in the same role.
   */
  link(userId: string, documentId: string, doctorId: string, role: DoctorRole, source?: 'text' | 'stamp' | 'signature'): Promise<boolean>;
  /** Every link, however it was made: the owner replacing the list. */
  unlinkAll(userId: string, documentId: string): Promise<void>;
  /** Only the links made from the document's text, so reading the text again leaves what a stamp gave. */
  unlinkRead(userId: string, documentId: string): Promise<void>;
  forDocument(userId: string, documentId: string): Promise<DoctorOnDocument[]>;
  /** Merging two documents: the second's doctors are named on the first. */
  moveLinks(userId: string, fromDocumentId: string, toDocumentId: string): Promise<void>;
  /** Splitting a document: the new half names the same doctors. */
  copyLinks(userId: string, fromDocumentId: string, toDocumentId: string): Promise<void>;
  listFor(userId: string): Promise<DoctorWithCounts[]>;
  find(userId: string, id: string): Promise<Doctor | null>;
  documentsFor(userId: string, doctorId: string): Promise<DoctorDocument[]>;
  /** 'name_taken' or 'code_taken' if the new name or code is another doctor's. */
  update(userId: string, id: string, change: { name?: string; specialty?: string | null; clinic?: string | null; licenseCode?: string | null }): Promise<'ok' | 'not_found' | 'name_taken' | 'code_taken'>;
  /** Two entries for one person become one. False if either is not the user's, or they are the same. */
  merge(userId: string, fromId: string, intoId: string): Promise<boolean>;
  /** Only a doctor no document names. */
  remove(userId: string, id: string): Promise<boolean>;
}

export interface TagWithCount { id: number; name: string; document_count: number }

export interface TagRepository {
  /** Each tag with how many documents carry it (set aside ones included). */
  listWithCounts(userId: string): Promise<TagWithCount[]>;
  /**
   * Renames a tag. If another tag already has the new name the two become one (`merged`): the documents keep
   * their tag, none twice. Links that share by this tag follow it. `invalid` for a name with nothing in it.
   */
  rename(userId: string, id: number, name: string): Promise<'ok' | 'merged' | 'not_found' | 'invalid'>;
  /** One tag folded into another. Links that share by the first now share by the second. */
  merge(userId: string, fromId: number, intoId: number): Promise<'ok' | 'same' | 'not_found'>;
  /** Removes the tag from every document and from the vocabulary. Links that share by it then share nothing. */
  remove(userId: string, id: number): Promise<boolean>;
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
  includeScans: boolean;
  language: string | null;
}

/** A live link with its owner resolved, which is what scopes a share read. */
export interface ResolvedShareLink {
  id: string;
  userId: string;
  scope: string;
  scopeValue: string | null;
  expiresAt: string;
  includeScans: boolean;
  language: string | null;
}

/** A document's details in another language, kept until what was translated changes (see schema.sql). */
export interface TranslationRepository {
  get(userId: string, documentId: string, language: string): Promise<{ sourceHash: string; content: string; createdAt: string } | null>;
  /** Replaces any earlier translation into that language. Nothing is written if the document is not the user's. */
  put(userId: string, documentId: string, language: string, sourceHash: string, content: string, createdAt: string): Promise<void>;
}

/** A document's vector from one model. `vector` is float32 bytes; `textHash` is a digest of the text that was embedded. */
export interface StoredEmbedding {
  documentId: string;
  model: string;
  dims: number;
  textHash: string;
  vector: Buffer;
}

export interface EmbeddingRepository {
  /** The vectors of one model for the user's documents that are not set aside. */
  listFor(userId: string, model: string): Promise<StoredEmbedding[]>;
  /** What a document has from a model, to tell whether it is current. */
  hashesFor(userId: string, model: string): Promise<Map<string, string>>;
  /** Replaces the document's vector from that model. Nothing is written if the document is not the user's. */
  put(userId: string, embedding: StoredEmbedding, createdAt: string): Promise<void>;
  /** Vectors from any other model: after a switch is complete, the old space is not kept. How many. */
  pruneOtherModels(userId: string, keepModel: string): Promise<number>;
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
