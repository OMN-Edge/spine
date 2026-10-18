import { v4 as uuidv4 } from 'uuid';
import { getStore } from '../../store/index.js';
import { OWNER_ID, seedDocument } from '../../__tests__/helpers/seed.js';

/**
 * An archive written straight into the store, for the flows that are about the assistant and not about reading a PDF: quick to set up
 * and exact about what it holds. Invented people, clinics and values. The documents are shown (their upload is confirmed), as an
 * archive in use is.
 */
export interface Seeded { id: string; pageId: string; sourceFileId: string }

export async function addResult(documentId: string, pageId: string, r: { name: string; canonical: string; value: string; unit: string; low?: number; high?: number; on: string; flag?: 'high' | 'low' | null }) {
  await getStore().measurements.create(OWNER_ID, {
    id: uuidv4(), documentId, pageId, name: r.name, canonical: r.canonical, valueText: r.value, valueNum: Number(r.value), unit: r.unit,
    refLow: r.low ?? null, refHigh: r.high ?? null, flag: r.flag ?? null, takenOn: r.on, sourceSnippet: null, bbox: null, confidence: 1,
  });
}

async function document(d: {
  title: string; type: 'lab_result' | 'consultation_note' | 'discharge_note' | 'prescription'; date: string; provider: string; summary: string; notes?: string; tags?: string[];
}): Promise<Seeded> {
  const made = await seedDocument({ docType: d.type, docDate: d.date, provider: d.provider, aiSummary: d.summary, tags: d.tags });
  await getStore().documents.update(OWNER_ID, made.id, { title: d.title, user_notes: d.notes ?? null });
  return { id: made.id, pageId: made.pageId!, sourceFileId: made.sourceFileId };
}

/** A year of one person's records: two cardiology visits, the tests the second asked for, an old lab, a discharge note. */
export async function seedYear() {
  const store = getStore();
  const visitOld = await document({
    title: 'Cardiology visit, October 2025', type: 'consultation_note', date: '2025-10-14', provider: 'Clinica Exemplu', tags: ['cardiology'],
    summary: 'Cardiology consultation for chest pain on exertion. Mixed dyslipidaemia suspected. Advised diet and exercise.',
  });
  const labOld = await document({
    title: 'Blood tests, October 2025', type: 'lab_result', date: '2025-10-20', provider: 'Laborator Exemplu', tags: ['lab'],
    summary: 'Blood count and lipids. Hemoglobin 12.4 g/dL, total cholesterol 6.3 mmol/L (high).',
  });
  await addResult(labOld.id, labOld.pageId, { name: 'Hemoglobin', canonical: 'hemoglobin', value: '12.4', unit: 'g/dL', low: 12, high: 16, on: '2025-10-20' });
  await addResult(labOld.id, labOld.pageId, { name: 'Total cholesterol', canonical: 'total cholesterol', value: '6.3', unit: 'mmol/L', high: 5.2, on: '2025-10-20', flag: 'high' });

  const visitNew = await document({
    title: 'Cardiology follow-up, March 2026', type: 'consultation_note', date: '2026-03-02', provider: 'Clinica Exemplu', tags: ['cardiology'], notes: 'Ask about the statin dose.',
    summary: 'Cardiology follow-up. Recommended repeat blood count and a full lipid profile before the next visit in three weeks.',
  });
  const labNew = await document({
    title: 'Blood tests, March 2026', type: 'lab_result', date: '2026-03-12', provider: 'Laborator Exemplu', tags: ['lab'],
    summary: 'Blood count and lipids, requested by the cardiology follow-up. Hemoglobin 13.5 g/dL, total cholesterol 5.9 mmol/L, LDL 3.8 mmol/L.',
  });
  await addResult(labNew.id, labNew.pageId, { name: 'Hemoglobin', canonical: 'hemoglobin', value: '13.5', unit: 'g/dL', low: 12, high: 16, on: '2026-03-12' });
  await addResult(labNew.id, labNew.pageId, { name: 'Total cholesterol', canonical: 'total cholesterol', value: '5.9', unit: 'mmol/L', high: 5.2, on: '2026-03-12', flag: 'high' });
  await addResult(labNew.id, labNew.pageId, { name: 'LDL cholesterol', canonical: 'ldl cholesterol', value: '3.8', unit: 'mmol/L', high: 3, on: '2026-03-12', flag: 'high' });

  const discharge = await document({
    title: 'Hospital discharge, April 2026', type: 'discharge_note', date: '2026-04-06', provider: 'Spital Exemplu', tags: ['hospital'],
    summary: 'Admission 2 to 6 April 2026 for community-acquired pneumonia. Recovered on intravenous antibiotics. Rest for seven days.',
  });
  // The care chain: the follow-up asked for the tests.
  await store.links.add(OWNER_ID, { from_document_id: visitNew.id, to_document_id: labNew.id, kind: 'requests', source: 'owner', state: 'confirmed', reason: null }, '2026-03-13T00:00:00Z');
  await store.links.add(OWNER_ID, { from_document_id: visitOld.id, to_document_id: visitNew.id, kind: 'follow_up', source: 'owner', state: 'confirmed', reason: null }, '2026-03-13T00:00:00Z');

  const popescu = await store.doctors.upsert(OWNER_ID, { name: 'Popescu Ion', specialty: 'cardiology', clinic: 'Clinica Exemplu', licenseCode: 'A12345' }, '2025-10-14T00:00:00Z');
  await store.doctors.link(OWNER_ID, visitOld.id, popescu!, 'author');
  await store.doctors.link(OWNER_ID, visitNew.id, popescu!, 'author');
  return { visitOld, labOld, visitNew, labNew, discharge, popescu: popescu! };
}
