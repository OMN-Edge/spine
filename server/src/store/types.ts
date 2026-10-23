import type { Turn } from '../geometry.js';
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
 * Five exceptions to the user-scoping rule, each named here so that a fifth
 * has to be argued for:
 *
 *  1. `shareLinks.findLiveByTokenHash`, `shareLinks.findRequest`/`createRequest`
 *     and `documents.listForShare` — scoped by the *link's* owner, resolved from
 *     the token, never from a session (P12).
 *  2. `shareLinks.logAccess` — the caller is an unauthenticated reader by
 *     definition (P7).
 *  3. `shared.get`, `shared.createRequest`/`getRequest`, `shared.logOpen` and `shared.expired` — the public side of a sealed share: scoped
 *     by the bundle's id, which is random and in the link, and answering only what the link's holder may see (metadata and sealed bytes).
 *  4. `maintenance.*` — boot-time operations across all rows, run by the
 *     process itself with no acting user.
 *  5. `users.*` — the identity layer. Login has to find a user by email before
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
  links: LinkRepository;
  episodes: EpisodeRepository;
  conversations: ConversationRepository;
  regroupPlans: RegroupPlanRepository;
  matchDecisions: MatchDecisionRepository;
  sessions: SessionRepository;
  vault: VaultRepository;
  shared: SharedRepository;
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
  health_consent_at: string | null;
  health_consent_version: string | null;
  terms_accepted_at: string | null;
  terms_version: string | null;
}

export interface PasskeyRecord {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string[] | null;
  name: string;
  backed_up: boolean;
  created_at: string;
  last_used_at: string | null;
}

