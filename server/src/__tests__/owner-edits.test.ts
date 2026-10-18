import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { buildTestApp, loginSession } from './helpers/app.js';
import { OWNER_ID, seedDocument, seedPage, seedSourceFile } from './helpers/seed.js';
import { getStore } from '../store/index.js';
import { resetChatLlm, type ChatLlm } from '../llm/index.js';
import { rereadDocument } from '../ingestion/document-reading.js';
import type { ExtractionResult } from '../types.js';

/**
 * What the owner sets, adds, changes or removes stays through a new reading: the new reading fills in the rest. The model
 * is a stand-in that answers with whatever the test sets up.
 */
let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
let reading: ExtractionResult;
const field = (label: string, value: string, group: number | null = null) => ({ label, value, group, source_snippet: value, page_number: 1, confidence: 1 });
const result = (name: string, canonical: string, value: string, date: string | null = '2026-04-06') =>
  ({ name, canonical, value, unit: 'g/dL', ref_low: null, ref_high: null, flag: null, date, source_snippet: value, page_number: 1, confidence: 1 });
const fakeLlm = { extractFields: async () => reading } as unknown as ChatLlm;

beforeAll(async () => { app = await buildTestApp(); cookie = await loginSession(app); });
afterAll(async () => { await app.close(); });
beforeEach(() => {
  resetChatLlm(fakeLlm);
  reading = { language: 'ro', title: 'Model title', doc_date: '2026-04-06', provider: 'Model clinic', doc_type: 'lab_result', ai_summary: 'Model summary', suggested_tags: [], doctors: [], fields: [], measurements: [] };
});
afterEach(() => resetChatLlm());

const patch = (id: string, payload: unknown) => app.inject({ method: 'PATCH', url: `/api/documents/${id}`, payload: payload as object, headers: { cookie } });

async function readDoc() {
  const sf = await seedSourceFile({ status: 'done' });
  const pageId = await seedPage(sf, { pageNumber: 1, rawText: 'Buletin de analize' });
  const d = await seedDocument({ sourceFileId: sf, withPage: false, provider: null });
  return { id: d.id, pageId };
}
const fieldsOf = async (id: string) => (await getStore().fields.listForDocument(OWNER_ID, id)).map(f => `${f.label}=${f.value}`).sort();
const resultsOf = async (id: string) => (await getStore().measurements.listForDocument(OWNER_ID, id)).map(m => `${m.canonical}=${m.value_text}`).sort();

describe('the headline', () => {
  it('keeps what the owner set, fills in the rest, and gives a column back when it is cleared', async () => {
    const d = await readDoc();
    expect(await rereadDocument(OWNER_ID, d.id)).toBe(true);
    expect((await getStore().documents.findFor(OWNER_ID, d.id))).toMatchObject({ title: 'Model title', provider: 'Model clinic' });

    // Saving the form sends every headline field; only the title differs from what is stored.
    expect((await patch(d.id, { title: 'My title', provider: 'Model clinic', doc_date: '2026-04-06', doc_type: 'lab_result', ai_summary: 'Model summary', reviewed: true })).statusCode).toBe(200);
    expect(await getStore().documents.editedColumns(OWNER_ID, d.id)).toEqual(['title']);

    reading = { ...reading, title: 'Second title', provider: 'Other clinic', ai_summary: 'Second summary' };
    await rereadDocument(OWNER_ID, d.id);
    expect(await getStore().documents.findFor(OWNER_ID, d.id)).toMatchObject({ title: 'My title', provider: 'Other clinic', ai_summary: 'Second summary', reviewed: 0 });

    expect((await patch(d.id, { title: '' })).statusCode).toBe(200);
    expect(await getStore().documents.editedColumns(OWNER_ID, d.id)).toEqual([]);
    reading = { ...reading, title: 'Third title' };
    await rereadDocument(OWNER_ID, d.id);
    expect((await getStore().documents.findFor(OWNER_ID, d.id))!.title).toBe('Third title');
  });

  it('does not take a column over just because the form was saved with it unchanged', async () => {
    const d = await readDoc();
    await rereadDocument(OWNER_ID, d.id);
    await patch(d.id, { title: 'Model title', provider: 'Model clinic', reviewed: true });
    expect(await getStore().documents.editedColumns(OWNER_ID, d.id)).toEqual([]);
  });
});

