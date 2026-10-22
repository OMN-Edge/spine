import { askForPassword } from './reauth';
import { startAuthentication, startRegistration, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
export type DocType =
  | 'lab_result'
  | 'discharge_note'
  | 'vaccination'
  | 'imaging'
  | 'prescription'
  | 'consultation_note'
  | 'other';

export interface Document {
  /** Only on search results: the text around a match, each match between \u0001 and \u0002. */
  snippet?: string;
  id: string;
  source_file_id: string;
  page_start: number;
  page_end: number;
  title: string | null;
  doc_date: string | null;
  provider: string | null;
  doc_type: DocType | null;
  ai_summary: string | null;
  user_notes: string | null;
  reviewed: boolean;
  /** Values read with low confidence and not yet confirmed or edited; 0 once the document is reviewed. */
  to_check?: number;
  /** What it is written in (a two-letter code), if known. */
  language: string | null;
  // populated by GET /api/documents/:id
  episode?: Pick<Episode, 'id' | 'title' | 'state' | 'first_date' | 'last_date' | 'provider'> | null;
  fields?: ExtractedField[];
  tags?: string[];
  pages?: Page[];
  measurements?: Measurement[];
  doctors?: DoctorOnDocument[];
  /** On GET /api/documents/:id: whether the owner has confirmed how its upload's pages were grouped. */
  grouping_confirmed?: boolean;
}

export type Flag = 'low' | 'high' | 'normal';
export type DoctorRole = 'author' | 'prescriber' | 'referrer' | 'other';

/** A numeric result: a lab value or a vital. */
export interface Measurement {
  id: string;
  document_id: string;
  page_id: string;
  name: string;
  canonical: string;
  value_text: string;
  value_num: number | null;
  unit: string | null;
  ref_low: number | null;
  ref_high: number | null;
  flag: Flag | null;
  taken_on: string | null;
  source_snippet: string | null;
  bbox_x0: number | null;
  bbox_y0: number | null;
  bbox_x1: number | null;
  bbox_y1: number | null;
  confidence: number | null;
  /** Low confidence and not edited by the owner: marked "check" until the document is reviewed. */
  needs_check?: boolean;
}

/** Documents the owner groups as belonging together; the app proposes them from the data and the owner confirms (FR-ORG-01). */
export interface Episode {
  id: string;
  /** Empty means untitled: shown as the provider and the dates (`episodeName`). */
  title: string;
  state: 'proposed' | 'confirmed' | 'dismissed';
  source: 'auto' | 'owner';
  created_at: string;
  document_ids: string[];
  first_date: string | null;
  last_date: string | null;
  provider: string | null;
}

export interface DoctorOnDocument {
  id: string;
  name: string;
  specialty: string | null;
  clinic: string | null;
  license_code: string | null;
  role: DoctorRole;
}

/** One test across all documents, for the list of trends. */
export interface TrendName {
  canonical: string;
  name: string;
  unit: string | null;
  count: number;
  latest_value_text: string;
  latest_taken_on: string | null;
  latest_flag: Flag | null;
}

export interface TrendPoint {
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
  flag: Flag | null;
  /** Whether it can be drawn with the others: a number, dated, in the same unit. */
  charted: boolean;
  /** The same test, day and value as another point that is drawn (a consultation quoting a lab). */
  repeat: boolean;
}

export interface TrendSeries {
  canonical: string;
  name: string;
  unit: string | null;
  points: TrendPoint[];
}

export interface DoctorEntry {
  id: string;
  name: string;
  specialty: string | null;
  clinic: string | null;
  license_code: string | null;
  created_at: string;
  document_count: number;
  last_seen: string | null;
}

export interface DoctorSummary {
  id: string;
  name: string;
  specialty: string | null;
  document_count: number;
}

export interface DoctorDetail extends Omit<DoctorEntry, 'document_count' | 'last_seen'> {
  documents: Array<{ id: string; title: string | null; doc_type: DocType | null; doc_date: string | null; provider: string | null; role: DoctorRole }>;
}

export interface DocumentTypeGuide {
  type: DocType;
  label: string;
  fields: string[];
  grouped: string[];
}

/** A document an upload produced, as the upload endpoints list it. */
/** A model that can be picked for a reading; the default is what uploads use. */
export interface ModelChoice {
  id: string;
  label: string;
  default: boolean;
  /** Where a reading with this model would go. */
  endpoint: string | null;
}

export interface UploadDocument {
  id: string;
  title: string | null;
  doc_type: DocType | null;
  doc_date: string | null;
  provider: string | null;
  page_start: number;
  page_end: number;
  reviewed: boolean | number;
  /** Only on the regrouping screen: every page of this document is hidden, so it is left out everywhere else. */
  hidden?: boolean;
  /** Nothing has been read from its text yet: that happens when the grouping is confirmed. */
  needs_reading?: boolean;
  /** Until then, the first line of its first page, as a label to recognise it by. */
  title_guess?: string | null;
}

export interface UploadSummary {
  id: string;
  uploaded_at: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  error_message: string | null;
  page_count: number | null;
  /** False until the owner confirms how the pages were grouped; the documents are out of the timeline until then. */
  grouping_confirmed?: boolean;
  documents: UploadDocument[];
  /** Documents whose every page is hidden: not in `documents`, but there. */
  hidden_documents?: number;
}

export interface UploadLayout extends UploadSummary {
  /** The documents are read after the grouping is confirmed: how far that is, if it has started. */
  reading?: { status: 'running' | 'done' | 'failed'; step: string; progress: number; documents: number; read: number; error?: string } | null;
  pages: Array<{ id: string; page_number: number; image_width: number; image_height: number; extraction_source: string | null; hidden: boolean; source_page: number; rotation: number }>;
}

/** One edit session: the details, the tags and the extracted fields, saved together. */
export interface DocumentEdit {
  title?: string;
  doc_date?: string;
  provider?: string;
  doc_type?: string;
  ai_summary?: string;
  user_notes?: string;
  language?: string | null;
  reviewed?: boolean;
  tags?: string[];
  fields?: {
    update?: Array<{ id: string; label: string; value: string }>;
    remove?: string[];
    add?: Array<{ label: string; value: string; page_id: string }>;
  };
  measurements?: {
    update?: Array<MeasurementInput & { id: string }>;
    remove?: string[];
    add?: Array<MeasurementInput & { page_id: string }>;
  };
  /** The document's doctors: this list replaces the current one. */
  doctors?: Array<{ id?: string; new?: boolean; name: string; specialty: string | null; role: DoctorRole }>;
}

export interface MeasurementInput {
  name: string;
  canonical: string;
  value: string;
  unit: string | null;
  ref_low: string | null;
  ref_high: string | null;
  taken_on: string | null;
}

export interface AiReadingJob {
  source_file_id: string;
  status: 'running' | 'done' | 'failed';
  progress: number;
  step: string;
  pages_total: number;
  pages_read: number;
  documents_updated: number;
  documents_not_updated: number;
  error?: string;
}

export interface Page {
  id: string;
  source_file_id: string;
  page_number: number;
  /** Degrees clockwise the image has been turned; also makes a turned image a new address, so no copy of the old one is shown. */
  rotation?: number;
  image_width: number;
  image_height: number;
  raw_text: string | null;
  elements: string | null;
  extraction_source: 'native_text' | 'ocr' | 'mixed' | 'multimodal' | 'unread' | null;
  is_continuation: boolean | null;
  continuation_confidence: number | null;
  continuation_reasoning: string | null;
  reviewed: boolean;
}

export interface ExtractedField {
  id: string;
  document_id: string;
  page_id: string;
  label: string;
  value: string;
  /** Fields with the same number belong together (one prescription line). */
  group_no: number | null;
  source_snippet: string | null;
  bbox_x0: number | null;
  bbox_y0: number | null;
  bbox_x1: number | null;
  bbox_y1: number | null;
  confidence: number | null;
  needs_check?: boolean;
}

export type RelatedReason =
  | { kind: 'tests' | 'doctors' | 'tags'; names: string[] }
  | { kind: 'provider' }
  | { kind: 'meaning'; score: number };

export interface RelatedDocument {
  id: string; title: string | null; doc_type: DocType | null; doc_date: string | null; provider: string | null;
  score: number; reasons: RelatedReason[];
  /** The title in the reader's language, when it has been translated. */
  translated_title?: string | null;
}

export type LinkKind = 'requests' | 'follow_up' | 'same_episode';

export interface ChainNode { id: string; title: string | null; doc_type: DocType | null; doc_date: string | null; provider: string | null }
/** `from` is the earlier document. A `proposed` link was found by the app and waits for the owner. */
export interface ChainEdge { from: string; to: string; kind: LinkKind; state: 'proposed' | 'confirmed'; source: 'auto' | 'owner'; why: LinkWhy | null }
/** The signals behind a suggested connection (shared tests, doctors, tags, provider, days apart, closeness in meaning). */
export interface LinkWhy { tests?: string[]; doctors?: string[]; tags?: string[]; same_provider?: true; days_apart?: number; similarity?: number }
export interface Chain { enabled: boolean; searching: boolean; nodes: ChainNode[]; edges: ChainEdge[] }

/** What a recipient sees around a shared document: confirmed links (direction and kind only) and similar shared documents. */
export interface SharedConnections {
  chain: { nodes: ChainNode[]; edges: Array<{ from: string; to: string; kind: LinkKind }> } | null;
  related: Array<ChainNode & { reasons: Array<{ kind: 'tests' | 'doctors'; names: string[] } | { kind: 'meaning' }> }>;
}

export interface ChatSource {
  label: string; id: string; title: string | null; doc_type: DocType | null; doc_date: string | null;
  /** The part of the document page the answer came from, if it pointed at one. */
  section?: 'summary' | 'notes' | 'doctors' | 'results' | 'fields' | 'chain';
}
/** `answer` is null when no document matched the question: nothing was asked of the model. */
/** A change the chat prepared. It has done nothing: the person confirms it, and Confirm sends `calls` (or, for a share link, what the card builds). */
export interface DocRef { id: string; title: string | null; doc_type: Document['doc_type']; doc_date: string | null; page_start?: number; page_end?: number }
export interface ProposedCall { method: 'POST' | 'PATCH' | 'DELETE'; path: string; body?: unknown }
export type DetailChange =
  | { what: 'title' | 'doc_date' | 'provider' | 'doc_type'; from: string | null; to: string | null }
  | { what: 'field_update'; label: string; from: string; to: string }
  | { what: 'field_add'; label: string; to: string }
  | { what: 'field_remove'; label: string; from: string }
  | { what: 'result_update'; name: string; from: string; to: string }
  | { what: 'result_add'; name: string; to: string }
  | { what: 'result_remove'; name: string; from: string };
export interface LibraryEntry { id: number | null; name: string; count: number }
export interface DoctorEntry { id: string; name: string; specialty: string | null; clinic: string | null; license_code: string | null; document_count: number }
export interface TestEntry { canonical: string; name: string; count: number; units: string[] }
export type Proposal = { id: string } & (
  | { kind: 'share_link'; documents: DocRef[]; label: string | null; expires_days: number; language: string | null; require_approval: boolean; include_scans: boolean; allow_chat: boolean; approval_mail: boolean }
  | { kind: 'add_note'; document: DocRef; text: string; calls: ProposedCall[] }
  | { kind: 'edit_document'; document: DocRef; changes: DetailChange[]; calls: ProposedCall[] }
  | { kind: 'tag_documents'; items: Array<{ document: DocRef; add: string[]; remove: string[] }>; calls: ProposedCall[] }
  | { kind: 'mark_reviewed'; documents: DocRef[]; calls: ProposedCall[] }
  | { kind: 'link_documents'; from: DocRef; to: DocRef; link_kind: 'requests' | 'follow_up' | 'same_episode'; calls: ProposedCall[] }
  | { kind: 'merge_doctors'; groups: Array<{ keep: DoctorEntry; merge: DoctorEntry[]; final: { name: string; specialty: string | null; clinic: string | null; license_code: string | null } }> }
  | { kind: 'merge_tests'; groups: Array<{ into: TestEntry; from: TestEntry[]; final_name: string }> }
  | { kind: 'confirm_grouping'; upload: { id: string; file_name: string | null; uploaded_at: string }; documents: DocRef[]; calls: ProposedCall[] }
  | { kind: 'rotate_page'; upload: { id: string; file_name: string | null }; page: { id: string; number: number }; degrees: 90 | 180 | 270; calls: ProposedCall[] }
  | { kind: 'hide_page'; upload: { id: string; file_name: string | null }; page: { id: string; number: number }; hidden: boolean; document: DocRef | null; calls: ProposedCall[] }
  | { kind: 'move_page'; upload: { id: string; file_name: string | null }; page: { id: string; number: number }; from: DocRef; to: DocRef | null; before_page: number | null; calls: ProposedCall[] }
  | { kind: 'merge_documents'; upload: { id: string; file_name: string | null }; into: DocRef; from: DocRef; page_numbers: number[]; calls: ProposedCall[] }
  | { kind: 'decide_links'; items: Array<{ label: string; from: DocRef; to: DocRef; link_kind: LinkKind; decision: 'confirm' | 'dismiss'; why: LinkWhy | null }>; calls: ProposedCall[] }
  | { kind: 'analyse_pages'; upload: { id: string; file_name: string | null; uploaded_at: string }; pages: number; calls: ProposedCall[] }
  | { kind: 'regroup'; upload: { id: string; file_name: string | null }; groups: Array<{ label: string; page_ids: string[]; page_numbers: number[]; title: string | null; confidence: number; status: 'validated' | 'uncertain' | 'unchecked'; reason: string; from: DocRef[] }> }
  | { kind: 'reread_pages'; document: DocRef; page_numbers: number[]; strategy: 'model' | 'configured'; sends_images: boolean; calls: ProposedCall[] }
  | { kind: 'merge_library'; library: 'tags' | 'providers'; groups: Array<{ keep: LibraryEntry; merge: LibraryEntry[]; final_name: string }> }
  | { kind: 'update_share'; link: { id: string; label: string | null; expires_at: string }; label: { from: string | null; to: string | null } | null; expires: { from: string; to_days: number } | null; added: DocRef[]; removed: DocRef[]; total_after: number | null; calls: ProposedCall[] }
  | { kind: 'revoke_share'; link: { id: string; label: string | null; expires_at: string }; calls: ProposedCall[] }
);
export interface ChatReply { answer: string | null; sources: ChatSource[]; documents: number; looked?: string[]; proposals?: Proposal[]; conversation: { id: string; title: string } }
/** What the agent is looking at while it works; the page words it. */
export interface ChatStep { kind: 'search' | 'open' | 'series' | 'tests' | 'connections' | 'fields' | 'shares' | 'doctors' | 'uploads' | 'plan' | 'library' | 'propose'; detail?: string }
export interface ChatStreamHandlers {
  step: (step: ChatStep) => void;
  delta: (text: string) => void;
  /** What was shown was a lead-in, not the answer: clear it. */
  reset: () => void;
}
export interface ConversationSummary {
  id: string; title: string; created_at: string; updated_at: string; message_count: number;
  /** The app started it (an upload finished) and the person has not opened it. */
  unread: boolean;
  origin: 'upload' | 'regroup' | null;
}
/** What the app wrote when the analysis of a mixed upload finished. */
export interface RegroupNotice {
  upload_id: string; file_name: string | null; pages_considered: number; groups_changed: number; groups_validated: number; unchanged_groups: number;
  groups: Array<{ page_numbers: number[]; title: string | null; status: string; confidence: number }>;
}
/** What the app wrote when an upload had been read; the page draws it in the person's language. */
export interface UploadNotice {
  upload_id: string; state: 'done' | 'failed'; file_name: string | null; pages: number;
  documents: DocRef[]; more_documents: number; unread_pages: number; undated_documents: number; grouping_pending: boolean;
  /** The documents have not been read yet: that happens when the grouping is confirmed. */
  reading_pending?: boolean;
  doctors_added: string[]; doctors_matched: number; possible_duplicates: Array<[string, string]>; tests_new: string[]; looks_mixed: boolean;
  /** Matches waiting for an answer when the report was written; the page asks again, live, for the ones still open. */
  matches_open?: number;
}
/** Something this upload brought that may be the same as something already held, or a professional code that differs: a question for the owner. */
export interface MatchEntry { name: string; detail: string | null; count: number; doctor_id?: string; tag_id?: number; canonical?: string; units?: string[] }
export interface MatchQuestion {
  id: string; kind: 'doctor' | 'test' | 'tag' | 'provider' | 'code';
  new: MatchEntry; existing: MatchEntry | null; keep: 'new' | 'existing';
  reason: 'initial' | 'fuller_name' | 'punctuation' | 'legal_suffix' | 'contained' | 'spelling' | 'prefix' | 'different_code';
  strength: 'likely' | 'unsure' | 'clash';
  codes?: { directory: string; printed: string; documents: number };
  unit_mismatch?: boolean;
}
/** A file attached in the chat, as it was accepted. */
export interface AttachedFile { name: string | null; upload_id: string | null; state: 'reading' | 'already_held' | 'skipped'; reason: string | null }
export interface AttachmentData { files: AttachedFile[] }
export interface StoredMessage { id: string; role: 'user' | 'assistant'; content: string; sources: ChatSource[]; note: 'none' | 'failed' | 'off' | null; created_at: string; kind: 'upload' | 'regroup' | 'attachment' | null; data: UploadNotice | RegroupNotice | AttachmentData | null }

export interface ShareLink {
  id: string;
  label: string | null;
  scope: 'all' | 'tag' | 'document_ids' | 'date_range' | 'episode';
  scope_value: string | null;
  created_at: string;
  expires_at: string;
  revoked: boolean;
  view_count: number;
  last_accessed_at: string | null;
  /** The recipient may also see the page images. */
  include_scans: boolean;
  /** The language the recipient's page starts in, if the owner chose one. */
  language: string | null;
  /** A visitor's browser must be approved by the owner before it reads anything. */
  require_approval: boolean;
  /** The recipient may ask questions about what the link shares. */
  allow_chat: boolean;
  /** Browsers waiting to be let in. */
  pending_requests: number;
}

/** A browser asking to open a link that needs approval. `note`, `ip_address` and `user_agent` are the visitor's own words. */
export interface ShareRequest {
  id: string;
  share_link_id: string;
  link_label: string | null;
  /** The link can still be opened: approving a request on a dead link changes nothing. */
  link_active: boolean;
  status: 'pending' | 'approved' | 'denied';
  note: string | null;
  ip_address: string | null;
  user_agent: string | null;
  requested_at: string;
  decided_at: string | null;
}

/** What has happened to a link since it was made. `detail` is JSON: for `changed`, `{ changes: [{ field, from, to }] }`. */
export interface ShareLinkEvent { at: string; kind: 'created' | 'changed' | 'revoked' | 'approved' | 'denied'; detail: string | null }
export interface ShareLinkDetail {
  link: ShareLink;
  /** What it shares now, resolved the way a recipient's read resolves it. */
  documents: Array<{ id: string; title: string | null; doc_date: string | null; doc_type: Document['doc_type']; provider: string | null }>;
  scope_ok: boolean;
  access: { total: number; first_at: string | null; last_at: string | null; addresses: Array<{ ip_address: string | null; country: string | null; count: number; last_at: string }>; recent: Array<{ accessed_at: string; ip_address: string | null; country: string | null; document_id: string | null }> };
  requests: ShareRequest[];
  events: ShareLinkEvent[];
}
export interface ShareLinkChange { label?: string | null; expires_days?: number; expires_hours?: number; include_scans?: boolean; require_approval?: boolean; allow_chat?: boolean; language?: string | null; scope?: string; scope_value?: unknown }

/** Where a visitor's browser stands with a link that needs approval. */
export type ShareApproval = 'open' | 'needed' | 'pending' | 'denied';

/** A document in the reader's language: the details and the owner's notes, translated and kept (see translation.ts). */
export interface TranslatedDocument {
  language: string;
  source_language: string | null;
  /** `same`: already in that language. `off`: translating is switched off here. */
  status: 'same' | 'cached' | 'translated' | 'off';
  /** `head`: the title, summary, notes and specialties, which come first; the fields and results follow in `full`. */
  part: 'head' | 'full';
  title: string | null;
  ai_summary: string | null;
  user_notes: string | null;
  fields: Record<string, { label: string | null; value: string }>;
  measurements: Record<string, string>;
  doctors: Record<string, string | null>;
}

/** A shared document as the list gives it in a language: what is already translated, or that it is on its way. */
export type SharedListDocument = Document & {
  translation?: { status: TranslatedDocument['status']; title: string | null; ai_summary: string | null; user_notes: string | null } | null;
  translation_pending?: boolean;
};

/** What a share recipient can open: one document's details, and its pages only if scans were allowed. */
export interface SharedDocument {
  document: {
    id: string; title: string | null; doc_date: string | null; provider: string | null; doc_type: string | null;
    ai_summary: string | null; user_notes: string | null; language: string | null; page_start: number; page_end: number;
  };
  fields: Array<{ id: string; label: string; value: string; group_no: number | null }>;
  measurements: Array<{
    id: string; name: string; value_text: string; unit: string | null; ref_low: number | null; ref_high: number | null;
    flag: string | null; taken_on: string | null;
  }>;
  doctors: Array<{ id: string; name: string; specialty: string | null; role: string }>;
  tags: string[];
  scans: boolean;
  pages: Array<{ id: string; page_number: number; image_width: number; image_height: number }>;
}

/** An error response, with the machine-readable `code` when the server sent one. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function req<T>(url: string, options?: RequestInit, retried = false): Promise<T> {
  const res = await fetch(url, {
    // Only a request that sends JSON says so. Fastify refuses an empty body that claims to
    // be JSON, so a POST with no body (sign out, extract again, read the whole file again)
    // used to fail with a 400 whenever it came from the app.
    headers: options?.body !== undefined ? { 'Content-Type': 'application/json' } : {},
    ...options,
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({ error: res.statusText }))) as {
      error?: string;
      code?: string;
    };
    // A sensitive action asks for the password again; once it is typed the same request goes through (S-33).
    if (res.status === 403 && err.code === 'reauth_required' && !retried && (await askForPassword())) {
      return req<T>(url, options, true);
    }
    throw new ApiError(err.error ?? res.statusText, res.status, err.code);
  }
  return res.json() as Promise<T>;
}

/**
 * A question whose reply comes as JSON lines (NDJSON): what the agent is looking up (`step`), the answer as it is written (`delta`),
 * `reset` when what was shown was a lead-in, then `done` with the reply or `error`. Nothing is trusted until `done`. Used by the
 * owner's chat and by a share recipient's.
 */
async function readReplyStream<T>(url: string, body: unknown, handlers: ChatStreamHandlers, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify(body) });
  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string; code?: string };
    throw new ApiError(err.error ?? res.statusText, res.status, err.code);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reply: T | null = null;
  const handle = (text: string) => {
    if (!text.trim()) return;
    const event = JSON.parse(text) as { type: string; text?: string; reply?: T; status?: number; error?: string } & Partial<ChatStep>;
    if (event.type === 'step' && event.kind) handlers.step({ kind: event.kind, detail: event.detail });
    else if (event.type === 'delta' && event.text) handlers.delta(event.text);
    else if (event.type === 'reset') handlers.reset();
    else if (event.type === 'done' && event.reply) reply = event.reply;
    else if (event.type === 'error') throw new ApiError(event.error ?? 'could not answer', event.status ?? 502);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: !done });
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) { handle(buffer.slice(0, at)); buffer = buffer.slice(at + 1); }
    if (done) break;
  }
  handle(buffer);
  if (!reply) throw new ApiError('could not answer', 502);
  return reply;
}

