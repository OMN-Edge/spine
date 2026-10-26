import { fileSystem } from '../files.js';
import { newZip } from './zip-write.js';
import { sha256, sha256Hex } from '../digest.js';
import path from 'path';
import { getStore } from '../store/index.js';
import type { Store } from '../store/index.js';
import { EXPORT_FORMAT, EXPORT_VERSION, MANIFEST_NAME, type Manifest, type ManifestDocument, type ManifestFile, type ManifestPage } from './manifest.js';
import { extractPdfPages } from './pdf-pages.js';
import { exportDirectory } from './directory.js';
import type { Document, SourceFile } from '../types.js';

/**
 * Export: a zip holding the files and a manifest of what was read from them (see `manifest.ts`). Two sizes of the
 * same thing. One document is trimmed to its own pages, so what you hand someone is not the rest of the file it
 * was scanned with; the whole archive carries every upload as it was, with the grouping, the hidden pages and
 * your edits (what the owner changed and removed, so a new reading still keeps it). The whole archive also carries how the documents are linked (the care chain, with the owner's decisions),
 * the doctors' directory (those no document names, and two people of one name as two), every tag, merged test names and the answers to "are these the same?"; one
 * document carries the doctors it names, and no links, because a link needs both its ends. Neither carries share links (a link is an access someone was given, and its token is not kept),
 * translations (they are made again) or page images (made again from the file).
 */
export interface ExportZip {
  stream: AsyncIterable<Uint8Array>;
  /** Safe to put in a header: ASCII letters, digits and dashes. */
  filename: string;
}

export type DocumentExport = ExportZip | 'not_found' | 'no_pages' | 'cannot_trim';

const MANY = 1_000_000;
const EDITABLE = ['title', 'doc_date', 'provider', 'doc_type', 'ai_summary', 'user_notes', 'language'] as const;

const slug = (text: string): string =>
  text.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);

const stamp = () => new Date().toISOString().slice(0, 10);

/** The checksum is the file's sha256 as it was uploaded; one that is not (an upload from before it was) is worked out. */
async function sha256OfFile(filePath: string): Promise<string> {
  const hash = sha256();
  for await (const chunk of fileSystem().readStream(filePath)) hash.update(chunk as Buffer);
  return hash.hex();
}

/** The documents of an upload, with what was read from each, placed on the pages given by `place`. */
async function documentEntry(
  store: Store,
  userId: string,
  doc: Document,
  pageNumberOf: Map<string, number>,
  start: number,
  end: number,
  /** Where each doctor of the directory is in the manifest's `people`. */
  personOf: Map<string, number>,
): Promise<ManifestDocument> {
  const fallback = start;
  const pageOf = (pageId: string) => pageNumberOf.get(pageId) ?? fallback;
  const [fields, measurements, doctors, tags, links, editedColumns, editedFields, editedMeasurements, removedFields, removedMeasurements] = await Promise.all([
    store.fields.listForDocument(userId, doc.id),
    store.measurements.listForDocument(userId, doc.id),
    store.doctors.forDocument(userId, doc.id),
    store.tags.namesForDocument(userId, doc.id),
    store.doctors.linkInfo(userId, doc.id),
    store.documents.editedColumns(userId, doc.id),
    store.fields.editedIds(userId, doc.id),
    store.measurements.editedIds(userId, doc.id),
    store.fields.removedKeys(userId, doc.id),
    store.measurements.removedKeys(userId, doc.id),
  ]);
  const box = (b: { bbox_x0: number | null; bbox_y0: number | null; bbox_x1: number | null; bbox_y1: number | null }) =>
    b.bbox_x0 !== null && b.bbox_y0 !== null && b.bbox_x1 !== null && b.bbox_y1 !== null
      ? { x0: b.bbox_x0, y0: b.bbox_y0, x1: b.bbox_x1, y1: b.bbox_y1 }
      : null;
  return {
    page_start: start,
    page_end: end,
    title: doc.title,
    doc_date: doc.doc_date,
    provider: doc.provider,
    doc_type: doc.doc_type,
    ai_summary: doc.ai_summary,
    user_notes: doc.user_notes,
    language: doc.language,
    reviewed: !!doc.reviewed,
    tags,
    doctors: doctors.map(d => {
      const how = links.find(l => l.doctor_id === d.id && l.role === d.role);
      return {
        name: d.name, specialty: d.specialty, clinic: d.clinic, license_code: d.license_code, role: d.role,
        person: personOf.get(d.id) ?? null, source: how?.source ?? 'text', printed_code: how?.printed_code ?? null,
      };
    }),
    fields: fields.map(f => ({
      label: f.label, value: f.value, group_no: f.group_no, page: pageOf(f.page_id),
      source_snippet: f.source_snippet, bbox: box(f), confidence: f.confidence, owner_edited: editedFields.has(f.id),
    })),
    measurements: measurements.map(m => ({
      name: m.name, canonical: m.canonical, value_text: m.value_text, value_num: m.value_num, unit: m.unit,
      ref_low: m.ref_low, ref_high: m.ref_high, flag: m.flag, taken_on: m.taken_on, page: pageOf(m.page_id),
      source_snippet: m.source_snippet, bbox: box(m), confidence: m.confidence, owner_edited: editedMeasurements.has(m.id),
    })),
    owner_edited: editedColumns.filter((c): c is ManifestDocument['owner_edited'][number] => (EDITABLE as readonly string[]).includes(c)),
    removed_fields: [...removedFields],
    removed_measurements: [...removedMeasurements],
  };
}

