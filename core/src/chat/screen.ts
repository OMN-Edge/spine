import { getStore } from '../store/index.js';
import type { ChatRecord } from '../llm/types.js';
import type { Document, SourceFile } from '../types.js';

/**
 * What the person is looking at, so a question like "what does this mean?" has something to mean. The browser sends
 * *pointers* (which page, which document or upload, which ids are listed, a search text, a filter, the test on a chart,
 * the field they selected), never text. The server resolves them through the store as the signed-in user, so what the model
 * is told about the screen is what the store holds, and an id that is not theirs resolves to nothing.
 *
 * The document on screen is given in sections (a summary, notes, doctors, results, fields, connections) so an answer can
 * point at one: [D1.results].
 */
export const SCREEN_PAGES = ['timeline', 'upload', 'upload_pages', 'review', 'document', 'search', 'trends', 'doctors', 'doctor', 'library', 'share', 'account', 'other'] as const;
export type ScreenPage = (typeof SCREEN_PAGES)[number];

/** The parts of a document page an answer can point to; the page has an element for each. */
export const DOCUMENT_SECTIONS = ['summary', 'notes', 'doctors', 'results', 'fields', 'chain'] as const;
export type DocumentSection = (typeof DOCUMENT_SECTIONS)[number];

export interface ScreenContext {
  page: ScreenPage;
  documentId?: string;
  uploadId?: string;
  doctorId?: string;
  /** Documents the screen lists, in order (a timeline, a review queue, search results). */
  documentIds?: string[];
  query?: string;
  filters?: Record<string, string>;
  /** The test whose chart is open. */
  test?: string;
  /** A field or result the person selected on a document. */
  selectedId?: string;
  /** The page of the file that is open on a document page (the file's numbering, as the page shows it). */
  pageNumber?: number;
  editing?: boolean;
}

const MAX_IDS = 30;
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64;
const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length <= max ? v : undefined);

/** A string describing what is wrong, or the context, trimmed to what is known. */
export function checkScreen(value: unknown): ScreenContext | string {
  if (!value || typeof value !== 'object') return 'screen must be an object';
  const s = value as Record<string, unknown>;
  if (!(SCREEN_PAGES as readonly string[]).includes(s.page as string)) return 'screen.page is not one of the known pages';
  const out: ScreenContext = { page: s.page as ScreenPage };
  for (const key of ['documentId', 'uploadId', 'doctorId', 'selectedId'] as const) {
    if (s[key] === undefined) continue;
    if (!isId(s[key])) return `screen.${key} must be an id`;
    out[key] = s[key] as string;
  }
  if (s.documentIds !== undefined) {
    if (!Array.isArray(s.documentIds) || s.documentIds.length > MAX_IDS || !s.documentIds.every(isId)) return `screen.documentIds must be at most ${MAX_IDS} ids`;
    out.documentIds = s.documentIds as string[];
  }
  if (s.pageNumber !== undefined) {
    if (typeof s.pageNumber !== 'number' || !Number.isInteger(s.pageNumber) || s.pageNumber < 1 || s.pageNumber > 10_000) return 'screen.pageNumber must be a page number';
    out.pageNumber = s.pageNumber;
  }
  if (s.query !== undefined) { const q = text(s.query, 300); if (q === undefined) return 'screen.query is too long'; out.query = q; }
  if (s.test !== undefined) { const t = text(s.test, 120); if (t === undefined) return 'screen.test is too long'; out.test = t; }
  if (s.filters !== undefined) {
    const entries = s.filters && typeof s.filters === 'object' && !Array.isArray(s.filters) ? Object.entries(s.filters as Record<string, unknown>) : null;
    if (!entries || entries.length > 8 || !entries.every(([k, v]) => k.length <= 40 && typeof v === 'string' && v.length <= 80)) return 'screen.filters must be a few short text values';
    out.filters = Object.fromEntries(entries as Array<[string, string]>);
  }
  if (s.editing !== undefined) { if (typeof s.editing !== 'boolean') return 'screen.editing must be true or false'; out.editing = s.editing; }
  return out;
}

const PAGE_NAMES: Record<ScreenPage, string> = {
  timeline: 'the Timeline', upload: 'the Upload page', upload_pages: 'the Pages and grouping screen of one upload', review: 'the Review queue',
  document: 'a document page', search: 'the Search page', trends: 'the Trends page', doctors: 'the list of doctors', doctor: 'one doctor’s page',
  library: 'the Library (tags, providers and tests)', share: 'the share links page', account: 'the account page', other: 'the app',
};

