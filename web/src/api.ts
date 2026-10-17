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
  /** What it is written in (a two-letter code), if known. */
  language: string | null;
  // populated by GET /api/documents/:id
  fields?: ExtractedField[];
  tags?: string[];
  pages?: Page[];
  measurements?: Measurement[];
  doctors?: DoctorOnDocument[];
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
}

export interface UploadSummary {
  id: string;
  uploaded_at: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  error_message: string | null;
  page_count: number | null;
  documents: UploadDocument[];
  /** Documents whose every page is hidden: not in `documents`, but there. */
  hidden_documents?: number;
}

export interface UploadLayout extends UploadSummary {
  pages: Array<{ id: string; page_number: number; image_width: number; image_height: number; extraction_source: string | null; hidden: boolean; source_page: number }>;
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
  doctors?: Array<{ name: string; specialty: string | null; role: DoctorRole }>;
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
}

export type RelatedReason =
  | { kind: 'tests' | 'doctors' | 'tags'; names: string[] }
  | { kind: 'provider' }
  | { kind: 'meaning'; score: number };

export interface RelatedDocument {
  id: string; title: string | null; doc_type: DocType | null; doc_date: string | null; provider: string | null;
  score: number; reasons: RelatedReason[];
}

export interface ShareLink {
  id: string;
  label: string | null;
  scope: 'all' | 'tag' | 'document_ids' | 'date_range';
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
}

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

