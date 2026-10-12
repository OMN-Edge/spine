import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { buildTestApp, loginAs, loginSession } from './helpers/app.js';
import { createTestUser, seedPage, seedSourceFile, OWNER_ID } from './helpers/seed.js';
import { getStore } from '../store/index.js';
import { canonicalName, flagFor, normaliseMeasurements, parseNumber, validDay, validMonth, validWhen } from '../ingestion/measurements.js';
import { doctorDisplayName, doctorKey, normaliseLicenseCode } from '../doctors.js';
import { extractionSchema } from '../llm/types.js';
import { DOC_TYPE_GUIDES, guidesForPrompt } from '../llm/doc-types.js';
import { DOC_TYPES } from '../llm/types.js';
import { rereadDocument } from '../ingestion/document-reading.js';
import { unitKey } from '../units.js';
import { buildContinuationPrompt, buildExtractionPrompt } from '../llm/prompts.js';

const mockExtractFields = vi.hoisted(() => vi.fn());
vi.mock('../ingestion/extraction.js', () => ({ extractFields: mockExtractFields }));

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
beforeAll(async () => { app = await buildTestApp(); cookie = await loginSession(app); });
afterAll(async () => { await app.close(); });
beforeEach(() => { mockExtractFields.mockReset(); });

describe('parseNumber', () => {
  it.each([
    ['13.5', 13.5], ['13,5', 13.5], ['  13,5 ', 13.5], ['0,8', 0.8], ['120', 120], ['-2.5', -2.5], ['+4', 4],
    ['1.234,5', 1234.5], ['1,234.5', 1234.5], ['1.234.567', 1234567], ['1 234', 1234], ['1,234', 1234],
  ])('reads %s as %s', (text, expected) => expect(parseNumber(text)).toBe(expected));

  it.each(['<0.5', '>100', '≤3', 'pozitiv', 'negativ', '', '   ', '12 mg', '1/2', '12-16', 'abc', ',', '.', null, undefined])(
    'does not treat %j as a number',
    text => expect(parseNumber(text as string | null | undefined)).toBeNull(),
  );
});

describe('flagFor', () => {
  it('works it out from the value and the range when it can', () => {
    expect(flagFor(9, 12, 16, null)).toBe('low');
    expect(flagFor(18, 12, 16, null)).toBe('high');
    expect(flagFor(14, 12, 16, null)).toBe('normal');
    expect(flagFor(12, 12, 16, 'H')).toBe('normal'); // on the edge is in range; arithmetic beats a printed mark
    expect(flagFor(5, null, 10, null)).toBe('normal');
    expect(flagFor(15, null, 10, null)).toBe('high');
    expect(flagFor(1, 3, null, null)).toBe('low');
  });
  it('falls back to what the document printed when there is no range to check against', () => {
    expect(flagFor(null, null, null, 'H')).toBe('high');
    expect(flagFor(14, null, null, 'low')).toBe('low');
    expect(flagFor(null, null, null, '↓')).toBe('low');
    expect(flagFor(null, null, null, 'în limite')).toBe('normal');
    expect(flagFor(null, null, null, 'banana')).toBeNull();
    expect(flagFor(14, null, null, null)).toBeNull();
  });
});

describe('normalising what a model read off a lab sheet', () => {
  const m = (over: object) => ({ name: 'Hemoglobina', canonical: 'Hemoglobin ', value: '13,5', unit: 'g/dL', ref_low: '12', ref_high: '16', flag: null, date: null, source_snippet: 'x', page_number: 1, confidence: 0.9, ...over });

  it('turns text into numbers and a flag, and takes the document date', () => {
    const [row] = normaliseMeasurements([m({})], '2026-03-04');
    expect(row).toMatchObject({ name: 'Hemoglobina', canonical: 'hemoglobin', value_text: '13,5', value_num: 13.5, unit: 'g/dL', ref_low: 12, ref_high: 16, flag: 'normal', taken_on: '2026-03-04' });
  });
  it('uses a row’s own date when it is a real one, and the document’s otherwise', () => {
    expect(normaliseMeasurements([m({ date: '2026-01-02' })], '2026-03-04')[0].taken_on).toBe('2026-01-02');
    expect(normaliseMeasurements([m({ date: '2026-13-45' })], '2026-03-04')[0].taken_on).toBe('2026-03-04');
    expect(normaliseMeasurements([m({ date: 'yesterday' })], null)[0].taken_on).toBeNull();
  });
  it('keeps a value that is not a number as text, without a chart value', () => {
    const [row] = normaliseMeasurements([m({ value: '<0,5', ref_low: null, ref_high: null, flag: 'normal' })], null);
    expect(row.value_text).toBe('<0,5');
    expect(row.value_num).toBeNull();
    expect(row.flag).toBe('normal');
  });
  it('drops a row with no name or no value, and ranges that are not numbers become none', () => {
    const rows = normaliseMeasurements([m({ name: '  ' }), m({ value: '' }), m({ ref_low: 'n/a', ref_high: 'see below' })], null);
    expect(rows).toHaveLength(1);
    expect([rows[0].ref_low, rows[0].ref_high]).toEqual([null, null]);
  });
  it('names a test by its printed name when the model gave no canonical one', () => {
    expect(canonicalName('', 'Glucoza  Serica')).toBe('glucoza serica');
    expect(canonicalName(null, 'LDL')).toBe('ldl');
    expect(canonicalName(' LDL  Cholesterol ', 'LDL')).toBe('ldl cholesterol');
  });
  it('checks a day is a real one', () => {
    expect(validDay('2026-02-28')).toBe('2026-02-28');
    for (const bad of ['2026-02-30x', '2026-13-01', 'x', '', null, undefined]) expect(validDay(bad as string | null)).toBeNull();
  });
});