export interface ResolvedScreen {
  screen: ScreenContext;
  /** The document on a document page. It may be one whose upload is not confirmed yet: the owner is looking at it. */
  primary: Document | null;
  /** The upload on screen (an upload's own screen, or a conversation the app began about it). */
  upload: SourceFile | null;
  /** The other documents the screen lists or belongs to, in order. */
  listed: Document[];
  /** Plain lines about the screen that are not documents (an upload's state, a doctor, the selection). */
  facts: string[];
}

const clip = (value: string, n: number) => (value.length > n ? `${value.slice(0, n)}…` : value);

export async function resolveScreen(userId: string, screen: ScreenContext | null): Promise<ResolvedScreen | null> {
  if (!screen) return null;
  const store = getStore();
  const facts: string[] = [];
  let primary: Document | null = null;
  let listed: Document[] = [];
  let uploadOnScreen: SourceFile | null = null;

  if (screen.documentId) primary = await store.documents.findFor(userId, screen.documentId);

  if (screen.documentIds?.length) listed = await store.documents.listShownByIds(userId, screen.documentIds.slice(0, MAX_IDS));

  if (screen.uploadId) {
    const upload = await store.sourceFiles.findFor(userId, screen.uploadId);
    if (upload) {
      uploadOnScreen = upload;
      const docs = (await store.documents.listFor(userId, { sourceFileId: upload.id, includeHidden: true, limit: 200, offset: 0 })).sort((a, b) => a.page_start - b.page_start);
      const pages = await store.pages.listForSourceFile(userId, upload.id);
      const sources = new Map<string, number>();
      for (const p of pages) sources.set(p.extraction_source ?? 'not read', (sources.get(p.extraction_source ?? 'not read') ?? 0) + 1);
      facts.push(
        `upload of ${upload.uploaded_at.slice(0, 10)}: ${pages.length} pages, ${docs.length} documents, status ${upload.status}, ` +
        `${upload.grouping_confirmed ? 'grouping confirmed by the owner' : 'grouping NOT yet confirmed by the owner (its documents are hidden from the timeline until then)'}; ` +
        `pages read by: ${[...sources].map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}; hidden pages: ${pages.filter(p => p.hidden).length}`,
      );
      for (const d of docs) facts.push(`  pages ${d.page_start}-${d.page_end}: ${clip(d.title ?? 'untitled', 80)}${d.doc_type ? ` (${d.doc_type.replace(/_/g, ' ')})` : ''}${d.doc_date ? `, ${d.doc_date}` : ''}`);
      listed = docs.slice(0, 8);
    }
  } else if (screen.page === 'upload') {
    // The upload history: the latest few uploads and what each became.
    for (const upload of (await store.sourceFiles.listFor(userId)).slice(0, 8)) {
      const docs = await store.documents.listFor(userId, { sourceFileId: upload.id, includeUnconfirmed: true, limit: 20, offset: 0 });
      facts.push(`upload of ${upload.uploaded_at.slice(0, 10)}: status ${upload.status}${upload.status === 'done' && !upload.grouping_confirmed ? ', grouping NOT yet confirmed' : ''}, ${docs.length} documents${docs.length ? `: ${docs.slice(0, 5).map(d => clip(d.title ?? 'untitled', 50)).join('; ')}` : ''}`);
    }
  }

  if (screen.doctorId) {
    const doctor = (await store.doctors.listFor(userId)).find(d => d.id === screen.doctorId);
    if (doctor) {
      facts.push(`doctor ${doctor.name}${doctor.specialty ? `, ${doctor.specialty}` : ''}${doctor.clinic ? `, ${doctor.clinic}` : ''}`);
      const ids = (await store.doctors.documentsFor(userId, doctor.id)).map(d => d.id).slice(0, MAX_IDS);
      listed = await store.documents.listShownByIds(userId, ids);
    }
  }

  if (primary && screen.pageNumber) facts.push(`page ${screen.pageNumber} of the file is open`);

  if (primary && screen.selectedId) {
    const field = (await store.fields.listForDocument(userId, primary.id)).find(f => f.id === screen.selectedId);
    const result = field ? null : (await store.measurements.listForDocument(userId, primary.id)).find(m => m.id === screen.selectedId);
    if (field) facts.push(`selected ${field.label.replace(/_/g, ' ')}: ${clip(field.value, 200)}`);
    if (result) facts.push(`selected result ${result.name}: ${result.value_text}${result.unit ? ` ${result.unit}` : ''}`);
  }

  // The primary is first; it is not repeated in the list.
  if (primary) listed = listed.filter(d => d.id !== primary!.id);
  return { screen, primary, upload: uploadOnScreen, listed, facts };
}