async function pageEntry(store: Store, userId: string, page: { id: string; hidden: boolean; raw_text: string | null; extraction_source: ManifestPage['extraction_source'] }, number: number, sourcePage: number): Promise<ManifestPage> {
  const context = await store.pages.findGroundingContext(userId, page.id);
  return {
    number,
    source_page: sourcePage,
    hidden: !!page.hidden,
    extraction_source: page.extraction_source,
    raw_text: page.raw_text,
    elements: context?.elements ?? [],
  };
}

/** The zip: the manifest, then each file as it is (PDFs and photos are already compressed, so they are stored). */
function zipOf(manifest: Manifest, files: Array<{ path: string; from: string | Buffer }>): AsyncIterable<Uint8Array> {
  const zip = newZip();
  zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 1)), MANIFEST_NAME, { compress: true });
  for (const f of files) {
    if (typeof f.from === 'string') zip.addFile(f.from, f.path);
    else zip.addBuffer(f.from, f.path);
  }
  return zip.finish();
}

/** One document as its own small export. */
export async function exportDocument(userId: string, documentId: string): Promise<DocumentExport> {
  const store = getStore();
  const doc = await store.documents.findFor(userId, documentId);
  if (!doc) return 'not_found';
  const upload = await store.sourceFiles.findFor(userId, doc.source_file_id);
  if (!upload) return 'not_found';

  // The pages the owner has not set aside, in the order they read.
  const pages = (await store.pages.listForDocument(userId, documentId)).sort((a, b) => a.page_number - b.page_number);
  if (pages.length === 0) return 'no_pages';

  const isPdf = upload.mime_type === 'application/pdf';
  let content: Buffer;
  try {
    content = isPdf ? await extractPdfPages(upload.file_path, pages.map(p => p.source_page)) : fileSystem().readFileSync(upload.file_path);
  } catch {
    return 'cannot_trim';
  }

  const ext = isPdf ? '.pdf' : path.extname(upload.file_path).toLowerCase() || '.bin';
  const entryName = `files/1${ext}`;
  const numbered = new Map(pages.map((p, i) => [p.id, i + 1]));
  // A document's export carries the doctors it names (and not the rest of the directory), so two of one name stay two.
  const named = await store.doctors.forDocument(userId, documentId);
  const personOf = new Map(named.map((d, i) => [d.id, i]));
  const entry: ManifestFile = {
    path: entryName,
    original_filename: upload.original_filename,
    photo_set: upload.photo_set,
    sha256: sha256Hex(content),
    page_count: pages.length,
    pages: await Promise.all(pages.map(async (p, i) => pageEntry(store, userId, { ...p, hidden: false }, i + 1, i + 1))),
    documents: [await documentEntry(store, userId, doc, numbered, 1, pages.length, personOf)],
  };
  const manifest: Manifest = { format: EXPORT_FORMAT, version: EXPORT_VERSION, exported_at: new Date().toISOString(), kind: 'document', files: [entry], links: [], episodes: [],
    people: named.map(d => ({ name: d.name, specialty: d.specialty, clinic: d.clinic, license_code: d.license_code })), tags: [], test_aliases: [], decisions: [],
  };
  return {
    stream: zipOf(manifest, [{ path: entryName, from: content }]),
    filename: `spine-${slug(doc.title ?? '') || 'document'}-${stamp()}.zip`,
  };
}

