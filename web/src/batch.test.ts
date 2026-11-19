import { describe, expect, it } from 'vitest';
import { batchSummary, isBatch } from './batch';

/** The counts of a batch add up (T-26). */
const doc = (a: number, b: number) => ({ page_start: a, page_end: b });
const read = { status: 'done', groupingConfirmed: true, documents: [doc(1, 3), doc(4, 4)] };

describe('a batch of uploads', () => {
  it('counts files, documents and pages, and sorts every file into exactly one of read, checking, working, failed or duplicate', () => {
    const jobs = [
      read,
      { status: 'done', groupingConfirmed: false, documents: [doc(1, 2), doc(3, 5), doc(6, 6)] },
      { status: 'processing', documents: [] },
      { status: 'done', reading: true, groupingConfirmed: false, documents: [doc(1, 1)] },
      { status: 'error', documents: [] },
      { status: 'duplicate', documents: [doc(1, 9)] },
    ];
    const s = batchSummary(jobs);
    expect(s).toEqual({ files: 6, read: 1, checking: 1, working: 2, failed: 1, duplicates: 1, documents: 6, pages: 4 + 6 + 1 });
    expect(s.read + s.checking + s.working + s.failed + s.duplicates).toBe(s.files);
  });

  it('adds up for twenty files: each in one group, the pages the sum of the documents’ pages', () => {
    const jobs = Array.from({ length: 20 }, (_, i) => (i < 12 ? read : i < 17 ? { status: 'done', groupingConfirmed: false, documents: [doc(1, 4)] } : i < 19 ? { status: 'processing', documents: [] } : { status: 'error', documents: [] }));
    const s = batchSummary(jobs);
    expect([s.read, s.checking, s.working, s.failed]).toEqual([12, 5, 2, 1]);
    expect(s.read + s.checking + s.working + s.failed + s.duplicates).toBe(20);
    expect(s.documents).toBe(12 * 2 + 5);
    expect(s.pages).toBe(12 * 4 + 5 * 4);
  });

  it('holds a file waiting for the reading service as still working, not read', () => {
    expect(batchSummary([{ status: 'done', waiting: { retry_at: 'later' }, documents: [doc(1, 2)] }]).working).toBe(1);
  });

  it('is a batch from two files', () => {
    expect(isBatch([1])).toBe(false);
    expect(isBatch([1, 2])).toBe(true);
  });
});
