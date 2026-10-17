import type { JobStatus } from '../types.js';

/**
 * Progress of the work on an upload, by upload id: reading it (`pipeline.ts`) or restoring it from an export
 * (`archive/import-file.ts`). In memory, because a restart ends the work anyway and `reconcileStalledJobs`
 * fails the rows it left behind. The browser polls it through `GET /api/source-files/:id/status`.
 */
const jobs = new Map<string, JobStatus>();

export function getJobStatus(sourceFileId: string): JobStatus | null {
  return jobs.get(sourceFileId) ?? null;
}

/**
 * How many uploads are worked on at once. Reading or restoring a file is heavy (poppler, OCR, and model calls), and a zip
 * can bring hundreds of files in one request, so the rest wait their turn instead of all starting together.
 */
const CONCURRENT_JOBS = 2;
let running = 0;
const waiting: Array<() => void> = [];

export async function runQueued<T>(work: () => Promise<T>): Promise<T> {
  if (running >= CONCURRENT_JOBS) await new Promise<void>(resolve => waiting.push(resolve));
  running += 1;
  try {
    return await work();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

/** A new job, running. Null if one already is: the caller must not start a second. */
export function beginJob(sourceFileId: string): JobStatus | null {
  if (jobs.get(sourceFileId)?.status === 'processing') return null;
  const job: JobStatus = { source_file_id: sourceFileId, status: 'processing', progress: 0, step: 'queued' };
  jobs.set(sourceFileId, job);
  return job;
}