/** Everything the person has: each finished upload with its pages, documents and edits. */
export async function exportArchive(userId: string): Promise<ExportZip | 'empty'> {
  const store = getStore();
  const uploads = (await store.sourceFiles.listFor(userId)).filter(u => u.status === 'done');
  const entries: ManifestFile[] = [];
  const files: Array<{ path: string; from: string }> = [];
  // Where each exported document sits in the manifest, which is how a link names it (ids are made again on import).
  const placed = new Map<string, { file: number; document: number }>();
  const directory = await exportDirectory(store, userId);

  for (const summary of uploads) {
    const upload: SourceFile | null = await store.sourceFiles.findFor(userId, summary.id);
    if (!upload || !fileSystem().existsSync(upload.file_path)) continue;
    const pages = await store.pages.listForSourceFile(userId, upload.id);
    if (pages.length === 0) continue;
    const documents = (await store.documents.listFor(userId, { sourceFileId: upload.id, includeHidden: true, limit: MANY, offset: 0 }))
      .sort((a, b) => a.page_start - b.page_start);

    const ext = path.extname(upload.file_path).toLowerCase() || '.bin';
    const entryName = `files/${entries.length + 1}${ext}`;
    const numbered = new Map(pages.map(p => [p.id, p.page_number]));
    entries.push({
      path: entryName,
      original_filename: upload.original_filename,
      photo_set: upload.photo_set,
      sha256: /^[0-9a-f]{64}$/.test(upload.checksum ?? '') ? upload.checksum! : await sha256OfFile(upload.file_path),
      page_count: pages.length,
      pages: await Promise.all(pages.map(p => pageEntry(store, userId, p, p.page_number, p.source_page))),
      documents: await Promise.all(documents.map(d => documentEntry(store, userId, d, numbered, d.page_start, d.page_end, directory.personOf))),
    });
    documents.forEach((d, document) => placed.set(d.id, { file: entries.length - 1, document }));
    files.push({ path: entryName, from: upload.file_path });
  }

  // The manifest schema asks for at least one file, so an empty archive is reported rather than written as a
  // manifest an import would refuse.
  if (entries.length === 0) return 'empty';
  // A link is kept when both its documents are in the export: all its states, the owner's decisions included (a dismissed pair
  // stays dismissed), and those at a document that is set aside.
  const links = (await store.links.all(userId)).flatMap(l => {
    const from = placed.get(l.from_document_id); const to = placed.get(l.to_document_id);
    return from && to ? [{ from, to, kind: l.kind, source: l.source, state: l.state, reason: l.reason, confidence: l.confidence }] : [];
  });
  // Episodes with the documents they hold that are in the export, all states, so a dismissal stays a dismissal.
  const episodes = (await store.episodes.list(userId)).flatMap(e => {
    const documents = e.document_ids.flatMap(id => (placed.get(id) ? [placed.get(id)!] : []));
    return documents.length > 0 ? [{ title: e.title, state: e.state, source: e.source, documents }] : [];
  });
  const manifest: Manifest = { format: EXPORT_FORMAT, version: EXPORT_VERSION, exported_at: new Date().toISOString(), kind: 'archive', files: entries, links, episodes,
    people: directory.people, tags: directory.tags, test_aliases: directory.test_aliases, decisions: directory.decisions,
  };
  return { stream: zipOf(manifest, files), filename: `spine-archive-${stamp()}.zip` };
}
