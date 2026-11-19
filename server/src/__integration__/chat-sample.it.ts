import { beforeAll, expect, it } from 'vitest';
import { describePipeline } from './support/live.js';
import { OWNER_ID, ask, startWorld, type World } from './support/world.js';
import { getStore } from 'spine-core/store/index.js';
import { useDemoSource } from 'spine-core/demo/archive.js';
import { clinicDemoSource } from 'spine-core/testing/clinic/source.js';
import type { Document } from 'spine-core/types.js';

/**
 * The assistant over the sample archive a new person explores first ("Explore with sample records"): an invented patient's three years at a
 * clinic, a laboratory, a hospital and a GP, written in Romanian with the translations the sample carries. The values asked about are the
 * ones the archive was drawn from (`core/src/testing/clinic/specs.ts`), so what the answers must hold is known. Asserted: values over
 * time from several documents, a consultation followed to the tests it asked for, "this" on a document page, a question in Romanian
 * answered in Romanian, no number invented for a test never done, a share prepared and not made, and nothing written by any of it.
 */
describePipeline('asking the assistant about the sample records', () => {
  let w: World;
  let docs: Document[];
  const byDate = (date: string, type: string) => {
    const found = docs.find(d => d.doc_date === date && d.doc_type === type);
    if (!found) throw new Error(`no ${type} of ${date} in the sample`);
    return found;
  };

  beforeAll(async () => {
    useDemoSource(clinicDemoSource());
    w = await startWorld();
    const started = await w.app.inject({ method: 'POST', url: '/api/demo', headers: { cookie: w.cookie }, payload: { language: 'en' } });
    expect(started.statusCode).toBe(202);
    for (let i = 0; ; i++) {
      const uploads = (await getStore().sourceFiles.listFor(OWNER_ID)).filter(u => u.sample);
      if (uploads.length > 0 && uploads.every(u => u.status === 'done' || u.status === 'error')) break;
      if (i > 1200) throw new Error('the sample records did not settle');
      await new Promise(r => setTimeout(r, 100));
    }
    docs = await getStore().documents.listFor(OWNER_ID, { limit: 100, offset: 0 });
    expect(docs.length).toBeGreaterThanOrEqual(30);
  }, 180_000);

  const snapshot = async () => JSON.stringify([
    await getStore().documents.listFor(OWNER_ID, { limit: 100, offset: 0 }),
    await getStore().shareLinks.listFor(OWNER_ID),
    await getStore().measurements.names(OWNER_ID),
  ]);

  it('follows a test across the laboratories and the years, and cites the documents', async () => {
    const before = await snapshot();
    const reply = await ask(w, 'How has my TSH changed since the first thyroid test?');
    const text = reply.answer ?? '';
    expect(text, text).toMatch(/9[.,]8/);
    expect(text, text).toMatch(/2[.,]3|2[.,]1/);
    const ids = reply.sources.map(s => s.id);
    expect(ids).toContain(byDate('2025-02-17', 'lab_result').id);
    expect(await snapshot()).toBe(before);
  });

  it('follows a consultation to the tests it asked for, at another provider', async () => {
    const reply = await ask(w, 'What did the cardiologist ask for in February 2026, and what did those tests show?');
    const text = reply.answer ?? '';
    expect(text, text).toMatch(/ECG|electrocardiogram/i);
    expect(text, text).toMatch(/lipid|LDL|cholesterol/i);
    expect(text, text).toMatch(/3[.,]8|high|elevated/i);
  });

  it('knows the current dose from the latest prescription, not the first', async () => {
    const reply = await ask(w, 'What dose of levothyroxine am I on now?');
    expect(reply.answer ?? '', reply.answer ?? '').toMatch(/75/);
  });

  it('understands "this" on a document page', async () => {
    const culture = byDate('2026-03-06', 'lab_result');
    const reply = await ask(w, 'What grew in this culture, and which antibiotics would work?', { screen: { page: 'document', documentId: culture.id } });
    const text = reply.answer ?? '';
    expect(text, text).toMatch(/E\.? ?coli|Escherichia/i);
    expect(text, text).toMatch(/nitrofurantoin|sensitive|susceptib/i);
    expect(reply.sources.some(s => s.id === culture.id)).toBe(true);
  });

  it('explains a Romanian document in English to a person who reads the app in English, with the dates written out', async () => {
    const culture = byDate('2026-03-06', 'lab_result');
    const reply = await ask(w, 'Explain this document in plain words', { screen: { page: 'document', documentId: culture.id }, language: 'en' });
    const text = reply.answer ?? '';
    expect(text, text).toMatch(/\b(the|and|was|with|this)\b/i);
    // The record's own terms may stay as written ("urocultură"); a Romanian answer cannot do without its small words.
    expect(text, text).not.toMatch(/(^|[^\p{L}])(și|este|pentru|sunt|din|rezultatul)([^\p{L}]|$)/iu);
    expect(text, text).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
  });

  it('answers a question asked in Romanian in Romanian', async () => {
    const reply = await ask(w, 'Când am fost internat în spital și pentru ce?');
    const text = reply.answer ?? '';
    expect(text, text).toMatch(/pneumonie|pneumonia/i);
    expect(text, text).toMatch(/septembrie|09\.2025|2025/i);
    // Romanian, not English: one of the words a Romanian answer cannot do without.
    expect(text, text).toMatch(/\b(și|în|pentru|la|din)\b/i);
  });

  it('says so for a test the records do not hold, with no number of its own', async () => {
    const reply = await ask(w, 'What was my HbA1c last year?');
    const text = (reply.answer ?? '').toLowerCase();
    expect(text, text).not.toMatch(/\b\d+([.,]\d+)?\s*%/);
    expect(text, text).toMatch(/no |not |don.t|cannot|can.t|none|isn.t|aren.t|doesn.t/);
  });

  it('prepares a share of the cardiology visits as a card, and makes no link', async () => {
    const before = await snapshot();
    const reply = await ask(w, 'Prepare a link to share my cardiology visits and their tests with a new cardiologist.');
    const share = reply.proposals?.find(p => p.kind === 'share_link');
    expect(share, `it said: ${reply.answer?.slice(0, 300)}`).toBeTruthy();
    const chosen = new Set((share as { documents: Array<{ id: string }> }).documents.map(d => d.id));
    expect(chosen.has(byDate('2026-03-12', 'lab_result').id)).toBe(true);
    expect(chosen.has(byDate('2026-04-14', 'consultation_note').id)).toBe(false); // the dermatology visit is not cardiology
    expect(await snapshot()).toBe(before);
  });
});
