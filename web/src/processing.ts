/**
 * Whether a document can be opened yet. A document that is being processed has nothing to show (no title, no details), so "View document" is not offered for it, and its page says it is being
 * read and opens it when it is ready: the upload is still being read, its documents are being read, or they wait for the reading service or for the grouping to be confirmed.
 */
export interface Processing {
  /** The upload's status: pending and processing are not done. */
  status?: string;
  /** Its documents are being read now. */
  reading?: boolean;
  /** It waits for the reading service. */
  waiting?: unknown;
}

export const uploadIsProcessing = (job: Processing): boolean => (job.status !== undefined && job.status !== 'done' && job.status !== 'error') || !!job.reading || !!job.waiting;

/** A document of an upload is ready to open once the upload is not being processed and the document itself has been read. */
export const documentIsReady = (doc: { needs_reading?: boolean | number }, job: Processing): boolean => !uploadIsProcessing(job) && !doc.needs_reading;