export interface NewUser {
  id: string;
  /** Already normalised (trimmed, lower-cased) by the caller. */
  email: string;
  passwordHash: string;
  createdAt: string;
  /** Null for a self-registered account that has not confirmed its address yet. */
  verifiedAt: string | null;
  /** Given at sign-up, by the person; absent for an account the operator creates, which is asked at its first sign-in. */
  consent?: { healthVersion: string; termsVersion: string };
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
  /** Who a token is for if it is still good, without spending it (a reset page fetches the recovery-wrapped key first). */
  peekToken(tokenHash: string, kind: UserTokenKind, now: string): Promise<string | null>;
  invalidateTokens(userId: string, kind: UserTokenKind): Promise<void>;
  /** The user's passkeys, oldest first. The public keys are for the server; a client gets only the name and dates. */
  listPasskeys(userId: string): Promise<PasskeyRecord[]>;
  /** The passkey with this credential id, whoever's it is: sign-in finds the account from it, so it has no acting user. */
  findPasskey(credentialId: string): Promise<PasskeyRecord | null>;
  /** False if the credential id is already registered (to anyone). */
  addPasskey(userId: string, passkey: Omit<PasskeyRecord, 'user_id' | 'last_used_at'>): Promise<boolean>;
  /** After a sign-in: the counter the authenticator reported and when. Only ever moves a counter forward. */
  touchPasskey(credentialId: string, counter: number, at: string): Promise<void>;
  renamePasskey(userId: string, id: string, name: string): Promise<boolean>;
  removePasskey(userId: string, id: string): Promise<boolean>;
  /** Records consent to process health data and acceptance of the terms, each with the version of the text shown. */
  recordConsent(id: string, consent: { healthVersion: string; termsVersion: string }, at: string): Promise<void>;
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
  /** How many unprocessed photos are kept beside this upload's PDF. */
  setRawCount(userId: string, id: string, count: number): Promise<void>;
  /** The full row, including the server path. For the pipeline — not for a response. */
  findFor(userId: string, id: string): Promise<SourceFile | null>;
  /** Upload de-duplication. Per user: the same scan may reach two accounts. */
  findByChecksumFor(userId: string, checksum: string): Promise<SourceFile | null>;
  create(userId: string, input: NewSourceFile): Promise<void>;
  setStatus(userId: string, id: string, status: SourceFile['status'], errorMessage?: string | null): Promise<void>;
  setPageCount(userId: string, id: string, pageCount: number): Promise<void>;
  /** The owner confirming (or an upload being read, which unconfirms) how an upload's pages are grouped. */
  setGroupingConfirmed(userId: string, id: string, confirmed: boolean): Promise<void>;
  /** Ties a file to the conversation it was attached in. Nothing happens if either is not the user's. */
  setChatConversation(userId: string, id: string, conversationId: string): Promise<void>;
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
  /** Set when the file is attached in a chat conversation. */
  chatConversationId?: string | null;
  /** Several photos bundled into one PDF. */
  photoSet?: boolean;
  /** One of the invented sample records. */
  sample?: boolean;
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
  /**
   * The page image was turned clockwise by `turn` (the file is already rewritten; this is the caller's transaction): its size
   * is now `width` by `height`, the boxes drawn on it (its text elements, and the fields and results read from it) are moved
   * with it, and it remembers how far it has turned. False if it is not the user's.
   */
  rotate(userId: string, pageId: string, turn: Turn, size: { width: number; height: number }): Promise<boolean>;
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
  'id' | 'page_number' | 'source_page' | 'raw_text' | 'is_continuation' | 'image_width' | 'image_height' | 'extraction_source' | 'hidden' | 'rotation'
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
  /** The facility (the document's provider), a part of its name. */
  provider?: string;
  /** A specialty (a part of its name) of a doctor named on the document. */
  specialty?: string;
  dateFrom?: string;
  dateTo?: string;
  reviewed?: boolean;
  /** The documents one upload produced. */
  sourceFileId?: string;
  /** The documents of one episode. */
  episodeId?: string;
  /** Also the documents whose every page the owner has hidden. Only the regrouping screen asks for them. */
  includeHidden?: boolean;
  /** Also the documents of an upload whose grouping the owner has not confirmed yet (not the set-aside ones). For the upload screens. */
  includeUnconfirmed?: boolean;
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
  /** The headline columns (title, doc_date, provider, doc_type, ai_summary) the owner has set: a new reading leaves them alone. */
  editedColumns(userId: string, id: string): Promise<string[]>;
  setEditedColumns(userId: string, id: string, columns: string[]): Promise<void>;
  /** Each provider name used on the user's documents, with how many documents. */
  providers(userId: string): Promise<Array<{ name: string; document_count: number }>>;
  /** Every document of the user whose provider is `from` gets `to` (null clears it). How many changed. */
  renameProvider(userId: string, from: string, to: string | null): Promise<number>;
  /** Those of these documents that are the user's and shown (not set aside, grouping confirmed), in the order given. */
  listShownByIds(userId: string, ids: string[]): Promise<Document[]>;
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
  /** Made from the pages' grouping alone: nothing is read from its text until the owner confirms the grouping. */
  needsReading?: boolean;
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
  needs_reading?: boolean;
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
  /** The same, except what the owner added or changed (and so keeps through a new reading). */
  deleteUnedited(userId: string, documentId: string): Promise<void>;
  /** Keys (`reading-keys.ts`) of the fields the owner removed, so a new reading does not bring them back. */
  removedKeys(userId: string, documentId: string): Promise<Set<string>>;
  /** Ids of the fields the owner added or changed, which a new reading keeps (for an export, which carries the flag). */
  editedIds(userId: string, documentId: string): Promise<Set<string>>;
  /** Fields the owner removed, restored from an export so a new reading still does not bring them back. */
  rememberRemoved(userId: string, documentId: string, keys: string[]): Promise<void>;
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
  /** Added or changed by the owner: reading the document again keeps it. */
  ownerEdited?: boolean;
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
  /** Added or changed by the owner: reading the document again keeps it. */
  ownerEdited?: boolean;
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
  /** The same, except what the owner added or changed (and so keeps through a new reading). */
  deleteUnedited(userId: string, documentId: string): Promise<void>;
  /** Keys (`reading-keys.ts`) of the values the owner removed, so a new reading does not bring them back. */
  removedKeys(userId: string, documentId: string): Promise<Set<string>>;
  /** Ids of the values the owner added or changed, which a new reading keeps (for an export, which carries the flag). */
  editedIds(userId: string, documentId: string): Promise<Set<string>>;
  /** Values the owner removed, restored from an export so a new reading still does not bring them back. */
  rememberRemoved(userId: string, documentId: string, keys: string[]): Promise<void>;
  /** Every name the person merged into another (`alias` is filed under `canonical`), for an export. */
  aliases(userId: string): Promise<Array<{ alias: string; canonical: string }>>;
  /** An alias restored from an export. An alias that is already held keeps the owner's choice. */
  addAlias(userId: string, alias: string, canonical: string): Promise<void>;
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
   * Two people may share a name: with several of that name the one without a code is taken, then the oldest.
   * `id` is exactly that entry (the owner chose it), `newPerson` makes another entry even though the name is held, and
   * `exactCode` says a code that differs from the namesake's is a different person (a restore).
   */
  upsert(userId: string, doctor: { name: string; specialty?: string | null; clinic?: string | null; licenseCode?: string | null; id?: string; newPerson?: boolean; exactCode?: boolean }, now: string): Promise<string | null>;
  /**
   * Names a doctor on a document. False if either is not the user's. `source` is where it came from: a
   * stamp wins over text if both name the same doctor in the same role.
   */
  link(userId: string, documentId: string, doctorId: string, role: DoctorRole, source?: 'text' | 'stamp' | 'signature', printedCode?: string | null): Promise<boolean>;
  /**
   * Doctors whom one of these documents gave a professional code other than the one the directory holds (the directory keeps one per
   * doctor, and a name match leaves it as it is). One row per doctor and printed code.
   */
  codeClashes(userId: string, documentIds: string[]): Promise<Array<{ doctor_id: string; name: string; directory_code: string; printed_code: string; document_ids: string[] }>>;
  /** Every link, however it was made: the owner replacing the list. */
  /** How each doctor is tied to the document now: the role, where it was read (text, a stamp, a signature) and the code the document printed. For keeping them through an edit. */
  linkInfo(userId: string, documentId: string): Promise<Array<{ doctor_id: string; role: DoctorRole; source: 'text' | 'stamp' | 'signature'; printed_code: string | null }>>;
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
  /** 'code_taken' if the new code is another doctor's. A name may be another's: two people can share one. */
  update(userId: string, id: string, change: { name?: string; specialty?: string | null; clinic?: string | null; licenseCode?: string | null }): Promise<'ok' | 'not_found' | 'code_taken'>;
  /** Two entries for one person become one. False if either is not the user's, or they are the same. */
  merge(userId: string, fromId: string, intoId: string): Promise<boolean>;
  /** Only a doctor no document names. */
  remove(userId: string, id: string): Promise<boolean>;
}