const post = <T>(url: string, body: unknown) =>
  req<T>(url, { method: 'POST', body: JSON.stringify(body) });

const patch = <T>(url: string, body: unknown) =>
  req<T>(url, { method: 'PATCH', body: JSON.stringify(body) });

const del = <T>(url: string) =>
  req<T>(url, { method: 'DELETE' });

export const api = {
  trends: {
    names: () => req<TrendName[]>('/api/measurements'),
    /** `from`'s values are counted as `into`, and later documents that use `from` are filed there too. */
    merge: (from: string, into: string) => post<{ ok: boolean; canonical: string }>('/api/measurements/merge', { from, into }),
    series: (canonical: string) => req<TrendSeries>(`/api/measurements/series?name=${encodeURIComponent(canonical)}`),
    rename: (from: string, to: string) => post<{ result: 'ok' | 'merged'; canonical: string }>('/api/measurements/rename', { from, to }),
    remove: (canonical: string) => del<{ removed: number }>(`/api/measurements?name=${encodeURIComponent(canonical)}`),
  },


  doctors: {
    list: () => req<DoctorEntry[]>('/api/doctors'),
    /** Pairs of entries that are probably one person; `keep` is the fuller name. The owner confirms. */
    duplicates: () => req<Array<{ keep: DoctorSummary; other: DoctorSummary }>>('/api/doctors/duplicates'),
    get: (id: string) => req<DoctorDetail>(`/api/doctors/${id}`),
    update: (id: string, change: { name?: string; specialty?: string | null; clinic?: string | null; license_code?: string | null }) =>
      patch<{ ok: boolean }>(`/api/doctors/${id}`, change),
    /** `from` is folded into `id` and removed. */
    merge: (id: string, from: string) => post<{ ok: boolean }>(`/api/doctors/${id}/merge`, { from }),
    remove: async (id: string) => {
      const res = await fetch(`/api/doctors/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
        throw new ApiError(err.error ?? res.statusText, res.status);
      }
    },
  },

  documentTypes: () => req<DocumentTypeGuide[]>('/api/document-types'),

  auth: {
    /** Either signed in, or the password was right and a second factor is still needed. */
    login: (email: string, password: string) =>
      req<{ ok?: boolean; email?: string; second_factor_required?: boolean }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      }),
    secondFactor: (code: string) =>
      post<{ ok: boolean; email: string }>('/api/auth/login/second-factor', { code }),
    logout: () => req('/api/auth/logout', { method: 'POST' }),
    me: () => req<{ authenticated: boolean; email: string; second_factor_enabled?: boolean; consent_needed?: { health: boolean; terms: boolean } }>('/api/auth/me'),
    options: () => req<{ registration: 'operator' | 'open'; recovery: boolean }>('/api/auth/options'),
    register: (email: string, password: string, consent: { health_data: boolean; terms: boolean }) =>
      post<{ ok: boolean; message: string }>('/api/auth/register', { email, password, consent_health_data: consent.health_data, accept_terms: consent.terms }),
    /** Passkeys: sign in with the device; manage them from the account page. */
    passkeys: {
      supported: () => typeof window !== 'undefined' && !!window.PublicKeyCredential,
      list: () => req<Array<{ id: string; name: string; backed_up: boolean; created_at: string; last_used_at: string | null }>>('/api/auth/passkeys'),
      add: async (name: string) => {
        const options = await post<PublicKeyCredentialCreationOptionsJSON>('/api/auth/passkeys/options', {});
        const response = await startRegistration({ optionsJSON: options });
        return post<{ ok: boolean }>('/api/auth/passkeys', { response, name });
      },
      rename: (id: string, name: string) => patch<{ ok: boolean }>(`/api/auth/passkeys/${encodeURIComponent(id)}`, { name }),
      remove: (id: string) => del<{ ok: boolean }>(`/api/auth/passkeys/${encodeURIComponent(id)}`),
      signIn: async () => {
        const options = await post<PublicKeyCredentialRequestOptionsJSON>('/api/auth/passkey/options', {});
        const response = await startAuthentication({ optionsJSON: options });
        return post<{ ok: boolean; email: string }>('/api/auth/passkey/login', { response });
      },
    },
    verify: (token: string) => post<{ ok: boolean }>('/api/auth/verify', { token }),
    resendVerification: (email: string) =>
      post<{ ok: boolean; message: string }>('/api/auth/resend-verification', { email }),
    forgot: (email: string) => post<{ ok: boolean; message: string }>('/api/auth/forgot', { email }),
    reset: (token: string, password: string) =>
      post<{ ok: boolean }>('/api/auth/reset', { token, password }),
    changePassword: (current: string, next: string) =>
      post<{ ok: boolean }>('/api/auth/password', { current, next }),
    /** Whether the password was typed recently enough for the actions that ask for it again. */
    reauthStatus: () => req<{ fresh: boolean }>('/api/auth/reauth'),
    reauth: (password: string, code?: string) => post<{ ok: boolean }>('/api/auth/reauth', code ? { password, code } : { password }),
    sessions: {
      list: () => req<Array<{ id: string; created_at: string; last_seen_at: string; user_agent: string; address: string; current: boolean }>>('/api/auth/sessions'),
      end: (id: string) => req<{ ok: boolean }>(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      endOthers: () => post<{ ok: boolean; ended: number }>('/api/auth/sessions/end-others', {}),
    },
    totp: {
      status: () => req<{ enabled: boolean; recovery_codes_left: number }>('/api/auth/totp'),
      setup: (password: string) =>
        post<{ secret: string; otpauth_uri: string }>('/api/auth/totp/setup', { password }),
      enable: (code: string) => post<{ ok: boolean; recovery_codes: string[] }>('/api/auth/totp/enable', { code }),
      disable: (password: string, code: string) => post<{ ok: boolean }>('/api/auth/totp/disable', { password, code }),
      newRecoveryCodes: (password: string, code: string) =>
        post<{ ok: boolean; recovery_codes: string[] }>('/api/auth/totp/recovery-codes', { password, code }),
    },
  },

  chat: {
    status: () => req<{ enabled: boolean }>('/api/chat/status'),
    /**
     * In a conversation, or in a new one when `conversationId` is null; the server keeps both sides, once it has an answer.
     * The reply arrives as lines (steps, pieces of the answer, then the whole reply), so the page can show it as it is written.
     * Refusals before the first byte are ordinary errors; a failure after it comes as an `error` line.
     */
    ask: (question: string, conversationId: string | null, screen: Record<string, unknown> | undefined, handlers: ChatStreamHandlers, signal?: AbortSignal): Promise<ChatReply> =>
      readReplyStream<ChatReply>('/api/chat', { question, conversation_id: conversationId ?? undefined, screen, stream: true }, handlers, signal),
    conversations: () => req<ConversationSummary[]>('/api/chat/conversations'),
    conversation: (id: string) => req<ConversationSummary & { messages: StoredMessage[] }>(`/api/chat/conversations/${id}`),
    unread: () => req<{ count: number }>('/api/chat/unread'),
    /** Attach files: the ordinary upload, tied to a conversation (a new one if none is named), which then hears what happens to them. */
    attach: async (files: File[], conversationId: string | null): Promise<{ conversation: { id: string; title: string }; files: AttachedFile[] }> => {
      const form = new FormData();
      // The conversation goes first: the server reads it before the first file arrives.
      if (conversationId) form.append('conversation_id', conversationId);
      for (const file of files) form.append('files', file, file.name);
      const res = await fetch('/api/chat/attachments', { method: 'POST', body: form });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string; code?: string };
        throw new ApiError(err.error ?? res.statusText, res.status, err.code);
      }
      return res.json();
    },
    markRead: (id: string) => post<{ ok: boolean }>(`/api/chat/conversations/${id}/read`, undefined),
    deleteConversation: (id: string) => del<{ ok: boolean }>(`/api/chat/conversations/${id}`),
    deleteAllConversations: () => del<{ removed: number }>('/api/chat/conversations'),
    /**
     * Confirm: sends one request a proposal carries. Only the shapes the chat prepares are run, whatever a reply says, so a
     * proposal can reach nothing but the routes it is meant to.
     */
    run: <T = unknown>(call: ProposedCall) => {
      const allowed =
        (call.method === 'PATCH' && /^\/api\/documents\/[\w-]{1,64}$/.test(call.path)) ||
        (call.method === 'POST' && (call.path === '/api/document-links' || call.path === '/api/document-links/state')) ||
        (call.method === 'POST' && /^\/api\/source-files\/[\w-]{1,64}\/(grouping\/confirm|ai-reading|regroup|regroup\/analyze|extract)$/.test(call.path)) ||
        (call.method === 'POST' && /^\/api\/pages\/[\w-]{1,64}\/(move|rotate)$/.test(call.path)) ||
        (call.method === 'PATCH' && /^\/api\/pages\/[\w-]{1,64}$/.test(call.path)) ||
        (call.method === 'POST' && /^\/api\/doctors\/[\w-]{1,64}\/merge$/.test(call.path)) ||
        (call.method === 'PATCH' && /^\/api\/doctors\/[\w-]{1,64}$/.test(call.path)) ||
        (call.method === 'POST' && (call.path === '/api/measurements/merge' || call.path === '/api/measurements/rename')) ||
        (call.method === 'DELETE' && /^\/api\/share-links\/[\w-]{1,64}$/.test(call.path)) ||
        (call.method === 'PATCH' && /^\/api\/share-links\/[\w-]{1,64}$/.test(call.path)) ||
        (call.method === 'POST' && /^\/api\/tags\/\d{1,12}\/merge$/.test(call.path)) ||
        (call.method === 'PATCH' && /^\/api\/tags\/\d{1,12}$/.test(call.path)) ||
        (call.method === 'POST' && call.path === '/api/providers/rename');
      if (!allowed) return Promise.reject(new ApiError('not a change the chat can make', 400));
      return req<T>(call.path, { method: call.method, ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}) });
    },
  },

  documents: {
    /** Documents that share a test or a doctor with this one, or read like it, and why. */
    /** Titles in a language for some of the owner's documents; `pending` while the rest are being translated. */
    titles: (ids: string[], lang: string) => req<{ titles: Record<string, string | null>; pending: boolean }>(`/api/translations/titles?lang=${lang}&ids=${ids.map(encodeURIComponent).join(',')}`),
    related: (id: string, lang?: string) => req<{ related: RelatedDocument[]; translation_pending?: boolean; meaning: { enabled: boolean; ready: boolean } }>(`/api/documents/${id}/related${lang ? `?lang=${lang}` : ''}`),
    /** The documents around this one: what asked for it, what it asked for, what follows it up. */
    chain: (id: string) => req<Chain>(`/api/documents/${id}/chain`),
    /** Looks for links again, in the background. */
    refreshChain: (id: string) => post<{ ok: boolean }>(`/api/documents/${id}/chain/refresh`, {}),
    /** The owner adds a link; `from` is the earlier document. */
    addLink: (from: string, to: string, kind: LinkKind) => post<{ ok: boolean }>('/api/document-links', { from, to, kind }),
    decideLink: (from: string, to: string, kind: LinkKind, state: 'confirmed' | 'dismissed') => post<{ ok: boolean }>('/api/document-links/state', { from, to, kind, state }),
    /** Search by words and by meaning together. */
    hybrid: (q: string) => req<Array<Document & { via: Array<'words' | 'meaning'> }>>(`/api/search/hybrid?q=${encodeURIComponent(q)}`),
    /** The document in a language, translated on demand and kept. */
    translation: (id: string, lang: string, part: 'head' | 'full' = 'full') => req<TranslatedDocument>(`/api/documents/${id}/translation?lang=${lang}&part=${part}`),
    list: (params?: Record<string, string>) => {
      const qs = params ? '?' + new URLSearchParams(params).toString() : '';
      return req<Document[]>(`/api/documents${qs}`);
    },
    get: (id: string) => req<Document>(`/api/documents/${id}`),
    /** Extract the details again from the page text already read. No image is sent. */
    /**
     * Every match, not just the first page: the server returns 50 by default and at most
     * 500, so this pages through in chunks until a short one. Without it a page showing an
     * archive would silently stop at the first 50 documents.
     */
    listAll: async (params: Record<string, string> = {}): Promise<Document[]> => {
      const all: Document[] = [];
      const size = 200;
      for (let offset = 0; ; offset += size) {
        const qs = new URLSearchParams({ ...params, limit: String(size), offset: String(offset) }).toString();
        const chunk = await req<Document[]>(`/api/documents?${qs}`);
        all.push(...chunk);
        if (chunk.length < size) return all;
      }
    },
    update: (id: string, body: DocumentEdit) =>
      req(`/api/documents/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    /** Set a whole document aside, or bring it back: every page of it at once. */
    setHidden: (id: string, hidden: boolean) =>
      req<{ hidden: boolean; document_ids: string[] }>(`/api/documents/${id}/hidden`, { method: 'PATCH', body: JSON.stringify({ hidden }) }),
    boundary: (id: string, body: ({ action: 'split'; at_page: number } | { action: 'merge'; with_document_id: string }) & { defer?: boolean }) =>
      req(`/api/documents/${id}/boundary`, { method: 'POST', body: JSON.stringify(body) }),
  },

  matches: {
    /** The questions this upload left: what may be the same as something held, and codes that differ. Live: an answered one is not there. */
    forUpload: (uploadId: string) => req<{ questions: MatchQuestion[] }>(`/api/source-files/${uploadId}/matches`),
    /** "No, they are different" / "keep the directory's code": remembered, so it is not asked again. */
    decide: (id: string, decision: 'different' | 'keep') => post<{ ok: boolean }>('/api/match-decisions', { id, decision }),
  },

  sourceFiles: {
    /** Every upload, newest first, with the documents it became. */
    list: () => req<UploadSummary[]>('/api/source-files'),
    /** The grouping is right: the upload's documents appear in the timeline and are looked at for links. */
    confirmGrouping: (id: string) => post<{ confirmed: boolean; reading?: unknown }>(`/api/source-files/${id}/grouping/confirm`, {}),
    /** What was read from one page, and how. */
    /** Move a page: into a document at a place (before a page of it, or last), or out into a document of its own. */
    movePage: (pageId: string, body: { document_id: string; before_page_id: string | null } | { new_document: true; before_document_id: string | null }) =>
      req<{ moved: boolean; touched: string[]; deleted: string[]; created: string | null }>(`/api/pages/${pageId}/move`, { method: 'POST', body: JSON.stringify(body) }),
    /** Set a page aside, or bring it back. Returns the documents that hold it, which go back to review. */
    setPageHidden: (pageId: string, hidden: boolean) =>
      req<{ hidden: boolean; document_ids: string[] }>(`/api/pages/${pageId}`, { method: 'PATCH', body: JSON.stringify({ hidden }) }),
    /** Turn a page image clockwise. Boxes drawn on it move with it; nothing is read again. */
    rotatePage: (pageId: string, degrees: 90 | 180 | 270) =>
      req<{ rotation: number; image_width: number; image_height: number }>(`/api/pages/${pageId}/rotate`, { method: 'POST', body: JSON.stringify({ degrees }) }),
    pageText: (pageId: string) =>
      req<{ id: string; page_number: number; raw_text: string | null; extraction_source: string | null }>(`/api/pages/${pageId}`),
    /** Read chosen pages with the model, then extract the documents they belong to again. */
    /** `model`: each page image goes to a model. `configured`: read the pages the way an upload does. */
    startAiReading: (id: string, pageIds: string[], model?: string, strategy: 'model' | 'configured' = 'model', thinking = false) =>
      req<AiReadingJob>(`/api/source-files/${id}/ai-reading`, {
        method: 'POST',
        body: JSON.stringify({ page_ids: pageIds, ...(model ? { model } : {}), ...(strategy === 'configured' ? { strategy } : {}), ...(thinking ? { thinking } : {}) }),
      }),
    aiReading: (id: string) => req<AiReadingJob | { status: 'idle' }>(`/api/source-files/${id}/ai-reading`),
    /** One upload's pages and how they are grouped into documents. */
    get: (id: string) => req<UploadLayout>(`/api/source-files/${id}`),
    status: (id: string) =>
      req<{ status: string; progress: number; step: string; error?: string; grouping_confirmed?: boolean; documents: UploadDocument[] }>(`/api/source-files/${id}/status`),
    capabilities: () =>
      req<{
        aiReading: { enabled: boolean; provider: string; endpoint: string | null };
        /** How an upload is read here: the parser, whether local OCR is on, and whether it can send page images. */
        reading: { mode: 'text' | 'ocr' | 'hybrid' | 'multimodal'; ocr: boolean; images: boolean };
        models: ModelChoice[];
        /** Whether documents can be found by meaning on this server. */
        similarity?: { enabled: boolean };
        /** Which features send content to the model provider on this server. */
        features?: { translation: boolean; chat: boolean; linking: boolean };
      }>('/api/capabilities'),
    /** Extract the details of some of an upload's documents again, from the text already read. */
    extract: (id: string, documentIds: string[]) =>
      req<{ results: Array<{ id: string; reread: 'done' | 'failed' | 'skipped' | 'deferred' }> }>(`/api/source-files/${id}/extract`, {
        method: 'POST', body: JSON.stringify({ document_ids: documentIds }),
      }),
    /** Delete an upload and everything made from it: documents, pages, the original and its backup copy. */
    remove: (id: string) => req<{ deleted: true }>(`/api/source-files/${id}`, { method: 'DELETE' }),
    /** Run a failed upload again, as it was first read. */
    retry: (id: string) => req<{ id: string; status: string }>(`/api/source-files/${id}/retry`, { method: 'POST' }),
    upload: (files: FileList | File[]) => {
      const form = new FormData();
      for (const f of Array.from(files)) form.append('files', f);
      return fetch('/api/source-files/upload', { method: 'POST', body: form }).then(r => r.json());
    },
    /** A scan session: the finished pages, in order, and the photos as they were taken, kept beside the document as its originals. */
    uploadScan: (pages: File[], originals: File[]) => {
      const form = new FormData();
      for (const f of pages) form.append('files', f);
      for (const f of originals) form.append('originals', f);
      return fetch('/api/source-files/upload-photos', { method: 'POST', body: form }).then(r => r.json() as Promise<Array<{ id?: string; reason?: string }>>);
    },
    /** Several photos of one document, in the order given: one upload whose pages they are. */
    uploadPhotos: (files: File[]) => {
      const form = new FormData();
      for (const f of files) form.append('files', f);
      return fetch('/api/source-files/upload-photos', { method: 'POST', body: form }).then(r => r.json());
    },
  },

  share: {
    list: () => req<ShareLink[]>('/api/share-links'),
    create: (body: { label?: string; scope: string; scope_value?: unknown; expires_days?: number; expires_hours?: number; include_scans?: boolean; language?: string | null; require_approval?: boolean; allow_chat?: boolean }) =>
      req<{ id: string; token: string; url: string; expires_at: string; approval_mail: boolean | null }>('/api/share-links', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    revoke: (id: string) => req(`/api/share-links/${id}`, { method: 'DELETE' }),
    detail: (id: string) => req<ShareLinkDetail>(`/api/share-links/${id}`),
    change: (id: string, change: ShareLinkChange) => req<{ ok: true }>(`/api/share-links/${id}`, { method: 'PATCH', body: JSON.stringify(change) }),
    requests: () => req<ShareRequest[]>('/api/share-requests'),
    request: (id: string) => req<ShareRequest>(`/api/share-requests/${id}`),
    decide: (id: string, decision: 'approve' | 'deny') =>
      req<{ ok: true; status: 'approved' | 'denied' }>(`/api/share-requests/${id}/decision`, { method: 'POST', body: JSON.stringify({ decision }) }),
  },

  publicShare: {
    documents: (token: string, lang?: string) => req<SharedListDocument[]>(`/api/share/${token}/documents${lang ? `?lang=${lang}` : ''}`),
    document: (token: string, id: string) => req<SharedDocument>(`/api/share/${token}/documents/${id}`),
    translation: (token: string, id: string, lang: string, part: 'head' | 'full' = 'full') => req<TranslatedDocument>(`/api/share/${token}/documents/${id}/translation?lang=${lang}&part=${part}`),
    /** The language the owner started the page in, the ones it can offer, and whether translating is on. */
    /** The documents the owner linked to this one and those that read alike, each only if the link shares it too. */
    connections: (token: string, id: string) => req<SharedConnections>(`/api/share/${token}/documents/${id}/connections`),
    /** Values over time, from the shared documents only. */
    trends: (token: string) => req<TrendName[]>(`/api/share/${token}/trends`),
    trendSeries: (token: string, canonical: string) => req<TrendSeries>(`/api/share/${token}/trends/series?name=${encodeURIComponent(canonical)}`),
    meta: (token: string) => req<{ language: string | null; languages: string[]; translation: boolean; approval: ShareApproval; chat: boolean; landing_url: string | null }>(`/api/share/${token}/meta`),
    /** A recipient's question. `history` is the earlier turns of this page: nothing is stored on the server. */
    chat: (token: string, body: { question: string; history: Array<{ role: 'user' | 'assistant'; content: string }>; document_id?: string }, handlers: ChatStreamHandlers, signal?: AbortSignal) =>
      readReplyStream<{ answer: string | null; sources: ChatSource[]; documents: number }>(`/api/share/${token}/chat`, { ...body, stream: true }, handlers, signal),
    /** Ask the owner to let this browser in. The first call gives the browser its cookie and tells the owner. */
    requestAccess: (token: string, note: string) => req<{ approval: ShareApproval }>(`/api/share/${token}/access-request`, { method: 'POST', body: JSON.stringify({ note }) }),
  },

  tags: {
    list: () => req<Array<{ id: number; name: string; document_count: number }>>('/api/tags'),
    /** A name another tag has makes the two one (`merged`). */
    rename: (id: number, name: string) => patch<{ result: 'ok' | 'merged' }>(`/api/tags/${id}`, { name }),
    remove: (id: number) => del<{ removed: boolean }>(`/api/tags/${id}`),
  },

  /** A legal text (the privacy notice, the terms, what Spine is for), public. */
  legal: (doc: 'privacy' | 'terms' | 'purpose') => req<{ doc: string; version: string; markdown: string }>(`/api/legal/${doc}`),

  account: {
    /** Agree to the use of health data and the terms, given apart. */
    consent: (healthData: boolean, terms: boolean) => post<{ ok: boolean }>('/api/account/consent', { health_data: healthData, terms }),
    /** Delete the account and everything in it. Asks for the password again if it has not been typed lately. */
    remove: (confirm: string) => post<{ deleted: boolean }>('/api/account/delete', { confirm }),
  },

  /** Sample records to explore before uploading anything real. */
  demo: {
    state: () => req<{ loaded: boolean; processing: boolean }>('/api/demo'),
    load: (language: 'en' | 'ro') => post<{ loaded: boolean; processing: boolean }>('/api/demo', { language }),
    remove: () => del<{ removed: boolean }>('/api/demo'),
  },

  episodes: {
    /** Proposed and confirmed by default; `all` includes the ones the owner said are not episodes. */
    list: (state?: 'proposed' | 'confirmed' | 'dismissed' | 'all') => req<Episode[]>(`/api/episodes${state ? `?state=${state}` : ''}`),
    create: (title: string, documentIds: string[]) => post<Episode>('/api/episodes', { title, document_ids: documentIds }),
    update: (id: string, change: { title?: string; document_ids?: string[] }) => patch<Episode>(`/api/episodes/${id}`, change),
    setState: (id: string, state: 'confirmed' | 'dismissed') => post<{ ok: boolean }>(`/api/episodes/${id}/state`, { state }),
    remove: (id: string) => del<{ ok: boolean }>(`/api/episodes/${id}`),
    /** Look again at what could be grouped. */
    propose: () => post<{ proposed: number }>('/api/episodes/propose', {}),
  },

  providers: {
    list: () => req<Array<{ name: string; document_count: number }>>('/api/providers'),
    /** `to` null clears it. */
    rename: (from: string, to: string | null) => post<{ changed: number }>('/api/providers/rename', { from, to }),
  },
};