describe('who a doctor is', () => {
  it.each([
    ['Dr. Popescu Ion', 'Ion Popescu'], ['POPESCU ION', 'popescu  ion'], ['Prof. Dr. Ion Popescu', 'Popescu Ion'],
    ['Conf. dr. Ștefănescu Ană', 'Stefanescu Ana'], ['DUMITRESCU Ioana Maria', 'Dr.DUMITRESCU IOANA-MARIA'], ['Dr Țurcanu Mihai', 'Mihai Turcanu'], ['Dr. Popescu-Ionescu Maria', 'Maria Popescu-Ionescu'],
  ])('%s and %s are one doctor', (a, b) => expect(doctorKey(a)).toBe(doctorKey(b)));

  it('keeps different people apart, including a bare initial, which a person has to merge', () => {
    expect(doctorKey('Dr. Popescu Ion')).not.toBe(doctorKey('Dr. Popescu Maria'));
    expect(doctorKey('Popescu I.')).not.toBe(doctorKey('Popescu Ion'));
    expect(doctorKey('Dr.')).toBe('');
  });

  it('shows a name as printed, without leading titles or stray punctuation', () => {
    expect(doctorDisplayName('Dr. Popescu Ion')).toBe('Popescu Ion');
    expect(doctorDisplayName('  Prof. Dr.  Ion   Popescu, ')).toBe('Ion Popescu');
    expect(doctorDisplayName('Dr. Ștefănescu')).toBe('Ștefănescu');
    expect(doctorDisplayName('Dr.')).toBe('Dr.'); // never reduced to nothing
    expect(doctorDisplayName('Dr.DUMITRESCU IOANA-MARIA')).toBe('DUMITRESCU IOANA-MARIA'); // a title with no space after it
    expect(doctorDisplayName('Prof.Dr.Ion Popescu')).toBe('Ion Popescu');
  });
});

describe('when a value was taken', () => {
  it('accepts a day, or a month when that is all a report prints', () => {
    expect(validWhen('2026-03-04')).toBe('2026-03-04');
    expect(validWhen('2026-03')).toBe('2026-03');
    expect(validMonth('2026-03')).toBe('2026-03');
    expect(validDay('2026-03')).toBeNull();
    for (const bad of ['2026-13', '2026-00', '2026-3', '26-03', '03.2026', '2026', '', null, undefined]) expect(validWhen(bad as string | null), String(bad)).toBeNull();
  });
  const m = (date: string | null) => ({ name: 'TSH', canonical: 'tsh', value: '3.10', unit: 'uU/ml', ref_low: null, ref_high: null, flag: null, date, source_snippet: 'x', page_number: 1, confidence: 1 });
  it('keeps a month as the month, rather than moving the value to the day of the visit', () => {
    expect(normaliseMeasurements([m('2026-03')], '2026-06-02')[0].taken_on).toBe('2026-03');
    expect(normaliseMeasurements([m('2026-05-12')], '2026-06-02')[0].taken_on).toBe('2026-05-12');
    expect(normaliseMeasurements([m(null)], '2026-06-02')[0].taken_on).toBe('2026-06-02');
    expect(normaliseMeasurements([m('2026-13')], '2026-06-02')[0].taken_on).toBe('2026-06-02');
  });
});

describe('units written different ways', () => {
  it.each([
    ['mUI/mL', 'mIU/mL'], ['µg/dL', 'ug/dL'], ['μg/dL', 'ug/dL'], ['uU/ml', 'µIU/mL'], ['UI/L', 'IU/L'], [' mg / dL ', 'MG/DL'], ['uUI/mL', 'uIU/mL'],
  ])('%s and %s are one unit', (a, b) => expect(unitKey(a)).toBe(unitKey(b)));
  it.each([['g/dL', 'g/L'], ['mg/dL', 'mmol/L'], ['ng/mL', 'pg/mL'], ['mUI/mL', 'UI/mL'], ['mmol/L', 'umol/L']])('%s and %s are not', (a, b) => expect(unitKey(a)).not.toBe(unitKey(b)));
  it('has no key for no unit', () => { for (const none of [null, undefined, '', '  ']) expect(unitKey(none)).toBeNull(); });
});

describe('what the model is told', () => {
  const extraction = buildExtractionPrompt('--- page 1 ---\ntext');
  it('takes the reference range for this patient, bounds with a comparator, and the referrer’s label', () => {
    expect(extraction).toMatch(/other groups \(by sex, age, pregnancy, Tanner stage\) are not the reference range/);
    expect(extraction).toMatch(/"<0.5" or "≤ 5.8" is ref_high alone/);
    expect(extraction).toMatch(/"Trimitor"/);
    expect(extraction).toMatch(/phone number/);
  });
  it('dates a lab report by when the sample was collected', () => {
    expect(extraction).toMatch(/when the sample was collected \("data recoltarii"\)/);
  });
  it('tells a new document from a continuation by its page numbers', () => {
    const prompt = buildContinuationPrompt('Pg. 3 / 3', 'Pg. 1 / 1', 10000);
    expect(prompt).toMatch(/numbered 1 of N/);
    expect(prompt).toMatch(/follows page 1 of 3/);
  });
});

describe('a doctor’s professional code', () => {
  it.each([['X12345', 'X12345'], ['Cod. X-12345', 'X12345'], ['Cod parafa: X12345', 'X12345'], ['CODE1234', 'CODE1234'], ['x 12345', 'X12345'], ['  X12345  ', 'X12345']])('reads %j as %j', (raw, expected) => {
    expect(normaliseLicenseCode(raw)).toBe(expected);
  });
  it.each(['', '  ', '123', 'a-b', '--', null, undefined])('is not a code: %j', raw => {
    expect(normaliseLicenseCode(raw as string | null | undefined)).toBeNull();
  });
});

