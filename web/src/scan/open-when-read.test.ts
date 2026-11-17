import { describe, expect, it } from 'vitest';
import { documentToOpen } from './open-when-read';

/** The photographed letter opens by itself once it is read (T-27). */
describe('opening a scanned letter once it is read', () => {
  it('is the one document of a finished upload that has nothing left to check', () => {
    expect(documentToOpen({ status: 'done', documents: [{ id: 'd1' }] })).toBe('d1');
    expect(documentToOpen({ status: 'done', grouping_confirmed: true, reading: false, documents: [{ id: 'd1' }] })).toBe('d1');
  });

  it('waits while it is being read, while it waits for the model, and while the grouping is still to be checked', () => {
    expect(documentToOpen({ status: 'processing', documents: [{ id: 'd1' }] })).toBeNull();
    expect(documentToOpen({ status: 'done', reading: true, documents: [{ id: 'd1' }] })).toBeNull();
    expect(documentToOpen({ status: 'done', waiting: { retry_at: 'later' }, documents: [{ id: 'd1' }] })).toBeNull();
    expect(documentToOpen({ status: 'done', grouping_confirmed: false, documents: [{ id: 'd1' }] })).toBeNull();
  });

  it('stays on the Upload page for no document, several documents, or a failure', () => {
    expect(documentToOpen({ status: 'done', documents: [] })).toBeNull();
    expect(documentToOpen({ status: 'done', documents: [{ id: 'a' }, { id: 'b' }] })).toBeNull();
    expect(documentToOpen({ status: 'error' })).toBeNull();
  });
});
