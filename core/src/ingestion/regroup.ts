import { getStore } from '../store/index.js';
import type { PageGroup } from './move-page.js';

/**
 * Rearranging an upload's pages into new documents, many at once: the general form of `move-page.ts`. The owner (or the chat,
 * on their Confirm) names groups of pages that belong together; every page not named stays in the document it is in, and what is
 * left of a document that lost pages stays a document. Everything else follows, as for a move: pages are numbered again in order,
 * each document's range is the numbers its pages now have, and what was read from a page (its fields and results) goes with it.
 *
 * A group keeps the identity (and so the owner's edits) of the existing document it mostly is, if it is at least half of that
 * document and the document at least half of it; otherwise it is a new document. A document no group keeps is removed, its
 * leftovers folded into where most of its pages went. Documents whose pages changed are unreviewed and must be read again.
 *
 * `planRegroup` does the list work and touches nothing; `applyRegroup` applies it in one transaction.
 */
export class RegroupError extends Error {
  constructor(readonly code: 'not_found' | 'bad_groups' | 'inconsistent', message: string) {
    super(message);
    this.name = 'RegroupError';
  }
}

export interface RegroupArrangement {
  /** The documents after, in order. */
  groups: Array<PageGroup & { isNew: boolean }>;
  /** Documents no group kept. */
  deleted: string[];
  /** Documents that are new or whose pages are not what they were: unreviewed, to be read again. */
  touched: string[];
  /** Kept documents whose pages did not change. */
  unchanged: string[];
  /** For a document that is deleted, where most of its pages went. */
  foldInto: Map<string, string>;
}

const KEEP = 0.5;

export function planRegroup(current: PageGroup[], named: string[][], newId: () => string): RegroupArrangement {
  const known = new Set(current.flatMap(g => g.pageIds));
  const seen = new Set<string>();
  for (const group of named) {
    if (group.length === 0) throw new RegroupError('bad_groups', 'a group has no pages');
    for (const id of group) {
      if (!known.has(id)) throw new RegroupError('bad_groups', 'a page is not part of this upload');
      if (seen.has(id)) throw new RegroupError('bad_groups', 'a page is in two groups');
      seen.add(id);
    }
  }

  // Every page not named stays with the pages it was with.
  const position = new Map(current.flatMap(g => g.pageIds).map((id, i) => [id, i]));
  const wanted: string[][] = [...named.map(g => g.slice())];
  for (const doc of current) {
    const rest = doc.pageIds.filter(id => !seen.has(id));
    if (rest.length > 0) wanted.push(rest);
  }

  // Which existing document each group is: the largest overlaps first, each document once.
  const overlaps: Array<{ group: number; doc: number; n: number }> = [];
  wanted.forEach((g, gi) => current.forEach((d, di) => {
    const n = g.filter(id => d.pageIds.includes(id)).length;
    if (n > 0 && n / Math.max(g.length, d.pageIds.length) >= KEEP) overlaps.push({ group: gi, doc: di, n });
  }));
  overlaps.sort((a, b) => b.n - a.n || a.doc - b.doc || a.group - b.group);
  const claimed = new Map<number, number>(); // group -> doc
  const used = new Set<number>();
  for (const o of overlaps) {
    if (claimed.has(o.group) || used.has(o.doc)) continue;
    claimed.set(o.group, o.doc);
    used.add(o.doc);
  }

  const groups = wanted.map((pageIds, gi) => {
    const doc = claimed.get(gi);
    return { documentId: doc === undefined ? newId() : current[doc].documentId, pageIds, isNew: doc === undefined };
  });
  // In the order the pages come in the file, as documents always are.
  groups.sort((a, b) => Math.min(...a.pageIds.map(id => position.get(id)!)) - Math.min(...b.pageIds.map(id => position.get(id)!)));

  const deleted = current.filter((_, di) => !used.has(di)).map(d => d.documentId);
  const foldInto = new Map<string, string>();
  for (const id of deleted) {
    const old = current.find(d => d.documentId === id)!;
    const counts = new Map<string, number>();
    for (const g of groups) counts.set(g.documentId, g.pageIds.filter(p => old.pageIds.includes(p)).length);
    foldInto.set(id, [...counts].sort((a, b) => b[1] - a[1])[0][0]);
  }

  const before = new Map(current.map(d => [d.documentId, d.pageIds.join('|')]));
  const touched = groups.filter(g => g.isNew || before.get(g.documentId) !== g.pageIds.join('|')).map(g => g.documentId);
  const unchanged = groups.filter(g => !g.isNew && before.get(g.documentId) === g.pageIds.join('|')).map(g => g.documentId);
  return { groups, deleted, touched, unchanged, foldInto };
}