/** What the owner answered when asked whether two entries are the same. Kept so the question is not asked again. */
export interface MatchDecisionRepository {
  has(userId: string, kind: string, pairKey: string): Promise<boolean>;
  add(userId: string, kind: string, pairKey: string, at: string): Promise<void>;
  /** Every pair key decided for a kind, to filter a list of questions in one read. */
  list(userId: string, kind: string): Promise<Set<string>>;
  /** Forgets every answer, so the questions are asked afresh. */
  removeAll(userId: string): Promise<number>;
}

/** A sign-in the owner can see and end (SECURITY.md S-33). */
export interface SessionRecord {
  id: string;
  created_at: string;
  last_seen_at: string;
  user_agent: string;
  address: string;
}

export interface SessionRepository {
  open(userId: string, session: { id: string; at: string; userAgent: string; address: string }): Promise<void>;
  get(userId: string, id: string): Promise<SessionRecord | null>;
  touch(userId: string, id: string, at: string): Promise<void>;
  /** Newest activity first. */
  list(userId: string): Promise<SessionRecord[]>;
  /** False for one that is not the user's or is already gone. */
  revoke(userId: string, id: string): Promise<boolean>;
  /** Every session but one (a password change, a second-factor change); returns how many ended. */
  revokeExcept(userId: string, keepId: string | null): Promise<number>;
  /** Rows started before the cutoff or idle since it, so the table does not keep what could never be valid. */
  prune(userId: string, startedBefore: string, idleSince: string): Promise<number>;
  /**
   * Records a browser by the digest of its device cookie. `first` when this account had none yet (nobody to tell),
   * `known` when this browser has signed in before, `new` when others have but this one has not.
   */
  rememberDevice(userId: string, deviceHash: string, at: string): Promise<'first' | 'known' | 'new'>;
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
  /** Adds tags to the vocabulary with no document (a restore brings the ones no document carries). Existing ones are left. */
  ensure(userId: string, names: string[]): Promise<void>;
}