describe('the extraction schema', () => {
  const base = { title: 't', doc_date: null, provider: null, doc_type: 'lab_result', ai_summary: 's', suggested_tags: [], fields: [] };

  it('treats a missing list as none, so a document without doctors or measurements is still read', () => {
    const parsed = extractionSchema.parse(base);
    expect(parsed.doctors).toEqual([]);
    expect(parsed.measurements).toEqual([]);
  });
  it('accepts a field with no group, with a group, or with a null one', () => {
    for (const group of [undefined, null, 2]) {
      expect(extractionSchema.parse({ ...base, fields: [{ label: 'drug', value: 'x', group, source_snippet: 'x', page_number: 1, confidence: 1 }] }).fields).toHaveLength(1);
    }
  });
  it('accepts a doctor with a code, a null code, or none', () => {
    for (const code of ['X12345', null, undefined]) {
      expect(extractionSchema.parse({ ...base, doctors: [{ name: 'a', specialty: null, code, role: 'author' }] }).doctors).toHaveLength(1);
    }
  });
  it('refuses a doctor role that is not one of the four, and a group that is not a positive whole number', () => {
    expect(extractionSchema.safeParse({ ...base, doctors: [{ name: 'a', specialty: null, role: 'boss' }] }).success).toBe(false);
    expect(extractionSchema.safeParse({ ...base, fields: [{ label: 'a', value: 'b', group: 0, source_snippet: '', page_number: 1, confidence: 1 }] }).success).toBe(false);
  });
  it('takes numbers as text, so "12" where 12 was expected is not a failure', () => {
    const m = { name: 'n', canonical: 'n', value: '1', unit: null, ref_low: '12', ref_high: '16', flag: 'H', date: null, source_snippet: '', page_number: 1, confidence: 1 };
    expect(extractionSchema.safeParse({ ...base, measurements: [m] }).success).toBe(true);
  });
});

describe('what each type of document is asked for', () => {
  it('has a guide for every type the app knows, and the prompt carries them all', () => {
    expect(Object.keys(DOC_TYPE_GUIDES).sort()).toEqual([...DOC_TYPES].sort());
    const prompt = guidesForPrompt();
    for (const type of DOC_TYPES) expect(prompt).toContain(`- ${type} (`);
  });
  it('asks a consultation for what a clinic’s report holds, and for dated labs quoted in its text', () => {
    const c = DOC_TYPE_GUIDES.consultation_note;
    expect(c.fields).toEqual(expect.arrayContaining(['service', 'symptoms', 'examination', 'family_history', 'personal_history', 'habits', 'current_treatment', 'investigations', 'diagnosis_code', 'diagnosis_uncoded', 'recommended_tests', 'lifestyle_advice', 'report_number']));
    expect(c.grouped).toContain('duration');
    expect(c.about).toMatch(/several services/);
    expect(c.measurements).toMatch(/BMI/);
    expect(c.measurements).toMatch(/date it was taken/);
    expect(c.doctors).toMatch(/Recomandat de/);
    expect(DOC_TYPE_GUIDES.discharge_note.measurements).toMatch(/date it was taken/);
    for (const t of ['discharge_note', 'other'] as const) expect(DOC_TYPE_GUIDES[t].fields).toContain('diagnosis_code');
  });
  it('asks labs for measurements and prescriptions for repeating groups', () => {
    expect(DOC_TYPE_GUIDES.lab_result.measurements).toMatch(/EVERY analyte/);
    expect(DOC_TYPE_GUIDES.prescription.grouped).toEqual(expect.arrayContaining(['drug', 'dose', 'frequency']));
    expect(DOC_TYPE_GUIDES.consultation_note.measurements).toMatch(/blood pressure/);
  });
});

// ---------------------------------------------------------------------------------------------------

/** A one-page upload with a document on it, ready to be read. */
async function upload(userId = OWNER_ID, docDate: string | null = '2026-03-04', text = 'Hemoglobina 13,5 g/dL') {
  const store = getStore();
  const sf = await seedSourceFile({ userId, status: 'done' });
  const pageId = await seedPage(sf, { userId, pageNumber: 1, rawText: text });
  const docId = uuidv4();
  await store.documents.create(userId, { id: docId, sourceFileId: sf, pageStart: 1, pageEnd: 1, title: 'Lab', docDate, provider: 'Synevo' });
  return { sf, pageId, docId };
}

const reading = (over: object = {}) => ({
  title: 'Buletin', doc_date: '2026-03-04', provider: 'Synevo', doc_type: 'lab_result' as const, ai_summary: 's', suggested_tags: ['lab'],
  doctors: [{ name: 'Dr. Popescu Ion', specialty: 'cardiology', role: 'referrer' as const }],
  fields: [{ label: 'lab', value: 'Synevo', group: null, source_snippet: 'Synevo', page_number: 1, confidence: 0.9 }],
  measurements: [
    { name: 'Hemoglobina', canonical: 'hemoglobin', value: '13,5', unit: 'g/dL', ref_low: '12', ref_high: '16', flag: null, date: null, source_snippet: 'Hemoglobina 13,5', page_number: 1, confidence: 0.95 },
    { name: 'Glucoza', canonical: 'glucose', value: '121', unit: 'mg/dL', ref_low: '70', ref_high: '100', flag: null, date: null, source_snippet: 'Glucoza', page_number: 1, confidence: 0.9 },
  ],
  ...over,
});

