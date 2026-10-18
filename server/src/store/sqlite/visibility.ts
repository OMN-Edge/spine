/**
 * A document is set aside when it has pages and the owner has hidden every one of them. It then leaves
 * the timeline, search, review queue, share links, a doctor's list and the trends, and stays on the
 * upload's regrouping screen, where it is marked and can be brought back by showing a page. A document
 * with no pages at all is not set aside: nothing was hidden.
 *
 * SQL, written for the alias `d` on `documents`, so every query that lists documents says it the same way.
 */
const PAGES_OF_D =
  'p.source_file_id = d.source_file_id AND p.user_id = d.user_id AND p.page_number BETWEEN d.page_start AND d.page_end';

export const NOT_SET_ASIDE = `NOT (
  EXISTS (SELECT 1 FROM pages p WHERE ${PAGES_OF_D})
  AND NOT EXISTS (SELECT 1 FROM pages p WHERE ${PAGES_OF_D} AND p.hidden = 0)
)`;

/**
 * The documents of an upload are held back until the owner has confirmed how its pages were grouped: a grouping that may
 * still change must not reach search, shares, trends, links or the review queue. The upload and regrouping screens ask for
 * them anyway (`includeUnconfirmed`).
 */
export const UPLOAD_CONFIRMED = `EXISTS (SELECT 1 FROM source_files sf WHERE sf.id = d.source_file_id AND sf.user_id = d.user_id AND sf.grouping_confirmed = 1)`;

/** What every listing of the owner's documents means by "shown": not set aside, and its upload's grouping confirmed. */
export const VISIBLE = `(${NOT_SET_ASIDE} AND ${UPLOAD_CONFIRMED})`;
