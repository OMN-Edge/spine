/**
 * What a drop of many files, or a zip of them, comes to while it is read: how many files, how many are read, how many documents and pages they became, how many wait for the owner to check the
 * grouping, and how many could not be read. One block says it, so hundreds of pages from several clinics are not hundreds of separate rows to count by eye. Each count is of the batch's own
 * uploads, and the groups partition the files: every file is read, waiting for the owner, being read, or failed, so the numbers add up.
 */
export interface BatchJob {
  status: string;
  reading?: boolean;
  waiting?: unknown;
  groupingConfirmed?: boolean;
  documents: Array<{ page_start: number; page_end: number }>;
  hiddenDocuments?: number;
}

export interface BatchSummary {
  files: number;
  /** Read and needing nothing more from the owner. */
  read: number;
  /** Read into documents that wait for the owner to check how the pages were grouped. */
  checking: number;
  /** Still being read, or waiting for the reading service. */
  working: number;
  /** Could not be read. */
  failed: number;
  /** The same file already in the archive: nothing was added. */
  duplicates: number;
  documents: number;
  pages: number;
}

export function batchSummary(jobs: BatchJob[]): BatchSummary {
  const out: BatchSummary = { files: jobs.length, read: 0, checking: 0, working: 0, failed: 0, duplicates: 0, documents: 0, pages: 0 };
  for (const job of jobs) {
    if (job.status === 'duplicate') { out.duplicates++; continue; }
    if (job.status === 'error') { out.failed++; continue; }
    out.documents += job.documents.length;
    out.pages += job.documents.reduce((sum, d) => sum + (d.page_end - d.page_start + 1), 0);
    const done = job.status === 'done' && !job.reading && !job.waiting;
    if (!done) out.working++;
    else if (job.groupingConfirmed === false && (job.documents.length > 0 || !!job.hiddenDocuments)) out.checking++;
    else out.read++;
  }
  return out;
}

/** A batch is worth a block of its own from two files. */
export const isBatch = (jobs: unknown[]): boolean => jobs.length >= 2;
