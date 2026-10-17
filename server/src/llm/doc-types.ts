import type { DocType } from '../types.js';

/**
 * What to extract from each type of document. One definition, used by the extraction prompt
 * and served to the review screen, so the model and the form agree on the labels.
 *
 * A *field* is something to read (a diagnosis, a dose). A *measurement* is a number with a
 * unit that can be compared across documents (a lab value, a blood pressure), and is what
 * trends over time are drawn from. Fields that belong together, such as the drug, dose and
 * frequency of one prescription line, share a `group`.
 */
export interface DocTypeGuide {
  label: string;
  /** What this kind of document is, so the model recognises it. */
  about: string;
  /** Field labels to use, in the order a reader expects them. */
  fields: string[];
  /** Field labels that repeat, once per item, with the item's fields sharing a group. */
  grouped?: string[];
  /** What to put in `measurements`, if anything. */
  measurements?: string;
  /** Who to expect in `doctors`, and in what role. */
  doctors: string;
  /** How to tell similar fields apart. Goes into the prompt only; the review screen needs just the labels. */
  notes?: string;
}

export const DOC_TYPE_GUIDES: Record<DocType, DocTypeGuide> = {
  lab_result: {
    label: 'Lab result',
    about:
      'blood, urine or other test results ("buletin de analize"); its date is when the sample was collected ("data recoltarii"), not when the report was issued or released',
    fields: ['report_number', 'lab', 'sample_date', 'specimen', 'fasting', 'comment'],
    measurements:
      'EVERY analyte with a result, one measurement each (hemoglobin, glucose, creatinine, cholesterol, ...), with its unit and printed reference range',
    doctors: 'the ordering doctor (referrer; "Trimitor") and any signing doctor (author), with the professional code beside a signature if there is one',
  },
  prescription: {
    label: 'Prescription',
    about: 'a prescription or medication list ("reteta")',
    fields: ['diagnosis', 'valid_until'],
    grouped: ['drug', 'dose', 'frequency', 'duration', 'instructions'],
    doctors: 'the prescribing doctor (prescriber)',
  },
  vaccination: {
    label: 'Vaccination',
    about: 'a vaccination record or certificate',
    fields: [],
    grouped: ['vaccine', 'date', 'dose_number', 'lot', 'site'],
    doctors: 'the doctor or nurse who administered it (author)',
  },
  imaging: {
    label: 'Imaging',
    about: 'a radiology or ultrasound report (X-ray, CT, MRI, ultrasound, ECG)',
    fields: ['report_number', 'modality', 'body_part', 'findings', 'impression', 'comparison', 'recommendation'],
    doctors: 'the reporting radiologist or sonographer (author) and the referring doctor (referrer)',
  },
  discharge_note: {
    label: 'Discharge note',
    about: 'a hospital discharge summary ("bilet de externare", "scrisoare medicala")',
    fields: ['report_number', 'admission_date', 'discharge_date', 'diagnosis', 'diagnosis_code', 'procedure', 'follow_up'],
    grouped: ['discharge_drug', 'discharge_dose', 'discharge_frequency'],
    measurements: 'lab values and vitals the note quotes, each with the date it was taken if the text gives one',
    doctors: 'the attending doctor (author) and the referring doctor (referrer)',
  },
  consultation_note: {
    label: 'Consultation',
    about:
      'a doctor\'s consultation or visit note, including a clinic\'s "raport medical", which can list several services (a consult, an ultrasound), each with its own result',
    fields: [
      'report_number', 'service', 'specialty', 'reason_for_visit', 'symptoms', 'examination',
      'family_history', 'personal_history', 'habits', 'current_treatment', 'investigations',
      'diagnosis', 'diagnosis_code', 'diagnosis_uncoded', 'recommended_tests', 'recommended_vaccines',
      'prevention', 'recommended_medication', 'lifestyle_advice', 'follow_up',
    ],
    grouped: ['drug', 'dose', 'frequency', 'duration'],
    measurements:
      'vitals taken at the visit (blood pressure as systolic and diastolic, heart rate, weight, height, BMI, temperature, oxygen saturation) AND every lab value or hormone level the text quotes, each with the date it was taken when the text gives one (often earlier than the visit)',
    doctors: 'the consulting doctor (author; "Consultat de", or whoever signs) and the referring doctor (referrer; "Recomandat de"), each with the professional code printed beside the signature if there is one',
    notes:
      'reason_for_visit is why the patient came ("se prezinta pentru", "motivul prezentarii"), including a routine or pre-travel visit with no complaint; symptoms is only what the patient reports as complaints, and is left out when there are none. recommended_vaccines lists every vaccine advised; prevention is protection other than vaccines and lifestyle advice, such as malaria prophylaxis. A drug group is a medicine the doctor prescribes or the patient takes now, with the dose when given; medicines only advised to keep at hand or to take if something happens (a travel kit, "in caz de") go together in one recommended_medication field',
  },
  other: {
    label: 'Other',
    about: 'anything else',
    fields: ['diagnosis', 'diagnosis_code', 'summary', 'follow_up'],
    doctors: 'anyone named in a clinical role',
  },
};

/** The guide for the prompt: one short paragraph per type. */
export function guidesForPrompt(): string {
  return (Object.entries(DOC_TYPE_GUIDES) as Array<[DocType, DocTypeGuide]>)
    .map(([type, g]) => {
      const parts = [`${type} (${g.about}):`];
      if (g.fields.length) parts.push(`fields ${g.fields.join(', ')}.`);
      if (g.grouped?.length) parts.push(`Repeating groups, one group per item, with fields ${g.grouped.join(', ')}.`);
      if (g.measurements) parts.push(`Measurements: ${g.measurements}.`);
      parts.push(`Doctors: ${g.doctors}.`);
      if (g.notes) parts.push(`Note: ${g.notes}.`);
      return `- ${parts.join(' ')}`;
    })
    .join('\n');
}

/**
 * The field labels the guides name: the interface has wording for each of these in every language, so a
 * translation leaves them alone. A label the model invented (the guides ask for "a short lowercase label"
 * when none fits) is not here, and is translated like the rest of the text.
 */
export const KNOWN_FIELD_LABELS: ReadonlySet<string> = new Set(
  Object.values(DOC_TYPE_GUIDES).flatMap(guide => [...guide.fields, ...(guide.grouped ?? [])]),
);
