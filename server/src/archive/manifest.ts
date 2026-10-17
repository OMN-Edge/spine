import { createHash } from 'crypto';
import { z } from 'zod';

/**
 * The manifest in an export (`manifest.json` at the top of the zip). It names the files in the zip and
 * says, for each, what was read from it: pages (text, where each word sat), the documents they make up, and
 * what was extracted from each (details, results, doctors, tags, the owner's notes). Reading a Spine zip
 * back needs no model: it only has to turn the file into page images again.
 *
 * It is parsed with zod before anything is used, because an import takes a file the user was given. Nothing
 * in it names a user, an id of this archive or a path to write to: every id is made again on import, and the
 * zip is read by entry name, never extracted by it (SECURITY.md **M-14**).
 */
export const EXPORT_FORMAT = 'spine-export';
export const EXPORT_VERSION = 1;
export const MANIFEST_NAME = 'manifest.json';
/** A manifest larger than this is not read (it is parsed into memory on a small machine): a thousand pages with their words is a few MB. */
export const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

const text = (max: number) => z.string().max(max);
/** A date as the app writes it: a day, or only a month. */
const when = z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/).nullable();
const fraction = z.number().min(0).max(1);
const box = z.object({ x0: fraction, y0: fraction, x1: fraction, y1: fraction });
const pixelBox = z.object({ x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() });

const element = z.object({
  type: text(64),
  text: text(100_000),
  page_number: z.number().int().min(1).max(100_000),
  bbox: pixelBox.nullable(),
  source: z.enum(['native_text', 'ocr', 'multimodal']),
});

const page = z.object({
  /** Its place in the upload, as the owner arranged it. */
  number: z.number().int().min(1).max(100_000),
  /** Its place in the file, which is what anything that reads the file again asks for. */
  source_page: z.number().int().min(1).max(100_000),
  hidden: z.boolean(),
  extraction_source: z.enum(['native_text', 'ocr', 'mixed', 'multimodal', 'unread']).nullable(),
  raw_text: text(2_000_000).nullable(),
  elements: z.array(element).max(50_000),
});

const doctor = z.object({
  name: text(300),
  specialty: text(300).nullable(),
  clinic: text(300).nullable(),
  license_code: text(100).nullable(),
  role: z.enum(['author', 'prescriber', 'referrer', 'other']),
});

const field = z.object({
  label: text(200),
  value: text(100_000),
  group_no: z.number().int().min(0).max(100_000).nullable(),
  page: z.number().int().min(1).max(100_000),
  source_snippet: text(10_000).nullable(),
  bbox: box.nullable(),
  confidence: z.number().min(0).max(1).nullable(),
});

const measurement = z.object({
  name: text(300),
  canonical: text(300).transform(c => c.trim().toLowerCase()),
  value_text: text(300),
  value_num: z.number().nullable(),
  unit: text(100).nullable(),
  ref_low: z.number().nullable(),
  ref_high: z.number().nullable(),
  flag: z.enum(['low', 'high', 'normal']).nullable(),
  taken_on: when,
  page: z.number().int().min(1).max(100_000),
  source_snippet: text(10_000).nullable(),
  bbox: box.nullable(),
  confidence: z.number().min(0).max(1).nullable(),
});

const document = z.object({
  page_start: z.number().int().min(1).max(100_000),
  page_end: z.number().int().min(1).max(100_000),
  title: text(1000).nullable(),
  doc_date: when,
  provider: text(500).nullable(),
  doc_type: z.enum(['lab_result', 'discharge_note', 'vaccination', 'imaging', 'prescription', 'consultation_note', 'other']).nullable(),
  ai_summary: text(100_000).nullable(),
  user_notes: text(100_000).nullable(),
  language: text(8).nullable(),
  reviewed: z.boolean(),
  tags: z.array(text(100)).max(50),
  doctors: z.array(doctor).max(200),
  fields: z.array(field).max(10_000),
  measurements: z.array(measurement).max(10_000),
});

const file = z.object({
  /** The entry in the zip that holds the file. Looked up by name; never used as a place to write. */
  path: text(300),
  original_filename: text(500).nullable(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  page_count: z.number().int().min(1).max(100_000),
  pages: z.array(page).min(1).max(100_000),
  documents: z.array(document).max(100_000),
});

export const manifestSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.literal(EXPORT_VERSION),
  exported_at: text(40),
  /** One document, trimmed to its own pages, or a person's whole archive. Informational: import treats both alike. */
  kind: z.enum(['document', 'archive']),
  files: z.array(file).min(1).max(20_000),
}).superRefine((manifest, ctx) => {
  // What a whole export may hold, however it is split into files.
  const documents = manifest.files.reduce((n, f) => n + f.documents.length, 0);
  const pages = manifest.files.reduce((n, f) => n + f.pages.length, 0);
  if (documents > 20_000 || pages > 200_000) ctx.addIssue({ code: 'custom', message: 'too many documents or pages' });
});

export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestFile = z.infer<typeof file>;
export type ManifestPage = z.infer<typeof page>;
export type ManifestDocument = z.infer<typeof document>;

/** Whether a parsed JSON value claims to be a Spine export, and if so of which version. */
export function claimsToBeExport(value: unknown): { version: unknown } | null {
  if (typeof value === 'object' && value !== null && (value as { format?: unknown }).format === EXPORT_FORMAT) {
    return { version: (value as { version?: unknown }).version };
  }
  return null;
}

/**
 * What identifies a document by its words: the same text on the same pages, however the file around it was
 * cut. A document exported on its own is a new, smaller file, so its checksum is no use for telling that it is
 * already here; this is. Null when there is too little text to say anything (a scan nothing could read), in
 * which case only the file's checksum can recognise a copy.
 */
export function documentFingerprint(pageTexts: Array<string | null>): string | null {
  const normalised = pageTexts.map(t => (t ?? '').toLowerCase().replace(/\s+/g, ' ').trim());
  if (normalised.join('').length < 40) return null;
  return createHash('sha256').update(JSON.stringify(normalised)).digest('hex');
}
