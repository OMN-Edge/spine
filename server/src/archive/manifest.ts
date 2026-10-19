import { createHash } from 'crypto';
import { z } from 'zod';

/**
 * The manifest in an export (`manifest.json` at the top of the zip). It names the files in the zip and
 * says, for each, what was read from it: pages (text, where each word sat), the documents they make up, and
 * what was extracted from each (details, results, doctors, tags, the owner's notes), and how the documents are linked. Reading a Spine zip
 * back needs no model: it only has to turn the file into page images again.
 *
 * It is parsed with zod before anything is used, because an import takes a file the user was given. Nothing
 * in it names a user, an id of this archive or a path to write to: every id is made again on import, and the
 * zip is read by entry name, never extracted by it (SECURITY.md **M-14**).
 */
export const EXPORT_FORMAT = 'spine-export';
/** 2 adds what the owner edited and removed, the doctors' directory, tags no document carries, merged test names and the answers to "same one?". 1 is still read: those fields are absent. */
export const EXPORT_VERSION = 2;
export const READABLE_VERSIONS: readonly unknown[] = [1, 2];
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
  /** Which entry of the manifest's `people` this is, so two people of one name stay two. Absent from version 1. */
  person: z.number().int().min(0).max(49_999).nullable().default(null),
  /** Where the document read the doctor from, and the code it printed (what a code clash is asked about). */
  source: z.enum(['text', 'stamp', 'signature']).default('text'),
  printed_code: text(100).nullable().default(null),
});

const field = z.object({
  label: text(200),
  value: text(100_000),
  group_no: z.number().int().min(0).max(100_000).nullable(),
  page: z.number().int().min(1).max(100_000),
  source_snippet: text(10_000).nullable(),
  bbox: box.nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  /** Added or changed by the owner, so a new reading keeps it. */
  owner_edited: z.boolean().default(false),
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
  owner_edited: z.boolean().default(false),
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
  /** The headline columns the owner changed, which a new reading keeps. */
  owner_edited: z.array(z.enum(['title', 'doc_date', 'provider', 'doc_type', 'ai_summary', 'user_notes', 'language'])).max(7).default([]),
  /** What the owner removed (`store/reading-keys.ts`), so a new reading does not bring it back. */
  removed_fields: z.array(text(100_500)).max(10_000).default([]),
  removed_measurements: z.array(text(1_000)).max(10_000).default([]),
});

/** A person in the doctors' directory. Documents name them by position in `people`. */
const person = z.object({
  name: text(300),
  specialty: text(300).nullable(),
  clinic: text(300).nullable(),
  license_code: text(100).nullable(),
});

/** "These two are not the same", as the owner answered when asked. Doctors by position in `people` (as text), tags and providers by name, tests by canonical name; a code clash is the doctor's position and the printed code. */
const decision = z.object({
  kind: z.enum(['doctor', 'code', 'tag', 'test', 'provider']),
  a: text(600),
  b: text(600),
});

/** A document in the export, by where it is in it: the file's place in `files`, then the document's in that file's `documents`. */
const linkEnd = z.object({ file: z.number().int().min(0).max(19_999), document: z.number().int().min(0).max(99_999) });

/** How two documents are connected, with the owner's decision on it (the care chain). */
const link = z.object({
  from: linkEnd,
  to: linkEnd,
  kind: z.enum(['requests', 'follow_up', 'same_episode']),
  source: z.enum(['auto', 'owner']),
  state: z.enum(['proposed', 'confirmed', 'dismissed']),
  reason: text(10_000).nullable(),
  confidence: z.number().min(0).max(1).nullable(),
});

const file = z.object({
  /** The entry in the zip that holds the file. Looked up by name; never used as a place to write. */
  path: text(300),
  original_filename: text(500).nullable(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Several photos bundled into a PDF, so a model reads it again as it would a photo. Absent from earlier exports. */
  photo_set: z.boolean().default(false),
  page_count: z.number().int().min(1).max(100_000),
  pages: z.array(page).min(1).max(100_000),
  documents: z.array(document).max(100_000),
});

export const manifestSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.union([z.literal(1), z.literal(2)]),
  exported_at: text(40),
  /** One document, trimmed to its own pages, or a person's whole archive. Informational: import treats both alike. */
  kind: z.enum(['document', 'archive']),
  files: z.array(file).min(1).max(20_000),
  /** Absent from exports made before links were kept, and from a single document's export (a link needs both ends). */
  links: z.array(link).max(100_000).default([]),
  /** The doctors' directory, those no document names included. Absent from version 1 and carried whole by an archive, trimmed to the document's own by a single document's. */
  people: z.array(person).max(50_000).default([]),
  /** Every tag, those no document carries included. */
  tags: z.array(text(100)).max(10_000).default([]),
  /** Tests that were merged under another name: later documents filed under the old name land under the new one. */
  test_aliases: z.array(z.object({ alias: text(300), canonical: text(300) })).max(100_000).default([]),
  decisions: z.array(decision).max(100_000).default([]),
}).superRefine((manifest, ctx) => {
  // What a whole export may hold, however it is split into files.
  const documents = manifest.files.reduce((n, f) => n + f.documents.length, 0);
  const pages = manifest.files.reduce((n, f) => n + f.pages.length, 0);
  if (documents > 20_000 || pages > 200_000) ctx.addIssue({ code: 'custom', message: 'too many documents or pages' });
  // A link names its documents by position, so a position that is not there is a manifest that does not hold together.
  const there = (end: { file: number; document: number }) => end.document < (manifest.files[end.file]?.documents.length ?? 0);
  if (manifest.files.some(f => f.documents.some(d => d.doctors.some(x => x.person !== null && x.person >= manifest.people.length)))) {
    ctx.addIssue({ code: 'custom', message: 'a doctor names a person that is not in the export' });
  }
  if (manifest.links.some(l => !there(l.from) || !there(l.to))) ctx.addIssue({ code: 'custom', message: 'a link names a document that is not in the export' });
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
