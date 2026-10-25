import type { ManifestDocument, ManifestFile } from '../archive/manifest.js';

/**
 * The sample records (FR-ACC-03): a few documents about nobody, in English or Romanian, invented for this purpose. They are shaped
 * like what reading a real upload produces (details, results over time, a prescription, a report), so every screen has something
 * to show, and they are written through the restore path, so no model is called and nothing leaves the host. No name, number or
 * date in them belongs to a person; the dates are counted back from today so the timeline looks recent.
 */
export type DemoLanguage = 'en' | 'ro';
export const DEMO_LANGUAGES: readonly DemoLanguage[] = ['en', 'ro'];

export interface DemoRecord {
  /** The document's text, which becomes the page of its PDF. */
  text: string;
  file: ManifestFile;
}

const monthsAgo = (now: Date, months: number, day: number): string => {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, Math.min(day, 28)));
  return d.toISOString().slice(0, 10);
};

interface Words {
  clinic: string; lab: string; labDoctor: string; family: string; radio: string;
  famSpec: string; labSpec: string;
  [k: string]: string;
}

const WORDS: Record<DemoLanguage, Words> = {
  en: {
    clinic: 'Example Clinic', lab: 'Example Laboratory', labDoctor: 'Dr. Ana Reagent', family: 'Dr. Radu Demo', radio: 'Dr. Ioan Specimen',
    famSpec: 'family medicine', labSpec: 'laboratory medicine',
  },
  ro: {
    clinic: 'Clinica Exemplu', lab: 'Laborator Exemplu', labDoctor: 'Dr. Ana Reagent', family: 'Dr. Radu Demo', radio: 'Dr. Ioan Specimen',
    famSpec: 'medicină de familie', labSpec: 'medicină de laborator',
  },
};

type Cell = [name: string, canonical: string, value: string, unit: string, low: number | null, high: number | null, flag: 'low' | 'high' | 'normal' | null];

function lab(lang: DemoLanguage, date: string, rows: Cell[], title: string, w: Words, fileName: string): DemoRecord {
  const header = lang === 'ro' ? `${w.lab}\nBuletin de analize\nData recoltării: ${date}` : `${w.lab}\nLaboratory report\nSample collected: ${date}`;
  const body = rows.map(([name, , value, unit, low, high]) => `${name}: ${value} ${unit}${low !== null && high !== null ? ` (${low} - ${high})` : high !== null ? ` (< ${high})` : low !== null ? ` (> ${low})` : ''}`).join('\n');
  const text = `${header}\n\n${body}\n`;
  const doc: ManifestDocument = {
    page_start: 1, page_end: 1, title, doc_date: date, provider: w.lab, doc_type: 'lab_result',
    ai_summary: lang === 'ro' ? `Buletin de analize din ${date} cu ${rows.length} rezultate.` : `Laboratory report of ${date} with ${rows.length} results.`,
    user_notes: null, language: lang, reviewed: true, tags: ['lab'],
    doctors: [{ name: w.labDoctor, specialty: w.labSpec, clinic: w.lab, license_code: null, role: 'author', person: null, source: 'text', printed_code: null }],
    fields: [{ label: 'lab', value: w.lab, group_no: null, page: 1, source_snippet: null, bbox: null, confidence: 1, owner_edited: false }],
    measurements: rows.map(([name, canonical, value, unit, low, high, flag]) => ({
      name, canonical, value_text: value, value_num: Number(value.replace(',', '.')), unit, ref_low: low, ref_high: high, flag, taken_on: date,
      page: 1, source_snippet: null, bbox: null, confidence: 1, owner_edited: false,
    })),
    owner_edited: [], removed_fields: [], removed_measurements: [],
  };
  return record(text, fileName, doc);
}

function record(text: string, fileName: string, doc: ManifestDocument): DemoRecord {
  return {
    text,
    file: {
      path: fileName, original_filename: fileName, sha256: '0'.repeat(64), photo_set: false, page_count: 1,
      pages: [{ number: 1, source_page: 1, hidden: false, extraction_source: 'native_text', raw_text: text, elements: [] }],
      documents: [doc],
    },
  };
}