describe('fields and results', () => {
  it('keeps a field the owner added or changed, takes the new reading’s other fields, and does not repeat the owner’s', async () => {
    const d = await readDoc();
    reading = { ...reading, fields: [field('diagnosis', 'Anemie'), field('observatii', 'Repaus')] };
    await rereadDocument(OWNER_ID, d.id);
    const [diagnosis] = (await getStore().fields.listForDocument(OWNER_ID, d.id)).filter(f => f.label === 'diagnosis');

    expect((await patch(d.id, { fields: {
      update: [{ id: diagnosis.id, label: 'diagnosis', value: 'Anemie feripriva' }],
      add: [{ label: 'my remark', value: 'Ask about iron', page_id: d.pageId }],
    } })).statusCode).toBe(200);

    reading = { ...reading, fields: [field('diagnosis', 'Anemie'), field('observatii', 'Repaus la pat'), field('my remark', 'something else'), field('recomandare', 'Fier')] };
    await rereadDocument(OWNER_ID, d.id);
    expect(await fieldsOf(d.id)).toEqual(['diagnosis=Anemie feripriva', 'my remark=Ask about iron', 'observatii=Repaus la pat', 'recomandare=Fier']);
  });

  it('does not bring back a field or a result the owner removed, but would bring back a different reading', async () => {
    const d = await readDoc();
    reading = { ...reading, fields: [field('observatii', 'Repaus'), field('diagnosis', 'Anemie')], measurements: [result('Hb', 'hemoglobin', '13.5'), result('Fe', 'iron', '40')] };
    await rereadDocument(OWNER_ID, d.id);
    const store = getStore();
    const observatii = (await store.fields.listForDocument(OWNER_ID, d.id)).find(f => f.label === 'observatii')!;
    const hb = (await store.measurements.listForDocument(OWNER_ID, d.id)).find(m => m.canonical === 'hemoglobin')!;
    expect((await patch(d.id, { fields: { remove: [observatii.id] }, measurements: { remove: [hb.id] } })).statusCode).toBe(200);

    await rereadDocument(OWNER_ID, d.id);
    expect(await fieldsOf(d.id)).toEqual(['diagnosis=Anemie']);
    expect(await resultsOf(d.id)).toEqual(['iron=40']);

    reading = { ...reading, fields: [field('observatii', 'Repaus absolut')], measurements: [result('Hb', 'hemoglobin', '11.0')] };
    await rereadDocument(OWNER_ID, d.id);
    expect(await fieldsOf(d.id)).toEqual(['observatii=Repaus absolut']);
    expect(await resultsOf(d.id)).toEqual(['hemoglobin=11.0']);
  });

  it('keeps a result the owner changed and does not add the new reading’s value for the same test and day', async () => {
    const d = await readDoc();
    reading = { ...reading, measurements: [result('Hb', 'hemoglobin', '13.5'), result('Fe', 'iron', '40')] };
    await rereadDocument(OWNER_ID, d.id);
    const hb = (await getStore().measurements.listForDocument(OWNER_ID, d.id)).find(m => m.canonical === 'hemoglobin')!;
    expect((await patch(d.id, { measurements: { update: [{ id: hb.id, name: 'Hb', canonical: 'hemoglobin', value: '13.9', unit: 'g/dL', ref_low: null, ref_high: null, taken_on: '2026-04-06' }] } })).statusCode).toBe(200);

    reading = { ...reading, measurements: [result('Hb', 'hemoglobin', '13.5'), result('Fe', 'iron', '44')] };
    await rereadDocument(OWNER_ID, d.id);
    expect(await resultsOf(d.id)).toEqual(['hemoglobin=13.9', 'iron=44']);
  });

  it('forgets what was removed when the document goes', async () => {
    const d = await readDoc();
    reading = { ...reading, fields: [field('observatii', 'Repaus')] };
    await rereadDocument(OWNER_ID, d.id);
    const f = (await getStore().fields.listForDocument(OWNER_ID, d.id))[0];
    await patch(d.id, { fields: { remove: [f.id] } });
    expect((await getStore().fields.removedKeys(OWNER_ID, d.id)).size).toBe(1);
    await getStore().documents.delete(OWNER_ID, d.id);
    expect((await getStore().fields.removedKeys(OWNER_ID, d.id)).size).toBe(0);
    void uuidv4;
  });
});