describe('storing a reading', () => {
  it('writes the measurements, normalised, and the doctors, once each, into the directory', async () => {
    const { docId } = await upload();
    mockExtractFields.mockResolvedValue(reading());
    expect(await rereadDocument(OWNER_ID, docId)).toBe(true);

    const store = getStore();
    const rows = await store.measurements.listForDocument(OWNER_ID, docId);
    expect(rows.map(r => [r.canonical, r.value_num, r.unit, r.ref_low, r.ref_high, r.flag, r.taken_on]))
      .toEqual([['hemoglobin', 13.5, 'g/dL', 12, 16, 'normal', '2026-03-04'], ['glucose', 121, 'mg/dL', 70, 100, 'high', '2026-03-04']]);
    expect(rows[0].source_snippet).toBe('Hemoglobina 13,5');

    const doctors = await store.doctors.forDocument(OWNER_ID, docId);
    expect(doctors.map(d => [d.name, d.specialty, d.clinic, d.role])).toEqual([['Popescu Ion', 'cardiology', 'Synevo', 'referrer']]);
  });

  it('puts the same doctor, spelled differently on another document, in the directory once', async () => {
    const a = await upload(); const b = await upload();
    mockExtractFields
      .mockResolvedValueOnce(reading({ doctors: [{ name: 'Dr. Zamfir Dan', specialty: 'cardiology', role: 'referrer' }] }))
      .mockResolvedValueOnce(reading({ doctors: [{ name: 'Dan ZAMFIR', specialty: null, role: 'author' }] }));
    await rereadDocument(OWNER_ID, a.docId); await rereadDocument(OWNER_ID, b.docId);

    const list = (await getStore().doctors.listFor(OWNER_ID)).filter(d => d.name.toLowerCase().includes('zamfir'));
    expect(list).toHaveLength(1);
    expect(list[0].document_count).toBe(2);
  });

  it('fills in a specialty the first document did not have, and never overwrites one', async () => {
    const a = await upload(); const b = await upload(); const c = await upload();
    mockExtractFields
      .mockResolvedValueOnce(reading({ doctors: [{ name: 'Dr. Ionescu Vlad', specialty: null, role: 'author' }] }))
      .mockResolvedValueOnce(reading({ doctors: [{ name: 'Ionescu Vlad', specialty: 'neurology', role: 'author' }] }))
      .mockResolvedValueOnce(reading({ doctors: [{ name: 'Vlad Ionescu', specialty: 'oncology', role: 'author' }] }));
    for (const d of [a, b, c]) await rereadDocument(OWNER_ID, d.docId);
    const doctor = (await getStore().doctors.listFor(OWNER_ID)).find(d => d.name === 'Ionescu Vlad')!;
    expect(doctor.specialty).toBe('neurology');
  });

  it('stores fields that belong together under one group number', async () => {
    const { docId } = await upload();
    mockExtractFields.mockResolvedValue(reading({
      doc_type: 'prescription', measurements: [],
      fields: [
        { label: 'drug', value: 'Diclofenac', group: 1, source_snippet: 'Hemoglobina', page_number: 1, confidence: 1 },
        { label: 'dose', value: '50 mg', group: 1, source_snippet: '50', page_number: 1, confidence: 1 },
        { label: 'drug', value: 'Omeprazol', group: 2, source_snippet: 'x', page_number: 1, confidence: 1 },
        { label: 'diagnosis', value: 'lombalgie', group: null, source_snippet: 'x', page_number: 1, confidence: 1 },
      ],
    }));
    await rereadDocument(OWNER_ID, docId);
    const fields = await getStore().fields.listForDocument(OWNER_ID, docId);
    expect(fields.map(f => [f.label, f.group_no])).toEqual([['drug', 1], ['dose', 1], ['drug', 2], ['diagnosis', null]]);
  });

  it('replaces the measurements and doctor links on a second reading, and leaves the directory alone', async () => {
    const { docId } = await upload();
    mockExtractFields.mockResolvedValueOnce(reading({ doctors: [{ name: 'Dr. Lupu Radu', specialty: null, role: 'referrer' }] }));
    await rereadDocument(OWNER_ID, docId);
    mockExtractFields.mockResolvedValueOnce(reading({ measurements: [reading().measurements[0]], doctors: [{ name: 'Dr. Marin Ana', specialty: null, role: 'author' }] }));
    await rereadDocument(OWNER_ID, docId);

    const store = getStore();
    expect((await store.measurements.listForDocument(OWNER_ID, docId)).map(m => m.canonical)).toEqual(['hemoglobin']);
    expect((await store.doctors.forDocument(OWNER_ID, docId)).map(d => d.name)).toEqual(['Marin Ana']);
    // The first doctor is still in the directory, now with no documents.
    expect((await store.doctors.listFor(OWNER_ID)).find(d => d.name === 'Lupu Radu')!.document_count).toBe(0);
  });

  it('copes with a reading that has neither measurements nor doctors', async () => {
    const { docId } = await upload();
    mockExtractFields.mockResolvedValue(reading({ doctors: [], measurements: [] }));
    expect(await rereadDocument(OWNER_ID, docId)).toBe(true);
    expect(await getStore().measurements.listForDocument(OWNER_ID, docId)).toEqual([]);
  });
});

