import { expect, it } from 'vitest';
import { describeLive } from './support/live.js';
import { CONSULTATION, DISCHARGE, FACTS, LAB_REPORT } from './support/fixtures.js';
import { OWNER_ID } from './support/world.js';
import { getChatLlm } from '../llm/index.js';
import { getStore } from '../store/index.js';
import { buildTestApp } from '../__tests__/helpers/app.js';
import { seedDocument } from '../__tests__/helpers/seed.js';
import { findLinks } from '../linking/index.js';
import { translateDocument } from '../translation.js';

/**
 * The calls the pipeline makes to the model, one at a time with the real model: is this page the next of that document, what is in this
 * document, which documents are linked, what does it say in another language. Asserted: the facts in the text come back right, and the
 * shape holds (the app validates it). Each is the smallest honest test of its prompt.
 */
const text = (pages: string[][]) => pages.map(p => p.join('\n')).join('\n\n');

describeLive('the model calls the pipeline makes', () => {
  it('says the second page of a numbered report continues the first, and a discharge note does not continue a lab report', async () => {
    const llm = getChatLlm();
    const same = await llm.detectContinuation(LAB_REPORT[0].join('\n'), LAB_REPORT[1].join('\n'));
    expect(same.is_continuation).toBe(true);
    const different = await llm.detectContinuation(LAB_REPORT[1].join('\n'), DISCHARGE[0].join('\n'));
    expect(different.is_continuation).toBe(false);
  });

  it('extracts a laboratory report: type, date, provider, doctors, and each result with its unit and range', async () => {
    const result = await getChatLlm().extractFields(text(LAB_REPORT), ['hemoglobin'], ['lab', 'cardiology']);
    expect(result.doc_type).toBe('lab_result');
    expect(result.doc_date).toBe(FACTS.lab.date);
    expect(result.provider ?? '').toMatch(FACTS.lab.provider);
    const hb = result.measurements.find(m => /hemoglobin/i.test(m.canonical ?? m.name));
    expect(hb).toBeTruthy();
    expect(String(hb!.value)).toMatch(/^13[.,]5/);
    expect(hb!.unit ?? '').toMatch(FACTS.lab.hemoglobinUnit);
    // The range comes back as printed ("12.0"); the pipeline turns it into a number when it stores it.
    expect(Number(hb!.ref_low)).toBe(12);
    expect(Number(hb!.ref_high)).toBe(16);
    // A known test is named as the archive names it, not in a second way.
    expect(hb!.canonical).toBe('hemoglobin');
    expect(result.measurements.some(m => /ldl/i.test(m.name))).toBe(true);
    expect(result.doctors.map(d => d.name).join(' ')).toMatch(/popescu|marinescu/i);
    // The code printed with a signature is read as the code.
    expect(result.doctors.find(d => /marinescu/i.test(d.name))?.code ?? '').toMatch(/M45821/);
  });

  it('extracts a consultation and a discharge note as what they are, with their own dates', async () => {
    const consult = await getChatLlm().extractFields(text(CONSULTATION));
    expect(consult.doc_type).toBe('consultation_note');
    expect(consult.doc_date).toBe(FACTS.consultation.date);
    const discharge = await getChatLlm().extractFields(text(DISCHARGE));
    expect(discharge.doc_type).toBe('discharge_note');
    expect(JSON.stringify(discharge)).toMatch(FACTS.discharge.diagnosis);
    expect(discharge.provider ?? '').toMatch(FACTS.discharge.provider);
  });

  it('finds that a consultation asked for the tests a report answers, in the right direction', async () => {
    await buildTestApp();
    const store = getStore();
    const consult = await seedDocument({ docType: 'consultation_note', docDate: '2026-02-20', provider: 'Clinica Exemplu', aiSummary: 'Cardiology consultation. Recommended full blood count and a complete lipid profile (total cholesterol, LDL, HDL), control in three weeks.' });
    const lab = await seedDocument({ docType: 'lab_result', docDate: '2026-03-12', provider: 'Laborator Exemplu', aiSummary: 'Blood count and lipid profile: hemoglobin 13.5, total cholesterol 5.9, LDL 3.8.' });
    await seedDocument({ docType: 'discharge_note', docDate: '2025-01-05', provider: 'Spital Exemplu', aiSummary: 'Admission for a fractured wrist, surgery and discharge.' });
    // The same doctor on both: with nothing in common the app has no candidate, and by design asks the model nothing.
    const doctor = await store.doctors.upsert(OWNER_ID, { name: 'Popescu Ion' }, '2026-02-20T00:00:00Z');
    await store.doctors.link(OWNER_ID, consult.id, doctor!, 'author');
    await store.doctors.link(OWNER_ID, lab.id, doctor!, 'referrer');
    await findLinks(OWNER_ID, consult.id);
    const links = await store.links.forDocument(OWNER_ID, consult.id);
    const found = links.find(l => l.from_document_id === consult.id && l.to_document_id === lab.id);
    expect(found, JSON.stringify(links)).toBeTruthy();
    expect(found!.kind).toBe('requests');
    // A link is a proposal until the owner confirms it.
    expect(found!.state).toBe('proposed');
  });

  it('translates a document’s details into another language and keeps the numbers', async () => {
    await buildTestApp();
    const doc = await seedDocument({ docType: 'lab_result', docDate: '2026-03-12', provider: 'Laborator Exemplu', aiSummary: 'Blood count and lipids. Hemoglobin 13.5 g/dL, total cholesterol 5.9 mmol/L (high).' });
    await getStore().documents.update(OWNER_ID, doc.id, { title: 'Blood tests, March 2026', user_notes: 'Ask about the dose.', language: 'en' });
    const result = await translateDocument(OWNER_ID, doc.id, 'ro');
    expect(result).not.toBeNull();
    expect(result).not.toBe('not_found');
    const done = result as Exclude<typeof result, null | 'not_found'>;
    expect(['translated', 'cached']).toContain(done.status);
    expect(done.title ?? '').not.toBe('Blood tests, March 2026');
    expect(done.ai_summary ?? '').toMatch(/13[.,]5/);
    expect(done.ai_summary ?? '').toMatch(/5[.,]9/);
  });
});