export interface ShareLinkRepository {
  listFor(userId: string): Promise<ShareLinkSummary[]>;
  create(userId: string, link: NewShareLink): Promise<void>;
  /** False if the link is not the user's (or does not exist). */
  revoke(userId: string, id: string): Promise<boolean>;
  /** By digest, never by raw token (P6). No user: the token *is* the identity. */
  findLiveByTokenHash(tokenHash: string): Promise<ResolvedShareLink | null>;
  /** P7. The reader is unauthenticated by definition. */
  logAccess(linkId: string, accessedAt: string, ipAddress: string | null, countView: boolean, where?: { country?: string | null; documentId?: string | null }): Promise<void>;
  /**
   * The audit trail for one of the owner's links. SECURITY.md's operational
   * response for a leaked link is to read this.
   */
  accessLogFor(userId: string, linkId: string): Promise<AccessLogEntry[]>;

  /**
   * Approval of a visitor's browser (SECURITY.md M-19). The two methods without a user are the visitor's side and
   * belong to the first exception above: they are keyed by a link that was resolved from its token and by the digest
   * of a cookie, and they can reach only that one row. The rest are the owner's and take the acting user.
   */
  /** The visitor's request for this link, by the digest of their cookie. */
  findRequest(linkId: string, visitorHash: string): Promise<ShareRequestState | null>;
  /**
   * Records a first request. False, and nothing written, when the link already holds `maxPending` waiting requests,
   * so a token holder cannot make the owner's list or inbox grow without bound.
   */
  createRequest(linkId: string, request: NewShareRequest, maxPending: number): Promise<boolean>;
  listRequests(userId: string, now: string, linkId?: string): Promise<ShareRequest[]>;
  getRequest(userId: string, id: string, now: string): Promise<ShareRequest | null>;
  /** False if the request is not the user's. Deciding again is allowed, so an approval can be withdrawn. */
  decideRequest(userId: string, id: string, status: 'approved' | 'denied', at: string): Promise<boolean>;

  /** One of the user's links, or null. */
  findFor(userId: string, id: string): Promise<ShareLinkSummary | null>;
  /** The key the link's sealed copy was made with (kept in the owner's own records), or null. */
  keyFor(userId: string, linkId: string): Promise<string | null>;
  setKey(userId: string, linkId: string, key: string): Promise<void>;
  /** What a request holds in place of the cookie digest: the visitor browser's public key, for wrapping the share key to it. Null if not the user's. */
  requestKey(userId: string, id: string): Promise<string | null>;
  /**
   * Changes a link after it was made. A revoked link cannot be changed. What changed is written to the link's history, and
   * turning approval on drops the requests it already held, so a browser approved under an earlier setting is not let back in.
   */
  update(userId: string, id: string, patch: ShareLinkPatch, at: string): Promise<'ok' | 'not_found' | 'revoked'>;
  /** Who has read the link: counts, addresses and the latest reads. */
  accessSummary(userId: string, linkId: string): Promise<AccessSummary>;
  /** What happened to the link, newest first. */
  eventsFor(userId: string, linkId: string, limit: number): Promise<ShareLinkEvent[]>;
}