describe('doctors with a professional code', () => {
  const read = (name: string, code: string | null, specialty: string | null = null) => reading({ doctors: [{ name, specialty, code, role: 'author' as const }] });
  const tag = () => uuidv4().slice(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, 'X');

  it('stores the code, and finds the same person again by it under a different spelling', async () => {
    const a = await upload(); const b = await upload(); const code = `H${tag()}`;
    mockExtractFields.mockResolvedValueOnce(read('Dr. Aaa Bbb', code)).mockResolvedValueOnce(read('Completely Different Spelling', `Cod. ${code.toLowerCase()}`));
    await rereadDocument(OWNER_ID, a.docId); await rereadDocument(OWNER_ID, b.docId);

    const store = getStore();
    const first = (await store.doctors.forDocument(OWNER_ID, a.docId))[0];
    const second = (await store.doctors.forDocument(OWNER_ID, b.docId))[0];
    expect(second.id).toBe(first.id);
    expect(first.license_code).toBe(code);
    expect((await store.doctors.listFor(OWNER_ID)).find(d => d.id === first.id)!.document_count).toBe(2);
  });

  it('gives a doctor a code later, and never replaces one they have', async () => {
    const a = await upload(); const b = await upload(); const c = await upload(); const t = tag();
    mockExtractFields
      .mockResolvedValueOnce(read(`Dr. Nocode ${t}`, null))
      .mockResolvedValueOnce(read(`Nocode ${t}`, `K${t}`))
      .mockResolvedValueOnce(read(`Nocode ${t}`, `Z${t}`)); // a different code on a name match: left alone
    for (const d of [a, b, c]) await rereadDocument(OWNER_ID, d.docId);
    const doctor = (await getStore().doctors.forDocument(OWNER_ID, c.docId))[0];
    expect(doctor.license_code).toBe(`K${t}`);
  });

  it('is not misled by a code too short to mean anything', async () => {
    const a = await upload(); const b = await upload(); const t = tag();
    mockExtractFields.mockResolvedValueOnce(read(`Dr. Short ${t}`, '12')).mockResolvedValueOnce(read(`Dr. Other ${t}`, '12'));
    await rereadDocument(OWNER_ID, a.docId); await rereadDocument(OWNER_ID, b.docId);
    const [one] = await getStore().doctors.forDocument(OWNER_ID, a.docId); const [two] = await getStore().doctors.forDocument(OWNER_ID, b.docId);
    expect(one.id).not.toBe(two.id);
    expect(one.license_code).toBeNull();
  });

  it('keeps one doctor per code per user, and the same code for two users is two doctors', async () => {
    const other = await createTestUser(`c-${uuidv4()}@spine.test`); const code = `H${tag()}`;
    const store = getStore(); const now = new Date().toISOString();
    const mine = await store.doctors.upsert(OWNER_ID, { name: 'Dr. Same Code', licenseCode: code }, now);
    const theirs = await store.doctors.upsert(other.id, { name: 'Dr. Same Code', licenseCode: code }, now);
    expect(theirs).not.toBe(mine);
    expect((await store.doctors.find(other.id, theirs!))!.license_code).toBe(code);
    expect(await store.doctors.upsert(OWNER_ID, { name: 'A Name Never Seen', licenseCode: code }, now)).toBe(mine);
  });

  it('refuses to give a doctor a code another one has, and says so', async () => {
    const store = getStore(); const now = new Date().toISOString(); const code = `H${tag()}`;
    const a = (await store.doctors.upsert(OWNER_ID, { name: `Dr. Holder ${tag()}`, licenseCode: code }, now))!;
    const b = (await store.doctors.upsert(OWNER_ID, { name: `Dr. Wanter ${tag()}` }, now))!;
    expect(await store.doctors.update(OWNER_ID, b, { licenseCode: code })).toBe('code_taken');
    expect((await store.doctors.find(OWNER_ID, b))!.license_code).toBeNull();
    expect(await store.doctors.update(OWNER_ID, a, { licenseCode: null })).toBe('ok');
    expect(await store.doctors.update(OWNER_ID, b, { licenseCode: code })).toBe('ok');
    expect(await store.doctors.update(OWNER_ID, b, { licenseCode: code })).toBe('ok'); // its own code is not a clash
  });

  it('on a merge, the entry that stays takes the code of the one that goes, if it has none', async () => {
    const store = getStore(); const now = new Date().toISOString(); const code = `H${tag()}`;
    const keep = (await store.doctors.upsert(OWNER_ID, { name: `Keep Me ${tag()}` }, now))!;
    const gone = (await store.doctors.upsert(OWNER_ID, { name: `Go Away ${tag()}`, licenseCode: code }, now))!;
    expect(await store.doctors.merge(OWNER_ID, gone, keep)).toBe(true);
    expect((await store.doctors.find(OWNER_ID, keep))!.license_code).toBe(code);

    const other = (await store.doctors.upsert(OWNER_ID, { name: `Has Own ${tag()}`, licenseCode: `H${tag()}` }, now))!;
    const dupe = (await store.doctors.upsert(OWNER_ID, { name: `Dupe ${tag()}`, licenseCode: `H${tag()}` }, now))!;
    const own = (await store.doctors.find(OWNER_ID, other))!.license_code;
    expect(await store.doctors.merge(OWNER_ID, dupe, other)).toBe(true);
    expect((await store.doctors.find(OWNER_ID, other))!.license_code).toBe(own);
  });
});

