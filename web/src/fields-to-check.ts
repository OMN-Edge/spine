import type { ExtractedField, Document, Page } from './api';

/**
 * The values the model was unsure of (handwriting, a faded line), from every document not yet reviewed, as one queue to walk through one at a time, each beside the page it was read from,
 * instead of opening each document to find them. A value appears once: it leaves the queue when the owner keeps it or corrects it (either way it becomes theirs and is not flagged again).
 */
export interface QueueItem {
  documentId: string;
  documentTitle: string | null;
  docDate: string | null;
  field: ExtractedField;
  page: Pick<Page, 'id' | 'page_number' | 'rotation' | 'extraction_source'> | null;
}

type Detailed = Pick<Document, 'id' | 'title' | 'doc_date'> & { reviewed?: boolean | number; fields?: ExtractedField[]; pages?: Array<Pick<Page, 'id' | 'page_number' | 'rotation' | 'extraction_source'>> };

export function queueOf(documents: Detailed[]): QueueItem[] {
  const seen = new Set<string>();
  const items: QueueItem[] = [];
  for (const doc of documents) {
    if (doc.reviewed) continue;
    for (const field of doc.fields ?? []) {
      if (!field.needs_check || seen.has(field.id)) continue;
      seen.add(field.id);
      items.push({ documentId: doc.id, documentTitle: doc.title, docDate: doc.doc_date, field, page: doc.pages?.find(p => p.id === field.page_id) ?? null });
    }
  }
  // Newest document first, then in the order the values stand on the page.
  return items.sort((a, b) => (b.docDate ?? '').localeCompare(a.docDate ?? '') || a.documentId.localeCompare(b.documentId));
}