export interface ShareLinkPatch {
  label?: string | null;
  expiresAt?: string;
  includeScans?: boolean;
  requireApproval?: boolean;
  allowChat?: boolean;
  language?: string | null;
  scope?: ShareLink['scope'];
  scopeValue?: string | null;
}

export interface AccessSummary {
  total: number;
  first_at: string | null;
  last_at: string | null;
  /** The addresses that read it, most reads first. */
  addresses: Array<{ ip_address: string | null; country: string | null; count: number; last_at: string }>;
  recent: AccessLogEntry[];
}

export interface ShareLinkEvent {
  at: string;
  kind: 'created' | 'changed' | 'revoked' | 'approved' | 'denied';
  /** JSON: for `changed`, `{ changes: [{ field, from, to }] }`. */
  detail: string | null;
}

export interface ShareRequestState {
  id: string;
  status: 'pending' | 'approved' | 'denied';
}

export interface NewShareRequest {
  id: string;
  visitorHash: string;
  note: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  requestedAt: string;
}

/** What the owner sees of a request. Never the visitor's digest. */
export interface ShareRequest {
  id: string;
  share_link_id: string;
  link_label: string | null;
  /** The link can still be opened: not revoked, not expired. Approving a request on a dead link changes nothing. */
  link_active: boolean;
  status: 'pending' | 'approved' | 'denied';
  note: string | null;
  ip_address: string | null;
  user_agent: string | null;
  requested_at: string;
  decided_at: string | null;
}

export interface AccessLogEntry {
  accessed_at: string;
  ip_address: string | null;
  /** ISO 3166-1 alpha-2, from the address; null when unknown or from before countries were recorded. */
  country: string | null;
  /** The shared document this read opened; null for any other read. */
  document_id: string | null;
}

/** What the owner's list view may see — never the token, not even hashed (S-8). */
export type ShareLinkSummary = Omit<ShareLink, 'token'> & { pending_requests: number };

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
  requireApproval: boolean;
  allowChat: boolean;
}

/** A live link with its owner resolved, which is what scopes a share read. */
export interface ResolvedShareLink {
  id: string;
  /** The owner's own name for the link. Context for the shared chat; never shown to the recipient. */
  label?: string | null;
  userId: string;
  scope: string;
  scopeValue: string | null;
  expiresAt: string;
  includeScans: boolean;
  language: string | null;
  requireApproval: boolean;
  allowChat: boolean;
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

/** What the analysis of a mixed upload found, kept until the owner applies it or the upload changes. The plan is JSON the analysis owns. */
export interface RegroupPlanRepository {
  /** Replaces any earlier plan for the upload. Nothing is written if the upload is not the user's. */
  save(userId: string, sourceFileId: string, plan: unknown, createdAt: string): Promise<boolean>;
  get(userId: string, sourceFileId: string): Promise<{ plan: unknown; created_at: string } | null>;
  remove(userId: string, sourceFileId: string): Promise<void>;
}

export interface ConversationSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  /** The app started it and the owner has not opened it. */
  unread: boolean;
  /** Null: the owner started it. `upload`: the app did, when an upload finished. */
  origin: 'upload' | 'regroup' | null;
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** The documents an answer cited, as it showed them. */
  sources: unknown[];
  /** Set on a reply with nothing to say (nothing matched). */
  note: 'none' | 'failed' | 'off' | null;
  created_at: string;
  /** `upload`: a notice the app wrote; the page draws it from `data`, and `content` says the same in English for the model. */
  kind: 'upload' | 'regroup' | 'attachment' | null;
  data: unknown | null;
}

export interface NewMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources: unknown[];
  note: StoredMessage['note'];
  createdAt: string;
  kind?: 'upload' | 'regroup' | 'attachment' | null;
  data?: unknown;
}

/** The most conversations kept per person (the oldest go) and messages in one. */
export const MAX_CONVERSATIONS = 200;
export const MAX_MESSAGES = 200;

