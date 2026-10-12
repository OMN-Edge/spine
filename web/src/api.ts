export type DocType =
  | 'lab_result'
  | 'discharge_note'
  | 'vaccination'
  | 'imaging'
  | 'prescription'
  | 'consultation_note'
  | 'other';

export interface Document {
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
export interface UploadDocument {
  id: string;
  title: string | null;
  doc_type: DocType | null;
  doc_date: string | null;
  provider: string | null;
  page_start: number;
  page_end: number;
  reviewed: boolean | number;
}

export interface UploadSummary {
  id: string;
  uploaded_at: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  error_message: string | null;
  page_count: number | null;
  documents: UploadDocument[];
}

export interface UploadLayout extends UploadSummary {
  pages: Array<{ id: string; page_number: number; image_width: number; image_height: number; extraction_source: string | null }>;
}

/** One edit session: the details, the tags and the extracted fields, saved together. */
export interface DocumentEdit {
  title?: string;
  doc_date?: string;
  provider?: string;
  doc_type?: string;
  ai_summary?: string;
  user_notes?: string;
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
  extraction_source: 'native_text' | 'ocr' | 'mixed' | 'multimodal' | null;
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

export const api = {
  trends: {
    names: () => req<TrendName[]>('/api/measurements'),
    /** `from`'s values are counted as `into`, and later documents that use `from` are filed there too. */
    merge: (from: string, into: string) => post<{ ok: boolean; canonical: string }>('/api/measurements/merge', { from, into }),
    series: (canonical: string) => req<TrendSeries>(`/api/measurements/series?name=${encodeURIComponent(canonical)}`),
  },

  doctors: {
    list: () => req<DoctorEntry[]>('/api/doctors'),
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
    list: (params?: Record<string, string>) => {
      const qs = params ? '?' + new URLSearchParams(params).toString() : '';
      return req<Document[]>(`/api/documents${qs}`);
    },
    get: (id: string) => req<Document>(`/api/documents/${id}`),
    /** Extract the details again from the page text already read. No image is sent. */
    reextract: (id: string) => req<{ reread: 'done' | 'failed' }>(`/api/documents/${id}/reextract`, { method: 'POST' }),
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
    boundary: (id: string, body: { action: 'split'; at_page: number } | { action: 'merge'; with_document_id: string }) =>
      req(`/api/documents/${id}/boundary`, { method: 'POST', body: JSON.stringify(body) }),
  },

  sourceFiles: {
    /** Every upload, newest first, with the documents it became. */
    list: () => req<UploadSummary[]>('/api/source-files'),
    /** What was read from one page, and how. */
    pageText: (pageId: string) =>
      req<{ id: string; page_number: number; raw_text: string | null; extraction_source: string | null }>(`/api/pages/${pageId}`),
    /** Read chosen pages with the model, then extract the documents they belong to again. */
    startAiReading: (id: string, pageIds: string[]) =>
      req<AiReadingJob>(`/api/source-files/${id}/ai-reading`, { method: 'POST', body: JSON.stringify({ page_ids: pageIds }) }),
    aiReading: (id: string) => req<AiReadingJob | { status: 'idle' }>(`/api/source-files/${id}/ai-reading`),
    /** One upload's pages and how they are grouped into documents. */
    get: (id: string) => req<UploadLayout>(`/api/source-files/${id}`),
    status: (id: string) =>
      req<{ status: string; progress: number; step: string; error?: string; documents: UploadDocument[] }>(`/api/source-files/${id}/status`),
    capabilities: () =>
      req<{ aiReading: { enabled: boolean; provider: string; endpoint: string | null } }>('/api/capabilities'),
    /** Read the upload again with the model. Sends its page images to the provider. */
    reread: (id: string) =>
      req<{ id: string; status: string }>(`/api/source-files/${id}/reread`, { method: 'POST' }),
    upload: (files: FileList) => {
      const form = new FormData();
      for (const f of Array.from(files)) form.append('files', f);
      return fetch('/api/source-files/upload', { method: 'POST', body: form }).then(r => r.json());
    },
  },

  share: {
    list: () => req<ShareLink[]>('/api/share-links'),
    create: (body: { label?: string; scope: string; scope_value?: unknown; expires_days?: number }) =>
      req<{ id: string; token: string; url: string; expires_at: string }>('/api/share-links', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    revoke: (id: string) => req(`/api/share-links/${id}`, { method: 'DELETE' }),
  },

  publicShare: {
    documents: (token: string) => req<Document[]>(`/api/share/${token}/documents`),
  },

  tags: {
    list: () => req<Array<{ id: number; name: string }>>('/api/tags'),
  },
};
