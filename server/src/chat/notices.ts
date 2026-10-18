import { v4 as uuidv4 } from 'uuid';
import { chatEnabled } from '../config.js';
import { getStore } from '../store/index.js';
import { logger } from '../logger.js';
import { describeError } from '../failure.js';
import { refOf, type DocRef } from './proposals.js';
import { suggestDuplicates } from '../doctors.js';
import { looksMixed } from '../regroup/analyze.js';
import { openQuestions, testsIntroduced } from '../matching/index.js';

/**
 * The app starts a conversation when something the owner is waiting for has finished: an upload has been read. The message is not
 * written by a model: it is a fact about the upload, stored as data the page draws in the owner's language, with `content` saying the
 * same in English for the model to read when the owner replies (so "is this right?" has something to be about). It is unread until the
 * owner opens it. Nothing here leaves the host.
 *
 * Why only uploads: it is the one thing that finishes while the owner is elsewhere, takes minutes, and is followed by work only the
 * owner can do (check the grouping, look at what was read). Links found in the background are shown where the document is, and a
 * message out of the blue about them would be noise.
 */
export interface UploadNoticeData {
  upload_id: string;
  state: 'done' | 'failed';
  file_name: string | null;
  pages: number;
  documents: DocRef[];
  /** Documents beyond the ones listed. */
  more_documents: number;
  /** Pages with no text read from them. */
  unread_pages: number;
  /** Documents with no date. */
  undated_documents: number;
  /** Whether the grouping still waits for the owner to confirm it. */
  grouping_pending: boolean;
  /** Doctors this upload added to the directory, and how many it found already there (matched by name or professional code). */
  doctors_added: string[];
  doctors_matched: number;
  /** Pairs of doctors that may be one person, where one of them is new from this upload (the app never merges these itself). */
  possible_duplicates: Array<[string, string]>;
  /** Tests this upload introduced, by name, that no other document has. */
  tests_new: string[];
  /** The pages' own text suggests some of them belong with pages of other documents. A cheap local look, not the analysis. */
  looks_mixed: boolean;
  /** Matches that wait for the owner's answer when the report is written (the page asks again, live, for the ones still open). */
  matches_open: number;
}

const LISTED = 12;

export async function announceUpload(userId: string, sourceFileId: string): Promise<void> {
  if (!chatEnabled()) return;
  const store = getStore();
  const file = await store.sourceFiles.findFor(userId, sourceFileId);
  if (!file || (file.status !== 'done' && file.status !== 'error')) return;

  const pages = await store.pages.listForSourceFile(userId, sourceFileId);
  const docs = file.status === 'done'
    ? (await store.documents.listFor(userId, { sourceFileId, includeUnconfirmed: true, limit: 1000, offset: 0 })).sort((a, b) => a.page_start - b.page_start)
    : [];
  const extras = file.status === 'done' ? await whatItFound(userId, sourceFileId, file.uploaded_at, docs, pages) : { doctors_added: [], doctors_matched: 0, possible_duplicates: [] as Array<[string, string]>, tests_new: [], looks_mixed: false, matches_open: 0 };
  const data: UploadNoticeData = {
    upload_id: sourceFileId,
    state: file.status === 'done' ? 'done' : 'failed',
    file_name: file.original_filename,
    pages: pages.length,
    documents: docs.slice(0, LISTED).map(refOf),
    more_documents: Math.max(0, docs.length - LISTED),
    unread_pages: pages.filter(p => !p.hidden && !p.raw_text?.trim()).length,
    undated_documents: docs.filter(d => !d.doc_date).length,
    grouping_pending: file.status === 'done' && !file.grouping_confirmed,
    ...extras,
  };

  // What the model is told this conversation began with. The page draws its own version of it from `data`.
  const name = file.original_filename ? `“${file.original_filename}”` : 'The upload';
  const content = data.state === 'failed'
    ? `The upload ${name} could not be read. The owner can try it again from the Upload page.`
    : [
      `The upload ${name} has been read: ${docs.length} document${docs.length === 1 ? '' : 's'} from ${pages.length} page${pages.length === 1 ? '' : 's'}.`,
      docs.length > 0 ? `They are: ${docs.slice(0, LISTED).map(d => d.title ?? 'untitled').join('; ')}${data.more_documents ? `; and ${data.more_documents} more` : ''}.` : '',
      data.grouping_pending ? 'The grouping is waiting for the owner to confirm it; until then the documents are out of the timeline and search.' : '',
      data.unread_pages ? `${data.unread_pages} page${data.unread_pages === 1 ? ' has' : 's have'} no text that could be read.` : '',
      data.undated_documents ? `${data.undated_documents} document${data.undated_documents === 1 ? ' has' : 's have'} no date.` : '',
      data.doctors_added.length || data.doctors_matched ? `Doctors: ${data.doctors_added.length} new (${data.doctors_added.slice(0, 6).join('; ')}), ${data.doctors_matched} already in the directory.` : '',
      data.matches_open ? `${data.matches_open} match${data.matches_open === 1 ? '' : 'es'} need the owner's answer (the same doctor, test, tag or clinic written two ways, or a professional code that differs); the report asks them one by one.` : '',
      data.tests_new.length ? `New tests (named by no other document): ${data.tests_new.slice(0, 10).join(', ')}.` : '',
      data.looks_mixed ? 'By their text, some pages look as if they belong with pages of other documents, so the grouping may be worth checking.' : '',
    ].filter(Boolean).join(' ');

  // In the conversation the file was attached in, if there is one: the person is waiting for it there.
  if (file.chat_conversation_id && await store.conversations.appendNotice(userId, file.chat_conversation_id, { id: uuidv4(), content, kind: 'upload', data, createdAt: new Date().toISOString() })) return;
  await store.conversations.createNotice(userId, {
    id: uuidv4(),
    title: data.state === 'failed' ? 'Upload failed' : 'Upload finished',
    origin: 'upload',
    createdAt: new Date().toISOString(),
    message: { id: uuidv4(), content, kind: 'upload', data },
  });
}