export interface ConversationRepository {
  /** Most recently active first. */
  list(userId: string, limit: number): Promise<ConversationSummary[]>;
  find(userId: string, id: string): Promise<ConversationSummary | null>;
  /** Starts a conversation; the oldest beyond `MAX_CONVERSATIONS` are removed with their messages. */
  create(userId: string, conversation: { id: string; title: string; createdAt: string }): Promise<void>;
  /** All of a conversation's messages in order, or only the last few. Empty if it is not the user's. */
  messages(userId: string, id: string, last?: number): Promise<StoredMessage[]>;
  /** Adds messages and marks the conversation as active now. False, and nothing written, if it is not the user's. */
  append(userId: string, id: string, messages: NewMessage[]): Promise<boolean>;
  rename(userId: string, id: string, title: string): Promise<boolean>;
  remove(userId: string, id: string): Promise<boolean>;
  /** Every conversation of the user. How many. */
  removeAll(userId: string): Promise<number>;
  /** The app starts a conversation with one message from the assistant, unread. */
  createNotice(userId: string, notice: { id: string; title: string; origin: 'upload' | 'regroup'; createdAt: string; message: { id: string; content: string; kind: 'upload' | 'regroup'; data: unknown } }): Promise<void>;
  /** The app reports on something in a conversation the owner is already having (a file they attached): added there, and unread until they look. False if it is not the user's. */
  appendNotice(userId: string, conversationId: string, message: { id: string; content: string; kind: 'upload' | 'regroup'; data: unknown; createdAt: string }): Promise<boolean>;
  /** How many conversations the app started that the owner has not opened. */
  unreadCount(userId: string): Promise<number>;
  /** False if it is not the user's. */
  markRead(userId: string, id: string): Promise<boolean>;
}

export const LINK_KINDS = ['requests', 'follow_up', 'same_episode'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];
export type LinkState = 'proposed' | 'confirmed' | 'dismissed';

/** `from` is the earlier document and `to` the later one (for `same_episode`, only an order). */
export interface DocumentLink {
  from_document_id: string;
  to_document_id: string;
  kind: LinkKind;
  source: 'auto' | 'owner';
  state: LinkState;
  reason: string | null;
  confidence: number | null;
}

export type EpisodeState = 'proposed' | 'confirmed' | 'dismissed';

export interface Episode {
  id: string;
  /** Empty means untitled: shown as the provider and the dates, which the documents themselves give. */
  title: string;
  state: EpisodeState;
  source: 'auto' | 'owner';
  created_at: string;
  /** Its documents that are shown (not set aside), oldest first. */
  document_ids: string[];
  /** The earliest and latest dates among them, and the provider most of them share. */
  first_date: string | null;
  last_date: string | null;
  provider: string | null;
}

export interface EpisodeRepository {
  /** The user's episodes, in the states asked for (all by default), most recent first. */
  list(userId: string, states?: EpisodeState[]): Promise<Episode[]>;
  find(userId: string, id: string): Promise<Episode | null>;
  /**
   * Makes an episode of these documents, which must all be the user's. A document already in a proposed or confirmed episode
   * leaves it for this one (and an episode left with fewer than one document goes). Returns false, changing nothing, if a
   * document is not the user's.
   */
  create(userId: string, episode: { id: string; title: string; state: EpisodeState; source: 'auto' | 'owner'; documentIds: string[] }, createdAt: string): Promise<boolean>;
  /** The title (may be empty). False if the episode is not the user's. */
  rename(userId: string, id: string, title: string): Promise<boolean>;
  setState(userId: string, id: string, state: EpisodeState): Promise<boolean>;
  /** Replaces its documents; the same rules as `create`. False if the episode or a document is not the user's. */
  setDocuments(userId: string, id: string, documentIds: string[]): Promise<boolean>;
  remove(userId: string, id: string): Promise<boolean>;
  /** Of these ids, the ones that are the user's confirmed episodes (what a share link may name). */
  confirmedAmong(userId: string, ids: string[]): Promise<string[]>;
}