describe('measurements when documents are split, joined and cleared', () => {
  async function twoPages() {
    const store = getStore();
    const sf = await seedSourceFile({ status: 'done' });
    const p1 = await seedPage(sf, { pageNumber: 1 }); const p2 = await seedPage(sf, { pageNumber: 2 });
    const doc = uuidv4();
    await store.documents.create(OWNER_ID, { id: doc, sourceFileId: sf, pageStart: 1, pageEnd: 2, title: 'Two pages', docDate: '2026-03-04' });
    const m = (id: string, pageId: string, canonical: string) => store.measurements.create(OWNER_ID, {
      id, documentId: doc, pageId, name: canonical, canonical, valueText: '1', valueNum: 1, unit: null, refLow: null, refHigh: null, flag: null, takenOn: '2026-03-04', sourceSnippet: null, bbox: null, confidence: 1,
    });
    const tag = uuidv4().slice(0, 8);
    await m(`m1-${tag}`, p1, `on-page-1-${tag}`); await m(`m2-${tag}`, p2, `on-page-2-${tag}`);
    const doctor = (await store.doctors.upsert(OWNER_ID, { name: `Dr. Test Doctor ${tag}` }, new Date().toISOString()))!;
    await store.doctors.link(OWNER_ID, doc, doctor, 'author');
    return { sf, doc, doctor, tag };
  }

  it('a split sends each value to the half its page is in, and the new half names the same doctors', async () => {
    const { doc, doctor, tag } = await twoPages();
    mockExtractFields.mockRejectedValue(new Error('down')); // the grouping stands even if reading fails
    const res = await app.inject({ method: 'POST', url: `/api/documents/${doc}/boundary`, payload: { action: 'split', at_page: 2 }, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const [head, tail] = (res.json() as { split_into: [string, string] }).split_into;

    const store = getStore();
    expect((await store.measurements.listForDocument(OWNER_ID, head)).map(m => m.canonical)).toEqual([`on-page-1-${tag}`]);
    expect((await store.measurements.listForDocument(OWNER_ID, tail)).map(m => m.canonical)).toEqual([`on-page-2-${tag}`]);
    for (const d of [head, tail]) expect((await store.doctors.forDocument(OWNER_ID, d)).map(x => x.id)).toEqual([doctor]);
  });

  it('a join keeps every value and doctor, instead of failing on the removed document', async () => {
    const { doc, tag } = await twoPages();
    mockExtractFields.mockRejectedValue(new Error('down'));
    const split = await app.inject({ method: 'POST', url: `/api/documents/${doc}/boundary`, payload: { action: 'split', at_page: 2 }, headers: { cookie } });
    const [head, tail] = (split.json() as { split_into: [string, string] }).split_into;

    const join = await app.inject({ method: 'POST', url: `/api/documents/${head}/boundary`, payload: { action: 'merge', with_document_id: tail }, headers: { cookie } });
    expect(join.statusCode).toBe(200);
    const store = getStore();
    expect((await store.measurements.listForDocument(OWNER_ID, head)).map(m => m.canonical).sort()).toEqual([`on-page-1-${tag}`, `on-page-2-${tag}`]);
    expect(await store.doctors.forDocument(OWNER_ID, tail)).toEqual([]);
    expect(await store.documents.findFor(OWNER_ID, tail)).toBeNull();
  });

  it('clearing an upload’s derived data removes its values and links but not the doctors', async () => {
    const { sf, doctor, tag } = await twoPages();
    expect((await getStore().measurements.names(OWNER_ID)).some(n => n.canonical === `on-page-1-${tag}`)).toBe(true);
    await getStore().sourceFiles.clearDerived(OWNER_ID, sf);
    expect((await getStore().doctors.find(OWNER_ID, doctor))).not.toBeNull();
    expect((await getStore().measurements.names(OWNER_ID)).some(n => n.canonical === `on-page-1-${tag}`)).toBe(false);
  });
});

describe('whose it is', () => {
  it('keeps each user’s values, series and doctors apart', async () => {
    const other = await createTestUser(`s-${uuidv4()}@spine.test`);
    const mine = await upload(); const theirs = await upload(other.id);
    mockExtractFields.mockResolvedValue(reading());
    await rereadDocument(OWNER_ID, mine.docId); await rereadDocument(other.id, theirs.docId);

    const store = getStore();
    const m = await store.measurements.series(OWNER_ID, 'hemoglobin');
    expect(m.map(p => p.document_id).every(id => id === mine.docId || !id.startsWith(theirs.docId))).toBe(true);
    expect((await store.measurements.series(other.id, 'hemoglobin')).every(p => p.document_id === theirs.docId)).toBe(true);
    expect((await store.measurements.listForDocument(OWNER_ID, theirs.docId))).toEqual([]);
    expect((await store.doctors.forDocument(OWNER_ID, theirs.docId))).toEqual([]);
    // Each has their own directory entry for the same person.
    const mineList = (await store.doctors.listFor(OWNER_ID)).map(d => d.id);
    const theirList = (await store.doctors.listFor(other.id)).map(d => d.id);
    expect(mineList.filter(id => theirList.includes(id))).toEqual([]);
  });

  it('refuses to change, remove, link or merge what is another user’s', async () => {
    const other = await createTestUser(`t-${uuidv4()}@spine.test`);
    const mine = await upload(); const theirs = await upload(other.id);
    const store = getStore();
    await store.measurements.create(other.id, { id: 'theirs-m', documentId: theirs.docId, pageId: theirs.pageId, name: 'n', canonical: 'n', valueText: '1', valueNum: 1, unit: null, refLow: null, refHigh: null, flag: null, takenOn: null, sourceSnippet: null, bbox: null, confidence: null });
    const theirDoctor = (await store.doctors.upsert(other.id, { name: 'Dr. Theirs Only' }, new Date().toISOString()))!;
    const myDoctor = (await store.doctors.upsert(OWNER_ID, { name: 'Dr. Mine Only' }, new Date().toISOString()))!;

    const change = { name: 'x', canonical: 'x', valueText: '9', valueNum: 9, unit: null, refLow: null, refHigh: null, flag: null, takenOn: null };
    expect(await store.measurements.update(OWNER_ID, theirs.docId, 'theirs-m', change)).toBe(false);
    expect(await store.measurements.update(OWNER_ID, mine.docId, 'theirs-m', change)).toBe(false);
    expect(await store.measurements.remove(OWNER_ID, theirs.docId, 'theirs-m')).toBe(false);
    expect((await store.measurements.listForDocument(other.id, theirs.docId))).toHaveLength(1);

    await expect(store.measurements.create(OWNER_ID, { id: 'x', documentId: theirs.docId, pageId: theirs.pageId, name: 'n', canonical: 'n', valueText: '1', valueNum: 1, unit: null, refLow: null, refHigh: null, flag: null, takenOn: null, sourceSnippet: null, bbox: null, confidence: null })).rejects.toThrow();

    expect(await store.doctors.link(OWNER_ID, mine.docId, theirDoctor, 'author')).toBe(false);
    expect(await store.doctors.link(OWNER_ID, theirs.docId, myDoctor, 'author')).toBe(false);
    expect(await store.doctors.merge(OWNER_ID, myDoctor, theirDoctor)).toBe(false);
    expect(await store.doctors.merge(OWNER_ID, theirDoctor, myDoctor)).toBe(false);
    expect(await store.doctors.update(OWNER_ID, theirDoctor, { specialty: 'hacked' })).toBe('not_found');
    expect(await store.doctors.remove(OWNER_ID, theirDoctor)).toBe(false);
    expect(await store.doctors.find(OWNER_ID, theirDoctor)).toBeNull();
    expect((await store.doctors.find(other.id, theirDoctor))!.specialty).toBeNull();
  });

  const newMeasurement = (id: string, documentId: string, pageId: string) => ({
    id, documentId, pageId, name: 'n', canonical: 'n', valueText: '1', valueNum: 1, unit: null, refLow: null, refHigh: null,
    flag: null, takenOn: null, sourceSnippet: null, bbox: null, confidence: null,
  });

  it('will not change or remove a value through a document it is not on, even the user’s own', async () => {
    const a = await upload(); const b = await upload();
    const store = getStore();
    const id = `own-${uuidv4()}`;
    await store.measurements.create(OWNER_ID, newMeasurement(id, a.docId, a.pageId));
    expect(await store.measurements.remove(OWNER_ID, b.docId, id)).toBe(false);
    expect(await store.measurements.update(OWNER_ID, b.docId, id, { name: 'x', canonical: 'x', valueText: '9', valueNum: 9, unit: null, refLow: null, refHigh: null, flag: null, takenOn: null })).toBe(false);
    expect(await store.measurements.listForDocument(OWNER_ID, a.docId)).toHaveLength(1);
  });

  it('will not put a value on another user’s page, even from its own document', async () => {
    const other = await createTestUser(`p-${uuidv4()}@spine.test`);
    const mine = await upload(); const theirs = await upload(other.id);
    await expect(getStore().measurements.create(OWNER_ID, newMeasurement(`x-${uuidv4()}`, mine.docId, theirs.pageId))).rejects.toThrow();
    expect(await getStore().measurements.listForDocument(OWNER_ID, mine.docId)).toEqual([]);
  });

  it('gives two users the same doctor’s name two separate directory entries', async () => {
    const other = await createTestUser(`d-${uuidv4()}@spine.test`);
    const store = getStore(); const now = new Date().toISOString();
    const mine = await store.doctors.upsert(OWNER_ID, { name: 'Dr. Shared Name' }, now);
    const theirs = await store.doctors.upsert(other.id, { name: 'Shared Name', specialty: 'theirs' }, now);
    expect(theirs).not.toBe(mine);
    expect((await store.doctors.find(OWNER_ID, mine!))!.specialty).toBeNull(); // not filled in from their entry
  });

  it('leaves no trace when it refuses to link another user’s doctor, so deleting that user still works', async () => {
    const other = await createTestUser(`l-${uuidv4()}@spine.test`);
    const store = getStore();
    const doc = await upload();
    const theirDoctor = (await store.doctors.upsert(other.id, { name: 'Dr. Linked Elsewhere' }, new Date().toISOString()))!;
    expect(await store.doctors.link(OWNER_ID, doc.docId, theirDoctor, 'author')).toBe(false);
    // A stray link row would still point at their doctor and make deleting them fail.
    await expect(store.users.delete(other.id)).resolves.toBeUndefined();
  });

  it('removes a user’s values, doctors and links with them', async () => {
    const other = await createTestUser(`u-${uuidv4()}@spine.test`);
    const theirs = await upload(other.id);
    mockExtractFields.mockResolvedValue(reading());
    await rereadDocument(other.id, theirs.docId);
    await expect(getStore().users.delete(other.id)).resolves.toBeUndefined();
    expect(await getStore().doctors.listFor(other.id)).toEqual([]);
    expect(await getStore().measurements.names(other.id)).toEqual([]);
  });
});

describe('the directory', () => {
  it('lists doctors with how many documents they are on and the newest date', async () => {
    const store = getStore();
    const a = await upload(OWNER_ID, '2025-01-10'); const b = await upload(OWNER_ID, '2026-02-20');
    const id = (await store.doctors.upsert(OWNER_ID, { name: 'Dr. Counted Doctor', specialty: 'cardiology' }, new Date().toISOString()))!;
    await store.doctors.link(OWNER_ID, a.docId, id, 'author'); await store.doctors.link(OWNER_ID, b.docId, id, 'referrer');
    await store.doctors.link(OWNER_ID, b.docId, id, 'author'); // a second role on the same document is still one document
    const entry = (await store.doctors.listFor(OWNER_ID)).find(d => d.id === id)!;
    expect([entry.document_count, entry.last_seen]).toEqual([2, '2026-02-20']);
    expect((await store.doctors.documentsFor(OWNER_ID, id)).map(d => d.doc_date)).toEqual(['2026-02-20', '2026-02-20', '2025-01-10']);
  });

  it('merges two entries for one person, keeping every document and not duplicating a link', async () => {
    const store = getStore(); const now = new Date().toISOString();
    const a = await upload(); const b = await upload();
    const keep = (await store.doctors.upsert(OWNER_ID, { name: 'Popescu Ion Merge' }, now))!;
    const dupe = (await store.doctors.upsert(OWNER_ID, { name: 'Popescu I. Merge' }, now))!;
    expect(dupe).not.toBe(keep);
    await store.doctors.link(OWNER_ID, a.docId, keep, 'author'); await store.doctors.link(OWNER_ID, a.docId, dupe, 'author'); await store.doctors.link(OWNER_ID, b.docId, dupe, 'author');

    expect(await store.doctors.merge(OWNER_ID, dupe, keep)).toBe(true);
    expect(await store.doctors.find(OWNER_ID, dupe)).toBeNull();
    expect((await store.doctors.listFor(OWNER_ID)).find(d => d.id === keep)!.document_count).toBe(2);
    expect(await store.doctors.merge(OWNER_ID, keep, keep)).toBe(false);
  });

  it('renames, refuses a name that is already another doctor, and only removes a doctor no document names', async () => {
    const store = getStore(); const now = new Date().toISOString();
    const a = await store.doctors.upsert(OWNER_ID, { name: 'Alpha Rename' }, now); const b = await store.doctors.upsert(OWNER_ID, { name: 'Beta Rename' }, now);
    expect(await store.doctors.update(OWNER_ID, a!, { name: 'Dr. Beta Rename' })).toBe('name_taken');
    expect(await store.doctors.update(OWNER_ID, a!, { name: 'Gamma Rename', specialty: 'dermatology' })).toBe('ok');
    expect((await store.doctors.find(OWNER_ID, a!))).toMatchObject({ name: 'Gamma Rename', specialty: 'dermatology' });

    const { docId } = await upload();
    await store.doctors.link(OWNER_ID, docId, b!, 'author');
    expect(await store.doctors.remove(OWNER_ID, b!)).toBe(false);
    expect(await store.doctors.remove(OWNER_ID, a!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------

describe('editing measurements and doctors in the review form', () => {
  const patch = (id: string, payload: object, c = cookie) => app.inject({ method: 'PATCH', url: `/api/documents/${id}`, payload, headers: { cookie: c } });
  const load = async (id: string) => (await app.inject({ method: 'GET', url: `/api/documents/${id}`, headers: { cookie } })).json() as {
    measurements: Array<{ id: string; name: string; canonical: string; value_text: string; value_num: number | null; unit: string | null; ref_low: number | null; flag: string | null }>;
    doctors: Array<{ name: string; role: string; specialty: string | null }>;
  };

  async function withValues() {
    const { docId, pageId } = await upload();
    mockExtractFields.mockResolvedValue(reading());
    await rereadDocument(OWNER_ID, docId);
    return { docId, pageId, ...(await load(docId)) };
  }

  it('returns measurements and doctors with the document', async () => {
    const { measurements, doctors } = await withValues();
    expect(measurements.map(m => m.canonical)).toEqual(['hemoglobin', 'glucose']);
    expect(doctors).toEqual([expect.objectContaining({ name: 'Popescu Ion', role: 'referrer' })]);
  });

  it('corrects, removes and adds values in one save, working the number and the flag out again', async () => {
    const { docId, pageId, measurements } = await withValues();
    const [hb, glu] = measurements;
    const res = await patch(docId, { measurements: {
      update: [{ id: hb.id, name: 'Hemoglobina', canonical: 'Hemoglobin', value: '9,8', unit: 'g/dL', ref_low: '12', ref_high: '16' }],
      remove: [glu.id],
      add: [{ name: 'Creatinina', canonical: 'creatinine', value: '0,9', unit: 'mg/dL', ref_low: '0,6', ref_high: '1,2', page_id: pageId }],
    } });
    expect(res.statusCode).toBe(200);

    const after = (await load(docId)).measurements;
    expect(after.map(m => [m.canonical, m.value_num, m.flag])).toEqual([['hemoglobin', 9.8, 'low'], ['creatinine', 0.9, 'normal']]);
  });

  it('accepts a month as a measurement’s date and keeps it as a month, and refuses an impossible one', async () => {
    const { docId, measurements } = await withValues();
    expect((await patch(docId, { measurements: { update: [{ id: measurements[0].id, name: 'Hemoglobina', value: '13', taken_on: '2026-03' }] } })).statusCode).toBe(200);
    const taken = (await app.inject({ method: 'GET', url: `/api/documents/${docId}`, headers: { cookie } })).json() as { measurements: Array<{ id: string; taken_on: string }> };
    expect(taken.measurements.find(m => m.id === measurements[0].id)!.taken_on).toBe('2026-03');
    expect((await patch(docId, { measurements: { update: [{ id: measurements[0].id, name: 'a', value: '1', taken_on: '2026-13' }] } })).statusCode).toBe(400);
  });

  it('replaces the document’s doctors with the list sent, and adds a new one to the directory', async () => {
    const { docId } = await withValues();
    expect((await patch(docId, { doctors: [{ name: 'Dr. Nou Doctor', specialty: 'urology', role: 'author' }, { name: 'Popescu Ion', specialty: null, role: 'referrer' }] })).statusCode).toBe(200);
    expect((await load(docId)).doctors.map(d => [d.name, d.role]).sort()).toEqual([['Nou Doctor', 'author'], ['Popescu Ion', 'referrer']]);
    expect((await patch(docId, { doctors: [] })).statusCode).toBe(200);
    expect((await load(docId)).doctors).toEqual([]);
    expect((await getStore().doctors.listFor(OWNER_ID)).some(d => d.name === 'Nou Doctor')).toBe(true);
  });

  it('is all or nothing: a bad measurement undoes the valid edits beside it', async () => {
    const { docId, measurements } = await withValues();
    const before = await load(docId);
    const res = await patch(docId, { user_notes: 'should not stick', doctors: [{ name: 'X Y', specialty: null, role: 'author' }], measurements: { update: [{ id: measurements[0].id, name: 'a', value: '1' }], remove: ['not-a-measurement'] } });
    expect(res.statusCode).toBe(400);
    expect(await load(docId)).toEqual(before);
  });

  it.each([
    ['an empty name', { update: [{ id: 'ID', name: '', value: '1' }] }],
    ['an empty value', { update: [{ id: 'ID', name: 'a', value: ' ' }] }],
    ['a value that is too long', { update: [{ id: 'ID', name: 'a', value: 'x'.repeat(61) }] }],
    ['a reference range that is not a number', { update: [{ id: 'ID', name: 'a', value: '1', ref_low: 'abc' }] }],
    ['a date that is not a day', { update: [{ id: 'ID', name: 'a', value: '1', taken_on: 'soon' }] }],
    ['the same measurement changed and removed', { update: [{ id: 'ID', name: 'a', value: '1' }], remove: ['ID'] }],
    ['lists that are not lists', { update: 'x' }],
  ])('refuses %s', async (_n, edit) => {
    const { docId, measurements } = await withValues();
    const before = await load(docId);
    const body = JSON.parse(JSON.stringify(edit).replaceAll('ID', measurements[0].id));
    expect((await patch(docId, { measurements: body })).statusCode).toBe(400);
    expect(await load(docId)).toEqual(before);
  });

  it.each([
    ['a role that is not one of the four', [{ name: 'a', specialty: null, role: 'boss' }]],
    ['no name', [{ name: ' ', specialty: null, role: 'author' }]],
    ['too many doctors', Array.from({ length: 21 }, (_, i) => ({ name: `d${i}`, specialty: null, role: 'author' }))],
    ['something that is not a list', 'Dr. X'],
  ])('refuses doctors with %s', async (_n, doctors) => {
    const { docId } = await withValues();
    const before = await load(docId);
    expect((await patch(docId, { doctors })).statusCode).toBe(400);
    expect(await load(docId)).toEqual(before);
  });

  it('will not touch a measurement that is another user’s, through this user’s document or theirs', async () => {
    const other = await createTestUser(`v-${uuidv4()}@spine.test`);
    const theirs = await upload(other.id);
    await getStore().measurements.create(other.id, { id: 'tm', documentId: theirs.docId, pageId: theirs.pageId, name: 'n', canonical: 'n', valueText: '1', valueNum: 1, unit: null, refLow: null, refHigh: null, flag: null, takenOn: null, sourceSnippet: null, bbox: null, confidence: null });
    const { docId, pageId } = await withValues();

    expect((await patch(docId, { measurements: { update: [{ id: 'tm', name: 'x', value: '9' }] } })).statusCode).toBe(400);
    expect((await patch(docId, { measurements: { remove: ['tm'] } })).statusCode).toBe(400);
    expect((await patch(docId, { measurements: { add: [{ name: 'x', value: '1', page_id: theirs.pageId }] } })).statusCode).toBe(400);
    expect((await patch(theirs.docId, { measurements: { remove: ['tm'] } })).statusCode).toBe(404);
    expect((await getStore().measurements.listForDocument(other.id, theirs.docId))[0].value_text).toBe('1');
    void pageId;

    const intruder = await loginAs(app, other.email);
    expect((await patch(docId, { doctors: [] }, intruder)).statusCode).toBe(404);
  });
});
