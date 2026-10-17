/**
 * How a document is named everywhere in the UI: its title (printed on it, or generated
 * when it was read), or failing that its type and provider. Never the upload's file name,
 * which is usually a scanner's "scan_0042.pdf" and says nothing about the contents.
 */
/**
 * What a field is called on screen. The stored label is the machine key the model was asked to use
 * (`reason_for_visit`), which search and grouping rely on; this is only how it is shown. A label that is
 * not here (the model may invent one, or the owner typed one) is shown as written, with underscores
 * read as spaces.
 */
export const FIELD_NAMES: Record<string, string> = {
  report_number: 'Report number', service: 'Service', specialty: 'Specialty',
  reason_for_visit: 'Reason for visit', symptoms: 'Symptoms', examination: 'Examination',
  family_history: 'Family history', personal_history: 'Personal history', habits: 'Habits',
  current_treatment: 'Current treatment', investigations: 'Investigations',
  diagnosis: 'Diagnosis', diagnosis_code: 'Diagnosis code (ICD)', diagnosis_uncoded: 'Diagnosis without a code',
  recommended_tests: 'Recommended tests', recommended_vaccines: 'Recommended vaccines',
  prevention: 'Prevention', recommended_medication: 'Recommended medication',
  lifestyle_advice: 'Lifestyle advice', follow_up: 'Follow-up',
  lab: 'Laboratory', sample_date: 'Sample date', specimen: 'Specimen', fasting: 'Fasting', comment: 'Comment',
  valid_until: 'Valid until', drug: 'Drug', dose: 'Dose', frequency: 'Frequency', duration: 'Duration', instructions: 'Instructions',
  vaccine: 'Vaccine', date: 'Date', dose_number: 'Dose number', lot: 'Lot', site: 'Site',
  modality: 'Modality', body_part: 'Body part', findings: 'Findings', impression: 'Impression',
  comparison: 'Comparison', recommendation: 'Recommendation',
  admission_date: 'Admission date', discharge_date: 'Discharge date', procedure: 'Procedure',
  discharge_drug: 'Drug at discharge', discharge_dose: 'Dose at discharge', discharge_frequency: 'Frequency at discharge',
  summary: 'Summary',
};

/** Looks an English string up in the reader's language (the `t` of useI18n); without one, English as written. */
export type Translate = (english: string) => string;
const asWritten: Translate = english => english;

export function fieldName(label: string, t: Translate = asWritten): string {
  if (FIELD_NAMES[label]) return t(FIELD_NAMES[label]);
  if (!label.includes('_')) return label;
  const spaced = label.replace(/_+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const LABEL_OF_NAME = new Map(Object.entries(FIELD_NAMES).map(([label, name]) => [name.toLowerCase(), label]));

/** What the owner typed in the label box, back to the key it stands for; anything else is kept as typed. */
export function labelFromName(typed: string): string {
  return LABEL_OF_NAME.get(typed.trim().toLowerCase()) ?? typed;
}

/** A value this long, or with line breaks, is shown under its name as a section instead of beside it. */
const SECTION_LENGTH = 60;
export const isSection = (value: string): boolean => value.length > SECTION_LENGTH || value.includes('\n');

/** Fields whose value is a list the model joined with semicolons. */
const SEMICOLON_LISTS = new Set(['recommended_tests', 'recommended_vaccines', 'recommended_medication', 'current_treatment']);

/**
 * A long value as lines, for reading: a numbered list ("1, … 2, …") one item per line, a joined list one
 * entry per line, and the model's own line breaks kept. Display only; the stored value is not changed.
 */
export function valueLines(label: string, value: string): string[] {
  let text = value.trim();
  if (/^1[.,)]\s/.test(text)) text = text.replace(/\s+(?=\d{1,2}[.,)]\s)/g, '\n');
  if (SEMICOLON_LISTS.has(label)) text = text.replace(/\s*;\s*/g, '\n');
  return text.split('\n').map(line => line.trim()).filter(Boolean);
}

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

export function documentTitle(doc: Nameable, t: Translate = asWritten): string {
  if (doc.title?.trim()) return doc.title.trim();
  const type = t((doc.doc_type && DOC_TYPE_NAMES[doc.doc_type]) || 'Document');
  return doc.provider ? `${type} · ${doc.provider}` : type;
}

/** The line under a title: who, what and when, skipping what is unknown. */
export function documentByline(doc: Nameable & { doc_date?: string | null }, t: Translate = asWritten): string {
  return [doc.provider, doc.doc_type ? t(DOC_TYPE_NAMES[doc.doc_type] ?? doc.doc_type) : null, doc.doc_date]
    .filter(Boolean)
    .join(' · ');
}
