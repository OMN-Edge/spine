/**
 * Which documents the owner sees, as a rule rather than as SQL (the same rule a store writes in its own language: `sqlite/visibility.ts`
 * is SQLite's). Every listing of the owner's documents means this by "shown", and a store's rendering of it is checked against these
 * functions by the store contract (`__tests__/contract/store-contract.ts`), so a second store has the sentence to implement and a test to pass.
 *
 *  - A document is *set aside* when it has pages and the owner has hidden every one of them. A document with no pages at all is not set
 *    aside: nothing was hidden.
 *  - The documents of an upload are held back until the owner has confirmed how its pages were grouped.
 *  - A document is shown when it is neither.
 */
export function isSetAside(pages: ReadonlyArray<{ hidden: boolean }>): boolean {
  return pages.length > 0 && pages.every(p => p.hidden);
}

export function isVisible(document: { pages: ReadonlyArray<{ hidden: boolean }>; groupingConfirmed: boolean }): boolean {
  return !isSetAside(document.pages) && document.groupingConfirmed;
}

/** What `includeHidden` and `includeUnconfirmed` (the regrouping and upload screens) change about "shown". */
export function isListed(
  document: { pages: ReadonlyArray<{ hidden: boolean }>; groupingConfirmed: boolean },
  options: { includeHidden?: boolean; includeUnconfirmed?: boolean } = {},
): boolean {
  if (options.includeHidden) return true;
  if (options.includeUnconfirmed) return !isSetAside(document.pages);
  return isVisible(document);
}
