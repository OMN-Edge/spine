import { describe, expect, it } from 'vitest';
import { documentIsReady, uploadIsProcessing } from './processing';

/** A document being processed is not offered to be opened (the owner's request). */
describe('when a document can be opened', () => {
  it('is not while its upload is pending or processing, its documents are being read, or it waits for the reading service', () => {
    for (const job of [{ status: 'pending' }, { status: 'processing' }, { status: 'done', reading: true }, { status: 'done', waiting: { retry_at: 'later' } }]) {
      expect(uploadIsProcessing(job)).toBe(true);
      expect(documentIsReady({}, job)).toBe(false);
    }
  });

  it('is not for a document that has not been read yet, even in a finished upload (it waits for the grouping to be confirmed)', () => {
    expect(documentIsReady({ needs_reading: true }, { status: 'done' })).toBe(false);
    expect(documentIsReady({ needs_reading: 1 }, { status: 'done' })).toBe(false);
  });

  it('is for a read document of a finished upload', () => {
    expect(documentIsReady({ needs_reading: false }, { status: 'done' })).toBe(true);
    expect(documentIsReady({}, { status: 'done', reading: false })).toBe(true);
  });

  it('is not held for a failed upload, which has nothing being processed', () => {
    expect(uploadIsProcessing({ status: 'error' })).toBe(false);
  });
});