async function req<T>(url: string, options?: RequestInit): Promise<T> {
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
    throw new ApiError(err.error ?? res.statusText, res.status, err.code);
  }
  return res.json() as Promise<T>;
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
    me: () => req<{ authenticated: boolean; email: string; second_factor_enabled?: boolean }>('/api/auth/me'),
    options: () => req<{ registration: 'operator' | 'open'; recovery: boolean }>('/api/auth/options'),
    register: (email: string, password: string) =>
      post<{ ok: boolean; message: string }>('/api/auth/register', { email, password }),
    verify: (token: string) => post<{ ok: boolean }>('/api/auth/verify', { token }),
    resendVerification: (email: string) =>
      post<{ ok: boolean; message: string }>('/api/auth/resend-verification', { email }),
    forgot: (email: string) => post<{ ok: boolean; message: string }>('/api/auth/forgot', { email }),
    reset: (token: string, password: string) =>
      post<{ ok: boolean }>('/api/auth/reset', { token, password }),
    changePassword: (current: string, next: string) =>
      post<{ ok: boolean }>('/api/auth/password', { current, next }),
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

  documents: {
    /** Documents that share a test or a doctor with this one, or read like it, and why. */
    related: (id: string) => req<{ related: RelatedDocument[]; meaning: { enabled: boolean; ready: boolean } }>(`/api/documents/${id}/related`),
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

  sourceFiles: {
    /** Every upload, newest first, with the documents it became. */
    list: () => req<UploadSummary[]>('/api/source-files'),
    /** What was read from one page, and how. */
    /** Move a page: into a document at a place (before a page of it, or last), or out into a document of its own. */
    movePage: (pageId: string, body: { document_id: string; before_page_id: string | null } | { new_document: true; before_document_id: string | null }) =>
      req<{ moved: boolean; touched: string[]; deleted: string[]; created: string | null }>(`/api/pages/${pageId}/move`, { method: 'POST', body: JSON.stringify(body) }),
    /** Set a page aside, or bring it back. Returns the documents that hold it, which go back to review. */
    setPageHidden: (pageId: string, hidden: boolean) =>
      req<{ hidden: boolean; document_ids: string[] }>(`/api/pages/${pageId}`, { method: 'PATCH', body: JSON.stringify({ hidden }) }),
    pageText: (pageId: string) =>
      req<{ id: string; page_number: number; raw_text: string | null; extraction_source: string | null }>(`/api/pages/${pageId}`),
    /** Read chosen pages with the model, then extract the documents they belong to again. */
    /** `model`: each page image goes to a model. `configured`: read the pages the way an upload does. */
    startAiReading: (id: string, pageIds: string[], model?: string, strategy: 'model' | 'configured' = 'model') =>
      req<AiReadingJob>(`/api/source-files/${id}/ai-reading`, {
        method: 'POST',
        body: JSON.stringify({ page_ids: pageIds, ...(model ? { model } : {}), ...(strategy === 'configured' ? { strategy } : {}) }),
      }),
    aiReading: (id: string) => req<AiReadingJob | { status: 'idle' }>(`/api/source-files/${id}/ai-reading`),
    /** One upload's pages and how they are grouped into documents. */
    get: (id: string) => req<UploadLayout>(`/api/source-files/${id}`),
    status: (id: string) =>
      req<{ status: string; progress: number; step: string; error?: string; documents: UploadDocument[] }>(`/api/source-files/${id}/status`),
    capabilities: () =>
      req<{
        aiReading: { enabled: boolean; provider: string; endpoint: string | null };
        /** How an upload is read here: the parser, whether local OCR is on, and whether it can send page images. */
        reading: { mode: 'text' | 'ocr' | 'hybrid' | 'multimodal'; ocr: boolean; images: boolean };
        models: ModelChoice[];
        /** Whether documents can be found by meaning on this server. */
        similarity?: { enabled: boolean };
      }>('/api/capabilities'),
    /** Extract the details of some of an upload's documents again, from the text already read. */
    extract: (id: string, documentIds: string[]) =>
      req<{ results: Array<{ id: string; reread: 'done' | 'failed' | 'skipped' }> }>(`/api/source-files/${id}/extract`, {
        method: 'POST', body: JSON.stringify({ document_ids: documentIds }),
      }),
    /** Delete an upload and everything made from it: documents, pages, the original and its backup copy. */
    remove: (id: string) => req<{ deleted: true }>(`/api/source-files/${id}`, { method: 'DELETE' }),
    /** Run a failed upload again, as it was first read. */
    retry: (id: string) => req<{ id: string; status: string }>(`/api/source-files/${id}/retry`, { method: 'POST' }),
    upload: (files: FileList) => {
      const form = new FormData();
      for (const f of Array.from(files)) form.append('files', f);
      return fetch('/api/source-files/upload', { method: 'POST', body: form }).then(r => r.json());
    },
  },

  share: {
    list: () => req<ShareLink[]>('/api/share-links'),
    create: (body: { label?: string; scope: string; scope_value?: unknown; expires_days?: number; include_scans?: boolean; language?: string | null }) =>
      req<{ id: string; token: string; url: string; expires_at: string }>('/api/share-links', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    revoke: (id: string) => req(`/api/share-links/${id}`, { method: 'DELETE' }),
  },

  publicShare: {
    documents: (token: string, lang?: string) => req<SharedListDocument[]>(`/api/share/${token}/documents${lang ? `?lang=${lang}` : ''}`),
    document: (token: string, id: string) => req<SharedDocument>(`/api/share/${token}/documents/${id}`),
    translation: (token: string, id: string, lang: string, part: 'head' | 'full' = 'full') => req<TranslatedDocument>(`/api/share/${token}/documents/${id}/translation?lang=${lang}&part=${part}`),
    /** The language the owner started the page in, the ones it can offer, and whether translating is on. */
    /** Values over time, from the shared documents only. */
    trends: (token: string) => req<TrendName[]>(`/api/share/${token}/trends`),
    trendSeries: (token: string, canonical: string) => req<TrendSeries>(`/api/share/${token}/trends/series?name=${encodeURIComponent(canonical)}`),
    meta: (token: string) => req<{ language: string | null; languages: string[]; translation: boolean }>(`/api/share/${token}/meta`),
  },

  tags: {
    list: () => req<Array<{ id: number; name: string; document_count: number }>>('/api/tags'),
    /** A name another tag has makes the two one (`merged`). */
    rename: (id: number, name: string) => patch<{ result: 'ok' | 'merged' }>(`/api/tags/${id}`, { name }),
    remove: (id: number) => del<{ removed: boolean }>(`/api/tags/${id}`),
  },

  providers: {
    list: () => req<Array<{ name: string; document_count: number }>>('/api/providers'),
    /** `to` null clears it. */
    rename: (from: string, to: string | null) => post<{ changed: number }>('/api/providers/rename', { from, to }),
  },
};