export interface LinkRepository {
  /** Every link with the document at either end, any state, whose other end is also not set aside. */
  forDocument(userId: string, documentId: string): Promise<DocumentLink[]>;
  /** Links whose two ends are both among these documents (the user's, not set aside); dismissed ones included, for the caller to filter. */
  among(userId: string, documentIds: string[]): Promise<DocumentLink[]>;
  /**
   * Adds a link between two of the user's documents. A pair and kind that exist are left as they are, except that the owner
   * adding one confirms it, even after a dismissal. False if either document is not the user's, or they are the same.
   */
  add(userId: string, link: Omit<DocumentLink, 'confidence'> & { confidence?: number | null }, createdAt: string): Promise<boolean>;
  /** The owner's decision on a link. False if there is no such link. */
  setState(userId: string, fromDocumentId: string, toDocumentId: string, kind: LinkKind, state: 'confirmed' | 'dismissed'): Promise<boolean>;
  /**
   * Removes the automatic links still waiting for an answer between the document and each of these others, in either
   * direction: the pairs a search has just judged again. Confirmed and dismissed links, and suggestions about any other
   * pair, are not touched. How many.
   */
  clearProposedBetween(userId: string, documentId: string, otherIds: string[]): Promise<number>;
  /** Deletes one automatic link (never an owner's, never a dismissed one: that is a decision). False if there is none. For tidying redundant ones. */
  removeAuto(userId: string, fromDocumentId: string, toDocumentId: string, kind: LinkKind): Promise<boolean>;
  /** Pairs the owner dismissed, in either direction and any kind, among these documents: never proposed again. */
  dismissedPairs(userId: string, documentId: string): Promise<Set<string>>;
  /** Every link the user has, in any state, including those at a document that is set aside: for an export. */
  all(userId: string): Promise<DocumentLink[]>;
  /**
   * Writes a link as it was exported, source and state as they were (`add` would confirm an owner's, even a dismissed one).
   * A pair and kind that exist are left as they are. False if either document is not the user's, or they are the same.
   */
  restore(userId: string, link: DocumentLink, createdAt: string): Promise<boolean>;
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

/** What a device needs to open an account's vault. Every value is opaque to the server: sealed, or public. */
export interface VaultKeys {
  kdf_salt: string;
  kdf_params: string;
  wrapped_by_master: string;
  wrapped_by_recovery: string;
  public_key: string;
  wrapped_private_key: string;
}

/** The keys again with the counters the server keeps. */
export interface VaultKeysRecord extends VaultKeys {
  user_id: string;
  seq: number;
  created_at: string;
  updated_at: string;
}

export interface VaultObjectMeta {
  id: string;
  profile_id: string;
  kind: string;
  seq: number;
  size: number;
  wrapped_key: string;
  deleted: boolean;
  created_at: string;
  updated_at: string;
}

export interface NewVaultObject {
  id: string;
  profileId: string;
  kind: string;
  size: number;
  wrappedKey: string;
  /** The `seq` the writer last saw for this object, 0 for a new one. A different current value is a conflict. */
  baseSeq: number;
}

export type VaultPut = { seq: number } | 'conflict' | 'no_vault' | 'quota';

export interface VaultRepository {
  getKeys(userId: string): Promise<VaultKeysRecord | null>;
  /** Only when the account has none; false otherwise. */
  putKeys(userId: string, keys: VaultKeys, now: string): Promise<boolean>;
  /** The same account key under new wrappings (a new master password, a new recovery kit). Objects are untouched. */
  replaceKeys(userId: string, keys: VaultKeys, now: string): Promise<boolean>;
  /** Everything changed after `since`, deletions included, oldest change first. */
  list(userId: string, since: number): Promise<VaultObjectMeta[]>;
  get(userId: string, id: string): Promise<VaultObjectMeta | null>;
  /** Writes the row only. `maxBytes` is the account's allowance over its live objects, counting this one's new size. */
  put(userId: string, object: NewVaultObject, now: string, maxBytes: number): Promise<VaultPut>;
  /** A tombstone, so another device learns of the deletion; false if there is no such live object or `baseSeq` is stale. */
  remove(userId: string, id: string, baseSeq: number, now: string): Promise<{ seq: number } | false>;
  usage(userId: string): Promise<{ objects: number; bytes: number }>;
  /** Removes the vault and every object row; the ids, so the caller can delete the files. */
  erase(userId: string): Promise<string[]>;
}

/** A link's sealed copy, as the server knows it: when it ends, whether it needs approval, how big it is. Nothing of what is in it. */
export interface SharedBundle {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  requireApproval: boolean;
  size: number;
  blobs: number;
  blobBytes: number;
  revokedAt: string | null;
}

export interface SharedRequest {
  id: string;
  bundleId: string;
  visitorKey: string;
  status: 'pending' | 'approved' | 'denied';
  wrappedKey: string | null;
  note: string | null;
  country: string | null;
  requestedAt: string;
  decidedAt: string | null;
}

export interface SharedOpen {
  id: number;
  bundleId: string;
  at: string;
  country: string | null;
  documentId: string | null;
  countView: boolean;
}

export interface SharedRepository {
  /** Public: by the id in the link. Revoked and expired ones are returned as they are; the caller decides. */
  get(id: string): Promise<SharedBundle | null>;
  /** The owner's: makes the row, or replaces its metadata when the same owner publishes again; 'taken' if the id is someone else's. */
  put(userId: string, bundle: { id: string; expiresAt: string; requireApproval: boolean; size: number; blobs: number; blobBytes: number }, now: string): Promise<'ok' | 'taken' | 'revoked'>;
  /** Counts a sealed file uploaded beside the database. */
  addBlob(userId: string, id: string, bytes: number): Promise<boolean>;
  /** A change of end date or approval, for the owner's own live bundle. */
  update(userId: string, id: string, patch: { expiresAt?: string; requireApproval?: boolean }): Promise<boolean>;
  /** Ends it now and forgets every wrapped key; false if it is not this owner's or already revoked. */
  revoke(userId: string, id: string, now: string): Promise<boolean>;
  /** Live bundles and the bytes they hold, for the owner's limits. */
  usage(userId: string, now: string): Promise<{ bundles: number; bytes: number }>;
  /** Bundles that have ended (past their end, or revoked) and still have files: their wrapped keys are forgotten and their sizes zeroed, and the ids come back so the caller deletes the files. */
  endedWithFiles(now: string): Promise<Array<{ id: string; userId: string }>>;
  /** Removes the rows of bundles that ended more than `graceMs` ago (the row is what tells a late visitor that it ended). */
  forgetEnded(now: string, graceMs: number): Promise<number>;
  /** Every bundle id of one owner, for deleting an account; the rows are removed. */
  eraseFor(userId: string): Promise<string[]>;

  /** Public: a browser asks. Null when too many wait already, or the browser asked before (then `getRequest` has the answer). */
  createRequest(bundleId: string, request: { id: string; visitorKey: string; note: string | null; country: string | null; requestedAt: string }, maxWaiting: number): Promise<SharedRequest | 'waiting' | 'known'>;
  getRequest(bundleId: string, id: string): Promise<SharedRequest | null>;
  /** The owner's: requests their device has not collected. */
  pendingRequests(userId: string): Promise<SharedRequest[]>;
  ackRequests(userId: string, ids: string[]): Promise<void>;
  decide(userId: string, id: string, status: 'approved' | 'denied', wrappedKey: string | null, now: string): Promise<boolean>;

  logOpen(bundleId: string, at: string, country: string | null, documentId: string | null, countView: boolean): Promise<void>;
  pendingOpens(userId: string, limit: number): Promise<SharedOpen[]>;
  ackOpens(userId: string, ids: number[]): Promise<void>;
}
