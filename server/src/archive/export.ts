import { ZipFile } from 'yazl';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { getStore } from '../store/index.js';
import type { Store } from '../store/index.js';
import { EXPORT_FORMAT, EXPORT_VERSION, MANIFEST_NAME, type Manifest, type ManifestDocument, type ManifestFile, type ManifestPage } from './manifest.js';
import { extractPdfPages } from './pdf-pages.js';
import type { Document, SourceFile } from '../types.js';

/**
 * Export: a zip holding the files and a manifest of what was read from them (see `manifest.ts`). Two sizes of the
 * same thing. One document is trimmed to its own pages, so what you hand someone is not the rest of the file it
 * was scanned with; the whole archive carries every upload as it was, with the grouping, the hidden pages and
 * your edits. The whole archive also carries how the documents are linked (the care chain, with the owner's decisions); one
 * document does not, because a link needs both its ends. Neither carries share links (a link is an access someone was given, and its token is not kept),
 * translations (they are made again) or page images (made again from the file).
 */
export interface ExportZip {
  stream: NodeJS.ReadableStream;
  /** Safe to put in a header: ASCII letters, digits and dashes. */
  filename: string;
}

export type DocumentExport = ExportZip | 'not_found' | 'no_pages' | 'cannot_trim';

const MANY = 1_000_000;

const slug = (text: string): string =>
  text.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);

const stamp = () => new Date().toISOString().slice(0, 10);

/** The checksum is the file's sha256 as it was uploaded; one that is not (an upload from before it was) is worked out. */
async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** The documents of an upload, with what was read from each, placed on the pages given by `place`. */
async function documentEntry(
  store: Store,
  userId: string,
  doc: Document,
  pageNumberOf: Map<string, number>,
  start: number,
  end: number,
): Promise<ManifestDocument> {
  const fallback = start;
  const pageOf = (pageId: string) => pageNumberOf.get(pageId) ?? fallback;
  const [fields, measurements, doctors, tags] = await Promise.all([
    store.fields.listForDocument(userId, doc.id),
    store.measurements.listForDocument(userId, doc.id),
    store.doctors.forDocument(userId, doc.id),
    store.tags.namesForDocument(userId, doc.id),
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
    doctors: doctors.map(d => ({ name: d.name, specialty: d.specialty, clinic: d.clinic, license_code: d.license_code, role: d.role })),
    fields: fields.map(f => ({
      label: f.label, value: f.value, group_no: f.group_no, page: pageOf(f.page_id),
      source_snippet: f.source_snippet, bbox: box(f), confidence: f.confidence,
    })),
    measurements: measurements.map(m => ({
      name: m.name, canonical: m.canonical, value_text: m.value_text, value_num: m.value_num, unit: m.unit,
      ref_low: m.ref_low, ref_high: m.ref_high, flag: m.flag, taken_on: m.taken_on, page: pageOf(m.page_id),
      source_snippet: m.source_snippet, bbox: box(m), confidence: m.confidence,
    })),
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
function zipOf(manifest: Manifest, files: Array<{ path: string; from: string | Buffer }>): NodeJS.ReadableStream {
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 1)), MANIFEST_NAME);
  for (const f of files) {
    if (typeof f.from === 'string') zip.addFile(f.from, f.path, { compress: false });
    else zip.addBuffer(f.from, f.path, { compress: false });
  }
  zip.end();
  return zip.outputStream;
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
    content = isPdf ? await extractPdfPages(upload.file_path, pages.map(p => p.source_page)) : fs.readFileSync(upload.file_path);
  } catch {
    return 'cannot_trim';
  }

  const ext = isPdf ? '.pdf' : path.extname(upload.file_path).toLowerCase() || '.bin';
  const entryName = `files/1${ext}`;
  const numbered = new Map(pages.map((p, i) => [p.id, i + 1]));
  const entry: ManifestFile = {
    path: entryName,
    original_filename: upload.original_filename,
    sha256: createHash('sha256').update(content).digest('hex'),
    page_count: pages.length,
    pages: await Promise.all(pages.map(async (p, i) => pageEntry(store, userId, { ...p, hidden: false }, i + 1, i + 1))),
    documents: [await documentEntry(store, userId, doc, numbered, 1, pages.length)],
  };
  const manifest: Manifest = { format: EXPORT_FORMAT, version: EXPORT_VERSION, exported_at: new Date().toISOString(), kind: 'document', files: [entry], links: [] };
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

  for (const summary of uploads) {
    const upload: SourceFile | null = await store.sourceFiles.findFor(userId, summary.id);
    if (!upload || !fs.existsSync(upload.file_path)) continue;
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
      sha256: /^[0-9a-f]{64}$/.test(upload.checksum ?? '') ? upload.checksum! : await sha256OfFile(upload.file_path),
      page_count: pages.length,
      pages: await Promise.all(pages.map(p => pageEntry(store, userId, p, p.page_number, p.source_page))),
      documents: await Promise.all(documents.map(d => documentEntry(store, userId, d, numbered, d.page_start, d.page_end))),
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
  const manifest: Manifest = { format: EXPORT_FORMAT, version: EXPORT_VERSION, exported_at: new Date().toISOString(), kind: 'archive', files: entries, links };
  return { stream: zipOf(manifest, files), filename: `spine-archive-${stamp()}.zip` };
}
