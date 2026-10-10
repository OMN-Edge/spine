export interface SourceFile {
  id: string;
  uploaded_at: string;
  original_filename: string | null;
  file_path: string;
  mime_type: string | null;
  page_count: number | null;
  checksum: string | null;
  status: 'pending' | 'processing' | 'done' | 'error';
  error_message: string | null;
}

export interface Page {
  id: string;
  source_file_id: string;
  page_number: number;
  image_path: string;
  image_width: number;
  image_height: number;
  raw_text: string | null;
  elements: string | null; // JSON array of Element[]
  extraction_source: 'native_text' | 'ocr' | 'mixed' | 'multimodal' | null;
  is_continuation: boolean | null;
  continuation_confidence: number | null;
  continuation_reasoning: string | null;
  reviewed: boolean;
}

export interface Document {
  id: string;
  source_file_id: string;
  page_start: number;
  page_end: number;
  doc_date: string | null;
  provider: string | null;
  doc_type: DocType | null;
  ai_summary: string | null;
  user_notes: string | null;
  reviewed: boolean;
}

export type DocType =
  | 'lab_result'
  | 'discharge_note'
  | 'vaccination'
  | 'imaging'
  | 'prescription'
  | 'consultation_note'
  | 'other';

export interface ExtractedField {
  id: string;
  document_id: string;
  page_id: string;
  label: string;
  value: string;
  source_snippet: string | null;
  bbox_x0: number | null;
  bbox_y0: number | null;
  bbox_x1: number | null;
  bbox_y1: number | null;
  confidence: number | null;
}

export interface ShareLink {
  id: string;
  token: string;
  label: string | null;
  scope: 'all' | 'tag' | 'document_ids' | 'date_range';
  scope_value: string | null; // JSON
  created_at: string;
  expires_at: string;
  revoked: boolean;
  view_count: number;
  last_accessed_at: string | null;
}

export interface UnstructuredElement {
  type: string;
  text: string;
  page_number: number;
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;
  source: 'native_text' | 'ocr' | 'multimodal';
}

export interface ParseResponse {
  pages: Array<{
    page_number: number;
    elements: UnstructuredElement[];
    extraction_source: 'native_text' | 'ocr' | 'mixed' | 'multimodal';
    image_width: number;
    image_height: number;
  }>;
}

export interface ContinuationResult {
  is_continuation: boolean;
  confidence: number;
  reasoning: string;
}

export interface ExtractionResult {
  doc_date: string | null;
  provider: string | null;
  doc_type: DocType;
  ai_summary: string;
  suggested_tags: string[];
  fields: Array<{
    label: string;
    value: string;
    source_snippet: string;
    page_number: number;
    confidence: number;
  }>;
}

export interface JobStatus {
  source_file_id: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  progress: number; // 0-100
  step: string;
  error?: string;
}
