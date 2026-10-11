/**
 * How a document is named everywhere in the UI: its title (printed on it, or generated
 * when it was read), or failing that its type and provider. Never the upload's file name,
 * which is usually a scanner's "scan_0042.pdf" and says nothing about the contents.
 */
export const DOC_TYPE_NAMES: Record<string, string> = {
  lab_result: 'Lab result',
  discharge_note: 'Discharge note',
  vaccination: 'Vaccination',
  imaging: 'Imaging',
  prescription: 'Prescription',
  consultation_note: 'Consultation',
  other: 'Document',
};

export interface Nameable {
  title?: string | null;
  doc_type?: string | null;
  provider?: string | null;
}

export function documentTitle(doc: Nameable): string {
  if (doc.title?.trim()) return doc.title.trim();
  const type = (doc.doc_type && DOC_TYPE_NAMES[doc.doc_type]) || 'Document';
  return doc.provider ? `${type} · ${doc.provider}` : type;
}

/** The line under a title: who, what and when, skipping what is unknown. */
export function documentByline(doc: Nameable & { doc_date?: string | null }): string {
  return [doc.provider, doc.doc_type ? DOC_TYPE_NAMES[doc.doc_type] ?? doc.doc_type : null, doc.doc_date]
    .filter(Boolean)
    .join(' · ');
}
