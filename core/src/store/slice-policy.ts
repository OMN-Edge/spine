import type { Cell } from './types.js';

/**
 * What a share copy holds, as data (docs/crypto-design.md, stage 4). **Everything in a share is readable by the recipient**: the browser
 * that opens it holds the whole file, not only what a route would send, so this list is the one place that decides what leaves. It is an
 * allow-list, and it is not the engine's: a store copies the rows it chooses to (which documents, which pages) and passes each through
 * `sliceRow`, so the columns that leave are the same whatever holds the records.
 *
 * Each table names what happens to every column. A column that is `copy`ed leaves as it is; one that is `set` leaves with a fixed value
 * (the owner's file names and paths become placeholders); one that is `text` leaves only when the recipient may ask questions
 * (`includeText`) and is blank otherwise; one that is `scans` leaves only when the page images do (`includeScans`), since a position on a
 * page means nothing without it; every other column is `left`, kept at its default, which is how the checksums, the pages' word boxes (the
 * page's text, with positions), the reasons the app gave for a link and the rest stay out. `slice-policy.test.ts`
 * holds the lists to the schema: a new column or table is out of a share until it is named here, and the test fails until someone has
 * decided which.
 */
export interface SliceTable {
  copy: string[];
  set?: Record<string, Cell>;
  /** Copied when the recipient may ask questions; this blank otherwise. */
  text?: Record<string, Cell>;
  /** Copied when the page images are; this blank otherwise. */
  scans?: Record<string, Cell>;
  left: string[];
}

export const SLICE = {
  source_files: {
    // No file name, no path, no checksum: the recipient is shown a document, not an upload.
    copy: ['id', 'user_id', 'uploaded_at', 'mime_type', 'page_count'],
    set: { original_filename: 'shared', file_path: '', status: 'done', grouping_confirmed: 1 },
    left: ['checksum', 'error_message', 'chat_conversation_id', 'photo_set', 'sample', 'raw_count', 'from_export'],
  },
  pages: {
    // `image_path` is set by the caller: the file in the share's own file system, only when scans are included.
    copy: ['id', 'user_id', 'source_file_id', 'page_number', 'image_width', 'image_height', 'rotation', 'source_page', 'extraction_source'],
    set: { elements: '[]', hidden: 0 },
    text: { raw_text: '' },
    left: ['image_path', 'is_continuation', 'continuation_confidence', 'continuation_reasoning', 'reviewed'],
  },
  documents: {
    copy: ['id', 'user_id', 'source_file_id', 'page_start', 'page_end', 'title', 'doc_date', 'provider', 'doc_type', 'ai_summary', 'user_notes', 'reviewed', 'language', 'owner_edited'],
    set: { needs_reading: 0 },
    left: [],
  },
  extracted_fields: {
    copy: ['id', 'user_id', 'document_id', 'page_id', 'label', 'value', 'group_no', 'owner_edited'],
    text: { source_snippet: null },
    // Where on the page it was read, so the reader can see it on the scan.
    scans: { bbox_x0: null, bbox_y0: null, bbox_x1: null, bbox_y1: null },
    left: ['confidence'],
  },
  measurements: {
    copy: ['id', 'user_id', 'document_id', 'page_id', 'name', 'canonical', 'value_text', 'value_num', 'unit', 'ref_low', 'ref_high', 'flag', 'taken_on', 'owner_edited'],
    text: { source_snippet: null },
    scans: { bbox_x0: null, bbox_y0: null, bbox_x1: null, bbox_y1: null },
    left: ['confidence'],
  },
  // The professional code too: it is printed on the documents that name the doctor.
  doctors: {
    copy: ['id', 'user_id', 'name', 'key', 'specialty', 'clinic', 'created_at', 'license_code'],
    left: [],
  },
  document_doctors: {
    copy: ['user_id', 'document_id', 'doctor_id', 'role', 'source', 'printed_code'],
    left: [],
  },
  tags: { copy: ['id', 'user_id', 'name'], left: [] },
  document_tags: { copy: ['user_id', 'document_id', 'tag_id'], left: [] },
  // A link between two documents both shared, as the owner confirmed it. Neither the reason the app gave nor how sure it was.
  document_links: {
    copy: ['user_id', 'from_document_id', 'to_document_id', 'kind', 'source', 'state', 'created_at'],
    left: ['reason', 'confidence'],
  },
  // An episode the owner confirmed, and only one whose every document is shared (`slice.ts` chooses them): its title, dates and provider
  // are then the shared documents' own. Not one the app only proposed.
  episodes: {
    copy: ['id', 'user_id', 'title', 'state', 'source', 'created_at'],
    left: [],
  },
  episode_documents: { copy: ['episode_id', 'document_id', 'user_id'], left: [] },
  // Closeness in meaning among the shared documents only: numbers, never text.
  document_embeddings: {
    copy: ['user_id', 'document_id', 'model', 'dims', 'text_hash', 'vector', 'created_at'],
    left: [],
  },
} satisfies Record<string, SliceTable>;

/**
 * The link itself is written by hand, as the recipient's core knows it: the documents named one by one, no approval (the key is the
 * approval), chat as the owner set it. Its counters start at zero.
 *
 * The translations are written by `translation.ts` (`carryTranslations`, through `SliceOptions.finish`), not copied: a kept translation
 * covers the whole document, and the copy may hold less of it (not the fields and results of a page the owner hid). Each is cut to the
 * texts the copy holds, every one of which leaves in the original too (title, summary, notes, field labels and values, result names,
 * specialties: all `copy` above, none `text`), and is kept under the digest of what the copy holds, so the reader's core uses it.
 */
export const SLICE_BUILT = ['share_links', 'document_translations'] as const;

/** Tables of records that never leave: the owner's working state, other people's visits, the model's conversations, the secrets. */
export const SLICE_NEVER = [
  'regroup_plans', 'removed_readings', 'measurement_aliases', 'match_decisions', 'share_access_requests', 'share_link_events', 'share_link_access_log',
  'chat_conversations', 'chat_messages', 'guide_marks', 'reminders', 'vault_files', 'share_link_keys', 'emergency_cards', 'emergency_scans',
] as const;

export type SliceName = keyof typeof SLICE;

/** One row as it leaves: the copied columns, the fixed ones, the text and scan ones if allowed, and what the caller adds (a path of its own). */
export function sliceRow(table: SliceName, row: Record<string, unknown>, o: { includeText: boolean; includeScans: boolean }, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const spec: SliceTable = SLICE[table];
  const out: Record<string, unknown> = {};
  for (const c of spec.copy) out[c] = row[c];
  Object.assign(out, spec.set);
  for (const [c, blank] of Object.entries(spec.text ?? {})) out[c] = o.includeText ? row[c] : blank;
  for (const [c, blank] of Object.entries(spec.scans ?? {})) out[c] = o.includeScans ? row[c] : blank;
  return Object.assign(out, extra);
}