export function demoRecords(lang: DemoLanguage, now = new Date()): DemoRecord[] {
  const w = WORDS[lang];
  const ro = lang === 'ro';
  const visit = monthsAgo(now, 14, 12); const labOne = monthsAgo(now, 8, 3); const labTwo = monthsAgo(now, 2, 5); const xray = monthsAgo(now, 2, 9);

  const field = (label: string, value: string, group: number | null = null) => ({ label, value, group_no: group, page: 1, source_snippet: null, bbox: null, confidence: 1, owner_edited: false });

  const consultationText = ro
    ? `${w.clinic}\nConsultație – medicină de familie\nData: ${visit}\n\nMotivul prezentării: strănut și ochi care lăcrimează primăvara.\nAlergii: polen.\nDiagnostic: rinită alergică sezonieră.\nTratament recomandat: cetirizină 10 mg, o dată pe zi, în sezon.\nControl: peste 3 luni.\n${w.family}\n`
    : `${w.clinic}\nConsultation – family medicine\nDate: ${visit}\n\nReason for visit: sneezing and watery eyes in spring.\nAllergies: pollen.\nDiagnosis: seasonal allergic rhinitis.\nRecommended treatment: cetirizine 10 mg, once a day, in season.\nFollow-up: in 3 months.\n${w.family}\n`;
  const consultation = record(consultationText, ro ? 'consultatie-exemplu.pdf' : 'sample-consultation.pdf', {
    page_start: 1, page_end: 1, title: ro ? 'Consultație medicină de familie' : 'Family medicine consultation', doc_date: visit, provider: w.clinic, doc_type: 'consultation_note',
    ai_summary: ro ? 'Consultație pentru strănut și ochi care lăcrimează; diagnosticul scris este rinită alergică sezonieră, cu control peste 3 luni.' : 'Consultation for sneezing and watery eyes; the written diagnosis is seasonal allergic rhinitis, with a follow-up in 3 months.',
    user_notes: null, language: lang, reviewed: true, tags: ['allergy'],
    doctors: [{ name: w.family, specialty: w.famSpec, clinic: w.clinic, license_code: null, role: 'author', person: null, source: 'text', printed_code: null }],
    fields: [
      field('reason_for_visit', ro ? 'strănut și ochi care lăcrimează primăvara' : 'sneezing and watery eyes in spring'),
      field('allergies', ro ? 'polen' : 'pollen'),
      field('diagnosis', ro ? 'rinită alergică sezonieră' : 'seasonal allergic rhinitis'),
      field('recommended_medication', ro ? 'cetirizină 10 mg, o dată pe zi, în sezon' : 'cetirizine 10 mg, once a day, in season'),
      field('follow_up', ro ? 'peste 3 luni' : 'in 3 months'),
    ],
    measurements: [], owner_edited: [], removed_fields: [], removed_measurements: [],
  });

  const labTitle = (date: string) => (ro ? `Analize de sânge ${date}` : `Blood tests ${date}`);
  const one = lab(lang, labOne, [
    [ro ? 'Hemoglobină' : 'Hemoglobin', 'hemoglobin', '13.8', 'g/dL', 12, 15.5, 'normal'],
    [ro ? 'Glucoză' : 'Glucose', 'glucose', '92', 'mg/dL', 70, 99, 'normal'],
    [ro ? 'Colesterol total' : 'Total cholesterol', 'total cholesterol', '214', 'mg/dL', null, 200, 'high'],
    [ro ? 'Colesterol LDL' : 'LDL cholesterol', 'ldl cholesterol', '138', 'mg/dL', null, 100, 'high'],
    [ro ? 'Vitamina D' : 'Vitamin D', 'vitamin d', '24', 'ng/mL', 30, 100, 'low'],
  ], labTitle(labOne), w, ro ? 'analize-exemplu-1.pdf' : 'sample-blood-tests-1.pdf');
  const two = lab(lang, labTwo, [
    [ro ? 'Hemoglobină' : 'Hemoglobin', 'hemoglobin', '14.1', 'g/dL', 12, 15.5, 'normal'],
    [ro ? 'Glucoză' : 'Glucose', 'glucose', '89', 'mg/dL', 70, 99, 'normal'],
    [ro ? 'Colesterol total' : 'Total cholesterol', 'total cholesterol', '198', 'mg/dL', null, 200, 'normal'],
    [ro ? 'Colesterol LDL' : 'LDL cholesterol', 'ldl cholesterol', '121', 'mg/dL', null, 100, 'high'],
    [ro ? 'Vitamina D' : 'Vitamin D', 'vitamin d', '33', 'ng/mL', 30, 100, 'normal'],
  ], labTitle(labTwo), w, ro ? 'analize-exemplu-2.pdf' : 'sample-blood-tests-2.pdf');

  const rxText = ro
    ? `${w.clinic}\nRețetă\nData: ${labOne}\n\nColecalciferol 2000 UI, o dată pe zi, 90 de zile.\nCetirizină 10 mg, o dată pe zi, la nevoie în sezon.\n${w.family}\n`
    : `${w.clinic}\nPrescription\nDate: ${labOne}\n\nCholecalciferol 2000 IU, once a day, 90 days.\nCetirizine 10 mg, once a day, as needed in season.\n${w.family}\n`;
  const prescription = record(rxText, ro ? 'reteta-exemplu.pdf' : 'sample-prescription.pdf', {
    page_start: 1, page_end: 1, title: ro ? 'Rețetă' : 'Prescription', doc_date: labOne, provider: w.clinic, doc_type: 'prescription',
    ai_summary: ro ? 'Rețetă pentru colecalciferol, 90 de zile, și cetirizină la nevoie.' : 'Prescription for cholecalciferol for 90 days and cetirizine as needed.',
    user_notes: null, language: lang, reviewed: true, tags: ['medication'],
    doctors: [{ name: w.family, specialty: w.famSpec, clinic: w.clinic, license_code: null, role: 'prescriber', person: null, source: 'text', printed_code: null }],
    fields: [
      field('drug', ro ? 'Colecalciferol' : 'Cholecalciferol', 1), field('dose', '2000 ' + (ro ? 'UI' : 'IU'), 1), field('frequency', ro ? 'o dată pe zi' : 'once a day', 1), field('duration', ro ? '90 de zile' : '90 days', 1),
      field('drug', ro ? 'Cetirizină' : 'Cetirizine', 2), field('dose', '10 mg', 2), field('frequency', ro ? 'o dată pe zi, la nevoie în sezon' : 'once a day, as needed in season', 2),
    ],
    measurements: [], owner_edited: [], removed_fields: [], removed_measurements: [],
  });

  const imagingText = ro
    ? `${w.clinic}\nRadiografie toracică\nData: ${xray}\n\nConstatări: câmpuri pulmonare fără leziuni focale. Cord de dimensiuni obișnuite.\nConcluzie: examen radiologic fără modificări.\n${w.radio}\n`
    : `${w.clinic}\nChest X-ray\nDate: ${xray}\n\nFindings: lung fields without focal lesions. Heart of usual size.\nImpression: radiological examination without changes.\n${w.radio}\n`;
  const imaging = record(imagingText, ro ? 'radiografie-exemplu.pdf' : 'sample-chest-xray.pdf', {
    page_start: 1, page_end: 1, title: ro ? 'Radiografie toracică' : 'Chest X-ray', doc_date: xray, provider: w.clinic, doc_type: 'imaging',
    ai_summary: ro ? 'Radiografie toracică; raportul scrie că nu există modificări.' : 'Chest X-ray; the report states that there are no changes.',
    user_notes: null, language: lang, reviewed: true, tags: ['imaging'],
    doctors: [{ name: w.radio, specialty: ro ? 'radiologie' : 'radiology', clinic: w.clinic, license_code: null, role: 'author', person: null, source: 'text', printed_code: null }],
    fields: [
      field('modality', ro ? 'radiografie' : 'X-ray'), field('body_part', ro ? 'torace' : 'chest'),
      field('findings', ro ? 'câmpuri pulmonare fără leziuni focale; cord de dimensiuni obișnuite' : 'lung fields without focal lesions; heart of usual size'),
      field('impression', ro ? 'examen radiologic fără modificări' : 'radiological examination without changes'),
    ],
    measurements: [], owner_edited: [], removed_fields: [], removed_measurements: [],
  });

  return [consultation, one, prescription, two, imaging];
}
