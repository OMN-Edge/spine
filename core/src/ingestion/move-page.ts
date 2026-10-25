import { getStore } from '../store/index.js';

/**
 * Moving one page to another place in an upload: to another position in its own document, into another
 * document, or out into a document of its own.
 *
 * An upload is an ordered list of pages cut into documents, each a run of consecutive pages. So a move is a
 * change to a list of lists, and everything else follows from the result: pages are numbered again in order,
 * each document's range is the numbers its pages now have, and what was read from the page (its fields and
 * results) goes with it. Document order never changes; the pages inside and between them do.
 *
 * `planMove` does the list work and touches nothing; `movePage` applies it in one transaction.
 */

export interface PageGroup {
  documentId: string;
  pageIds: string[];
}

export type MoveTarget =
  /** Into this document, just before that page of it, or at its end if `beforePageId` is null. */
  | { documentId: string; beforePageId: string | null }
  /** Into a new document of its own, placed before that document, or last if `beforeDocumentId` is null. */
  | { newDocument: true; beforeDocumentId: string | null };

export class MoveError extends Error {
  constructor(readonly code: 'not_found' | 'bad_target' | 'inconsistent', message: string) {
    super(message);
    this.name = 'MoveError';
  }
}

export interface MovePlan {
  /** The groups after the move, in order, without a document that has no pages left. */
  groups: PageGroup[];
  /** The id of the document made for the page, if it got one. */
  created: string | null;
  /** The document the page was in, and the one it is in now. */
  origin: string;
  destination: string;
  /** A document that lost its only page and is gone. */
  emptied: string | null;
  /** False when the page ends up exactly where it was: nothing is written. */
  changed: boolean;
}

export function planMove(groups: PageGroup[], pageId: string, target: MoveTarget, newDocumentId: string): MovePlan {
  const origin = groups.find(g => g.pageIds.includes(pageId));
  if (!origin) throw new MoveError('not_found', 'the page is not in this upload');

  const flat = (list: PageGroup[]) => list.flatMap(g => g.pageIds.map(id => `${g.documentId}:${id}`));
  const before = flat(groups);

  // A page alone in its document, put into a document of its own, is where it was.
  if ('newDocument' in target && origin.pageIds.length === 1) {
    return { groups, created: null, origin: origin.documentId, destination: origin.documentId, emptied: null, changed: false };
  }

  const next: PageGroup[] = groups.map(g => ({ documentId: g.documentId, pageIds: g.pageIds.filter(id => id !== pageId) }));
  let destination: string;
  let created: string | null = null;

  if ('newDocument' in target) {
    const at = target.beforeDocumentId === null ? next.length : next.findIndex(g => g.documentId === target.beforeDocumentId);
    if (at < 0) throw new MoveError('bad_target', 'the document to place it before is not in this upload');
    next.splice(at, 0, { documentId: newDocumentId, pageIds: [pageId] });
    destination = newDocumentId;
    created = newDocumentId;
  } else {
    const group = next.find(g => g.documentId === target.documentId);
    if (!group) throw new MoveError('bad_target', 'the document is not in this upload');
    let at = group.pageIds.length;
    if (target.beforePageId !== null) {
      if (target.beforePageId === pageId) throw new MoveError('bad_target', 'a page cannot be placed before itself');
      at = group.pageIds.indexOf(target.beforePageId);
      if (at < 0) throw new MoveError('bad_target', 'the page to place it before is not in that document');
    }
    group.pageIds.splice(at, 0, pageId);
    destination = group.documentId;
  }

  const emptied = next.find(g => g.pageIds.length === 0)?.documentId ?? null;
  const result = next.filter(g => g.pageIds.length > 0);
  const changed = flat(result).join('|') !== before.join('|');
  return { groups: result, created: changed ? created : null, origin: origin.documentId, destination, emptied, changed };
}

export interface MoveResult {
  moved: boolean;
  /** Documents whose pages changed: they are unreviewed now and need reading again. */
  touched: string[];
  /** A document that had only this page and was folded into where the page went. */
  deleted: string[];
  created: string | null;
}

export async function movePage(userId: string, pageId: string, target: MoveTarget, newDocumentId: string): Promise<MoveResult> {
  return getStore().transaction(async tx => {
    const sourceFileId = await tx.pages.sourceFileOf(userId, pageId);
    if (!sourceFileId) throw new MoveError('not_found', 'the page was not found');

    const documents = (await tx.documents.listFor(userId, { sourceFileId, limit: 1000, offset: 0, includeHidden: true }))
      .sort((a, b) => a.page_start - b.page_start);
    const pages = await tx.pages.listForSourceFile(userId, sourceFileId);

    const groups: PageGroup[] = documents.map(d => ({
      documentId: d.id,
      pageIds: pages.filter(p => p.page_number >= d.page_start && p.page_number <= d.page_end).map(p => p.id),
    }));
    // Every page in exactly one document, or the ranges are not something to rewrite from a drag.
    if (groups.reduce((n, g) => n + g.pageIds.length, 0) !== pages.length || new Set(groups.flatMap(g => g.pageIds)).size !== pages.length) {
      throw new MoveError('inconsistent', 'the upload\'s documents do not cover its pages one for one');
    }

    const plan = planMove(groups, pageId, target, newDocumentId);
    if (!plan.changed) return { moved: false, touched: [], deleted: [], created: null };

    if (plan.created) await tx.documents.create(userId, { id: plan.created, sourceFileId, pageStart: 1, pageEnd: 1, docType: 'other' });

    // What was read from the page goes with it.
    if (plan.origin !== plan.destination) {
      await tx.fields.reassignPage(userId, pageId, plan.destination);
      await tx.measurements.reassignPage(userId, pageId, plan.destination);
    }
    // A document left with no pages is folded into where its page went, as a join does, then removed.
    if (plan.emptied) {
      await tx.fields.reassignDocument(userId, plan.emptied, plan.destination);
      await tx.measurements.reassignDocument(userId, plan.emptied, plan.destination);
      await tx.doctors.moveLinks(userId, plan.emptied, plan.destination);
      await tx.tags.removeAllForDocument(userId, plan.emptied);
      await tx.documents.delete(userId, plan.emptied);
    }

    await tx.pages.renumber(userId, sourceFileId, plan.groups.flatMap(g => g.pageIds));
    let position = 1;
    for (const group of plan.groups) {
      await tx.documents.setRange(userId, group.documentId, position, position + group.pageIds.length - 1);
      position += group.pageIds.length;
    }

    const touched = [...new Set([plan.origin, plan.destination])].filter(id => id !== plan.emptied);
    for (const id of touched) await tx.documents.update(userId, id, { reviewed: false, needs_reading: true });
    return { moved: true, touched, deleted: plan.emptied ? [plan.emptied] : [], created: plan.created };
  });
}