/** Fire and forget from the pipeline: a notice that cannot be written never fails an upload. */
export function announceUploadLater(userId: string, sourceFileId: string): void {
  void announceUpload(userId, sourceFileId).catch(err => logger.warn('could not write the upload notice', { sourceFileId, error: describeError(err) }));
}

/** What the notice says about a finished analysis of a mixed upload. */
export interface RegroupNoticeData {
  upload_id: string;
  file_name: string | null;
  pages_considered: number;
  /** Groups that would change something, and how many of them the model was sure of. */
  groups_changed: number;
  groups_validated: number;
  unchanged_groups: number;
  groups: Array<{ page_numbers: number[]; title: string | null; status: string; confidence: number }>;
}

export async function announceRegroup(userId: string, sourceFileId: string): Promise<void> {
  if (!chatEnabled()) return;
  const store = getStore();
  const file = await store.sourceFiles.findFor(userId, sourceFileId);
  const saved = await store.regroupPlans.get(userId, sourceFileId);
  if (!file || !saved) return;
  const plan = saved.plan as { pages_considered: number; unchanged_groups: number; groups: Array<{ page_numbers: number[]; title: string | null; status: string; confidence: number }> };
  const data: RegroupNoticeData = {
    upload_id: sourceFileId,
    file_name: file.original_filename,
    pages_considered: plan.pages_considered,
    groups_changed: plan.groups.length,
    groups_validated: plan.groups.filter(g => g.status === 'validated').length,
    unchanged_groups: plan.unchanged_groups,
    groups: plan.groups.slice(0, 12).map(g => ({ page_numbers: g.page_numbers, title: g.title, status: g.status, confidence: g.confidence })),
  };
  const name = file.original_filename ? `“${file.original_filename}”` : 'The upload';
  const content = plan.groups.length === 0
    ? `The analysis of ${name} is finished: the pages already sit with the pages they belong to, nothing would change.`
    : `The analysis of ${name} is finished: ${plan.groups.length} group${plan.groups.length === 1 ? '' : 's'} of pages would change the grouping (${data.groups_validated} confirmed by the model, the rest uncertain or unchecked), and ${plan.unchanged_groups} already hold together. Nothing has been changed; the owner decides.`;
  if (file.chat_conversation_id && await store.conversations.appendNotice(userId, file.chat_conversation_id, { id: uuidv4(), content, kind: 'regroup', data, createdAt: new Date().toISOString() })) return;
  await store.conversations.createNotice(userId, {
    id: uuidv4(),
    title: plan.groups.length === 0 ? 'Nothing to regroup' : 'Regrouping suggestions',
    origin: 'regroup',
    createdAt: new Date().toISOString(),
    message: { id: uuidv4(), content, kind: 'regroup', data },
  });
}

export function announceRegroupLater(userId: string, sourceFileId: string): void {
  void announceRegroup(userId, sourceFileId).catch(err => logger.warn('could not write the regrouping notice', { sourceFileId, error: describeError(err) }));
}

/**
 * What reading an upload added to the archive, for the owner to see at once: the doctors it brought (and how many it found already
 * there), pairs that may be duplicates, the tests no other document has, and a cheap local look at whether its pages are mixed.
 * A doctor is "new" if the directory entry was made while this upload was being read.
 */
async function whatItFound(userId: string, sourceFileId: string, since: string, docs: Array<{ id: string; page_start: number; page_end: number }>, pages: Array<{ id: string; page_number: number; raw_text: string | null; hidden?: boolean | number }>) {
  const store = getStore();
  const linked = new Map<string, { name: string; created_at: string }>();
  for (const d of docs) for (const doctor of await store.doctors.forDocument(userId, d.id)) linked.set(doctor.id, { name: doctor.name, created_at: doctor.created_at });
  const added = [...linked].filter(([, v]) => v.created_at >= since);
  const addedIds = new Set(added.map(([id]) => id));

  const directory = await store.doctors.listFor(userId);
  const nameOf = new Map(directory.map(d => [d.id, d.name]));
  const possible_duplicates = suggestDuplicates(directory)
    .filter(p => addedIds.has(p.keep.id) || addedIds.has(p.other.id))
    .slice(0, 6)
    .map(p => [nameOf.get(p.keep.id)!, nameOf.get(p.other.id)!] as [string, string]);

  const file = await store.sourceFiles.findFor(userId, sourceFileId);
  const tests_new = (await testsIntroduced(userId, { grouping_confirmed: file?.grouping_confirmed ?? true }, docs)).introduced.map(t => t.canonical).slice(0, 12);

  const documents = docs.map(d => ({ id: d.id, page_ids: pages.filter(p => p.page_number >= d.page_start && p.page_number <= d.page_end).map(p => p.id) }));
  return { doctors_added: added.map(([, v]) => v.name).slice(0, 12), doctors_matched: linked.size - added.length, possible_duplicates, tests_new, looks_mixed: looksMixed(pages, documents).mixed, matches_open: (await openQuestions(userId, sourceFileId)).length };
}
