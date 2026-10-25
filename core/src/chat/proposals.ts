import { v4 as uuidv4 } from 'uuid';
import type { Document } from '../types.js';
import type { LinkWhy } from '../linking/why.js';

/**
 * What an action tool hands back instead of doing anything. The agent never changes a record: it *proposes*, the page shows the
 * proposal as a card, and only the person's Confirm sends the requests below to the ordinary, authenticated routes (which check
 * everything again). The words on the card are written by the page from this data in the person's language, never by the model;
 * the only text the model supplies is the data itself (a note, a value, a label), shown as it is.
 *
 * Proposals are not stored: they are part of the reply that made them, and a conversation reopened later has the words only.
 */
export interface DocRef { id: string; title: string | null; doc_type: Document['doc_type']; doc_date: string | null; page_start?: number; page_end?: number }
export const refOf = (d: Document): DocRef => ({ id: d.id, title: d.title, doc_type: d.doc_type, doc_date: d.doc_date, page_start: d.page_start, page_end: d.page_end });

/** A request Confirm will send, exactly. The page runs only paths of the shapes it knows. */
export interface ProposedCall { method: 'POST' | 'PATCH' | 'DELETE'; path: string; body?: unknown }

export type DetailChange =
  | { what: 'title' | 'doc_date' | 'provider' | 'doc_type'; from: string | null; to: string | null }
  | { what: 'field_update'; label: string; from: string; to: string }
  | { what: 'field_add'; label: string; to: string }
  | { what: 'field_remove'; label: string; from: string }
  | { what: 'result_update'; name: string; from: string; to: string }
  | { what: 'result_add'; name: string; to: string }
  | { what: 'result_remove'; name: string; from: string };

/** A tag or a provider as the card shows it. A tag has an id; a provider is its name. */
export interface LibraryEntry { id: number | null; name: string; count: number }

/** A directory entry as the card shows it, for the person to compare variants of one person. */
export interface DoctorEntry { id: string; name: string; specialty: string | null; clinic: string | null; license_code: string | null; document_count: number }
/** A test as the card shows it. `units` are the distinct units its values carry: two tests with different units are not safely one. */
export interface TestEntry { canonical: string; name: string; count: number; units: string[] }

export type ProposalBody =
  | {
      kind: 'share_link';
      documents: DocRef[];
      label: string | null;
      expires_days: number;
      language: string | null;
      /** The page lets the owner change these before confirming; the model does not choose them. */
      require_approval: boolean;
      include_scans: boolean;
      allow_chat: boolean;
      /** Whether this server can mail the owner when someone asks, so the page can say what approval will do. */
      approval_mail: boolean;
    }
  | { kind: 'add_note'; document: DocRef; text: string; calls: ProposedCall[] }
  | { kind: 'edit_document'; document: DocRef; changes: DetailChange[]; calls: ProposedCall[] }
  | { kind: 'tag_documents'; items: Array<{ document: DocRef; add: string[]; remove: string[] }>; calls: ProposedCall[] }
  | { kind: 'mark_reviewed'; documents: DocRef[]; calls: ProposedCall[] }
  | { kind: 'link_documents'; from: DocRef; to: DocRef; link_kind: 'requests' | 'follow_up' | 'same_episode'; calls: ProposedCall[] }
  | {
      /** Entries for one person, written several ways, to become one in the form the person agrees on. The page builds the requests, from the final form it shows. */
      kind: 'merge_doctors';
      groups: Array<{ keep: DoctorEntry; merge: DoctorEntry[]; final: { name: string; specialty: string | null; clinic: string | null; license_code: string | null } }>;
    }
  | {
      /** Names for one test, to become one name. */
      kind: 'merge_tests';
      groups: Array<{ into: TestEntry; from: TestEntry[]; final_name: string }>;
    }
  | { kind: 'confirm_grouping'; upload: { id: string; file_name: string | null; uploaded_at: string }; documents: DocRef[]; calls: ProposedCall[] }
  | {
      /** One page image turned, for a scan that is sideways or upside down. Nothing is read again. */
      kind: 'rotate_page';
      upload: { id: string; file_name: string | null };
      page: { id: string; number: number };
      degrees: 90 | 180 | 270;
      calls: ProposedCall[];
    }
  | {
      /** One page set aside (kept, but out of its document's view, search and reading) or brought back. */
      kind: 'hide_page';
      upload: { id: string; file_name: string | null };
      page: { id: string; number: number };
      hidden: boolean;
      /** The document that holds it. */
      document: DocRef | null;
      calls: ProposedCall[];
    }
  | {
      /** One page to another place in its upload: into a document (before a page of it, or at its end) or out into a document of its own. */
      kind: 'move_page';
      upload: { id: string; file_name: string | null };
      page: { id: string; number: number };
      from: DocRef;
      /** Null: a document of its own. */
      to: DocRef | null;
      before_page: number | null;
      calls: ProposedCall[];
    }
  | {
      /** All of one document's pages to the end of another of the same upload, so two documents become one; the combined one is then read again. */
      kind: 'merge_documents';
      upload: { id: string; file_name: string | null };
      into: DocRef;
      from: DocRef;
      page_numbers: number[];
      calls: ProposedCall[];
    }
  | {
      /** Suggested connections between documents (found by the app, not yet confirmed), each to be confirmed or marked not related. */
      kind: 'decide_links';
      items: Array<{ label: string; from: DocRef; to: DocRef; link_kind: 'requests' | 'follow_up' | 'same_episode'; decision: 'confirm' | 'dismiss'; why: LinkWhy | null }>;
      calls: ProposedCall[];
    }
  | { kind: 'analyse_pages'; upload: { id: string; file_name: string | null; uploaded_at: string }; pages: number; calls: ProposedCall[] }
  | {
      /** Groups of pages found to belong together, to be made into documents. The page builds the requests, from the groups the person keeps. */
      kind: 'regroup';
      upload: { id: string; file_name: string | null };
      groups: Array<{ label: string; page_ids: string[]; page_numbers: number[]; title: string | null; confidence: number; status: 'validated' | 'uncertain' | 'unchecked'; reason: string; from: DocRef[] }>;
    }
  | { kind: 'reread_pages'; document: DocRef; page_numbers: number[]; strategy: 'model' | 'configured'; sends_images: boolean; calls: ProposedCall[] }
  | {
      /** Tags, or providers (the clinic or laboratory on documents), written several ways, to become one. The page builds the requests, from the final name it shows. */
      kind: 'merge_library';
      library: 'tags' | 'providers';
      groups: Array<{ keep: LibraryEntry; merge: LibraryEntry[]; final_name: string }>;
    }
  | {
      /** A share link that already exists, changed: its name, how long it works, which documents it shares. Never what it exposes (scans, approval, questions). */
      kind: 'update_share';
      link: { id: string; label: string | null; expires_at: string };
      label: { from: string | null; to: string | null } | null;
      expires: { from: string; to_days: number } | null;
      added: DocRef[];
      removed: DocRef[];
      total_after: number | null;
      calls: ProposedCall[];
    }
  | { kind: 'revoke_share'; link: { id: string; label: string | null; expires_at: string }; calls: ProposedCall[] };

export type Proposal = ProposalBody & { id: string };

export const MAX_PROPOSALS = 5;
export const MAX_SHARED_DOCUMENTS = 30;
export const MAX_BULK = 20;
export const MAX_GROUPS = 10;

export const proposal = (body: ProposalBody): Proposal => ({ id: uuidv4(), ...body });