export interface RegroupResult {
  /** Documents to read again: new ones and ones whose pages changed. */
  touched: string[];
  created: string[];
  deleted: string[];
  unchanged: number;
}

export async function applyRegroup(userId: string, sourceFileId: string, named: string[][], newId: () => string): Promise<RegroupResult> {
  return getStore().transaction(async tx => {
    if (!(await tx.sourceFiles.findFor(userId, sourceFileId))) throw new RegroupError('not_found', 'the upload was not found');
    const documents = (await tx.documents.listFor(userId, { sourceFileId, limit: 1000, offset: 0, includeHidden: true, includeUnconfirmed: true }))
      .sort((a, b) => a.page_start - b.page_start);
    const pages = await tx.pages.listForSourceFile(userId, sourceFileId);
    const current: PageGroup[] = documents.map(d => ({
      documentId: d.id,
      pageIds: pages.filter(p => p.page_number >= d.page_start && p.page_number <= d.page_end).map(p => p.id),
    }));
    if (current.reduce((n, g) => n + g.pageIds.length, 0) !== pages.length || new Set(current.flatMap(g => g.pageIds)).size !== pages.length) {
      throw new RegroupError('inconsistent', 'the upload\'s documents do not cover its pages one for one');
    }

    const plan = planRegroup(current, named, newId);
    const originOf = new Map(current.flatMap(g => g.pageIds.map(id => [id, g.documentId] as const)));
    const created = plan.groups.filter(g => g.isNew).map(g => g.documentId);

    // New documents, with the tags of the documents their pages came from until they are read.
    for (const g of plan.groups.filter(x => x.isNew)) {
      await tx.documents.create(userId, { id: g.documentId, sourceFileId, pageStart: 1, pageEnd: 1, docType: 'other' });
      const tags = new Set<string>();
      for (const origin of new Set(g.pageIds.map(id => originOf.get(id)!))) for (const t of await tx.tags.namesForDocument(userId, origin)) tags.add(t);
      if (tags.size > 0) await tx.tags.setForDocument(userId, g.documentId, [...tags]);
    }
    // What was read from a page goes with it.
    for (const g of plan.groups) {
      for (const pageId of g.pageIds) {
        if (originOf.get(pageId) !== g.documentId) {
          await tx.fields.reassignPage(userId, pageId, g.documentId);
          await tx.measurements.reassignPage(userId, pageId, g.documentId);
        }
      }
    }
    // A document no group kept is folded into where most of its pages went, as a join does, then removed.
    for (const id of plan.deleted) {
      const into = plan.foldInto.get(id)!;
      await tx.fields.reassignDocument(userId, id, into);
      await tx.measurements.reassignDocument(userId, id, into);
      await tx.doctors.moveLinks(userId, id, into);
      await tx.tags.removeAllForDocument(userId, id);
      await tx.documents.delete(userId, id);
    }

    await tx.pages.renumber(userId, sourceFileId, plan.groups.flatMap(g => g.pageIds));
    let at = 1;
    for (const g of plan.groups) {
      await tx.documents.setRange(userId, g.documentId, at, at + g.pageIds.length - 1);
      at += g.pageIds.length;
    }
    for (const id of plan.touched) await tx.documents.update(userId, id, { reviewed: false, needs_reading: true });
    // The plan was about the arrangement that has just changed.
    await tx.regroupPlans.remove(userId, sourceFileId);
    return { touched: plan.touched, created, deleted: plan.deleted, unchanged: plan.unchanged.length };
  });
}