/** The words that say where the person is, with labels for the documents they are looking at. */
export function describeScreen(resolved: ResolvedScreen, labelOf: Map<string, string>): string {
  const { screen, primary, listed, facts } = resolved;
  const lines = [`The person is looking at ${PAGE_NAMES[screen.page]}.`];
  if (primary) lines.push(`The document on screen is ${labelOf.get(primary.id)}${screen.editing ? ' and they are editing it' : ''}. "This document", "here" and "this" mean it.`);
  if (screen.query) lines.push(`Their search text is "${screen.query}".`);
  if (screen.test) lines.push(`The open chart is the test "${screen.test}".`);
  const filters = Object.entries(screen.filters ?? {}).filter(([, v]) => v);
  if (filters.length) lines.push(`Filters on: ${filters.map(([k, v]) => `${k} = ${v}`).join(', ')}.`);
  if (listed.length) lines.push(`Documents listed on screen, in order: ${listed.map(d => labelOf.get(d.id)).filter(Boolean).join(', ')}.`);
  return [...lines, ...facts].join('\n');
}

/** The sections of the document on screen, each its own record so an answer can cite one. */
export async function sectionRecords(userId: string, doc: Document, label: string, labelOf: Map<string, string>): Promise<ChatRecord[]> {
  const store = getStore();
  const [fields, results, doctors, tags, pages, links] = await Promise.all([
    store.fields.listForDocument(userId, doc.id),
    store.measurements.listForDocument(userId, doc.id),
    store.doctors.forDocument(userId, doc.id),
    store.tags.namesForDocument(userId, doc.id),
    store.pages.listForDocument(userId, doc.id),
    store.links.forDocument(userId, doc.id),
  ]);
  const pageNumber = new Map(pages.map(p => [p.id, p.page_number]));
  const out: ChatRecord[] = [];
  const add = (section: DocumentSection, body: string | false | null | undefined) => { if (body) out.push({ label: `${label}.${section}`, text: body }); };

  add('summary', [
    [doc.title, doc.doc_type?.replace(/_/g, ' '), doc.provider, doc.doc_date].filter(Boolean).join(' · '),
    doc.ai_summary,
    tags.length > 0 && `tags: ${tags.join(', ')}`,
    `${doc.reviewed ? 'reviewed by the owner' : 'not yet reviewed'}; pages ${doc.page_start}-${doc.page_end}`,
  ].filter(Boolean).join('\n'));
  add('notes', doc.user_notes?.trim() && clip(doc.user_notes.trim(), 2000));
  add('doctors', doctors.length > 0 && doctors.map(d => `${d.name}${d.specialty ? `, ${d.specialty}` : ''} (${d.role})`).join('\n'));
  add('results', results.length > 0 && results.slice(0, 80).map(m => {
    const range = m.ref_low !== null && m.ref_high !== null ? ` (reference ${m.ref_low}–${m.ref_high})` : '';
    return `${m.name}: ${m.value_text}${m.unit ? ` ${m.unit}` : ''}${range}${m.flag ? ` ${m.flag}` : ''}${m.taken_on ? `, ${m.taken_on}` : ''}`;
  }).join('\n'));
  add('fields', fields.length > 0 && fields.slice(0, 80).map(f => `${f.label.replace(/_/g, ' ')}: ${clip(f.value.replace(/\s+/g, ' ').trim(), 400)} (page ${pageNumber.get(f.page_id) ?? '?'})`).join('\n'));

  const connected = links.filter(l => l.state !== 'dismissed');
  add('chain', connected.length > 0 && connected.map(l => {
    const from = labelOf.get(l.from_document_id) ?? 'another document'; const to = labelOf.get(l.to_document_id) ?? 'another document';
    const sentence = l.kind === 'requests' ? `${from} asked for ${to}` : l.kind === 'follow_up' ? `${to} is a follow-up of ${from}` : `${from} and ${to} are one episode`;
    return l.state === 'proposed' ? `${sentence} (suggested by the app, not confirmed)` : sentence;
  }).join('\n'));
  return out;
}
