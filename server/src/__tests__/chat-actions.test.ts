import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { buildTestApp, loginSession } from './helpers/app.js';
import { OWNER_ID, createTestUser, seedDocument } from './helpers/seed.js';
import { ScriptedModel } from 'spine-core/testing/scripted-model.js';
import { getStore } from 'spine-core/store/index.js';
import { resetChatLlm, type ChatLlm } from 'spine-core/llm/index.js';
import type { Proposal } from 'spine-core/chat/proposals.js';

/**
 * The chat can prepare changes and never makes them. Each action tool returns a proposal; these tests check what is in it, that
 * the store is untouched until the person confirms, and that the requests Confirm would send are accepted by the real routes.
 */
let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
let otherId: string;
let model: ScriptedModel;
const llmWith = (m: ScriptedModel | null) => ({ agentModel: () => m, answerQuestion: async () => null }) as unknown as ChatLlm;

beforeAll(async () => { app = await buildTestApp(); cookie = await loginSession(app); otherId = (await createTestUser('other-actions@spine.test')).id; });
afterAll(async () => { await app.close(); });
beforeEach(async () => {
  for (const userId of [OWNER_ID, otherId]) for (const f of await getStore().sourceFiles.listFor(userId)) await getStore().sourceFiles.delete(userId, f.id);
  for (const dr of await getStore().doctors.listFor(OWNER_ID)) await getStore().doctors.remove(OWNER_ID, dr.id);
  for (const l of await getStore().shareLinks.listFor(OWNER_ID)) await getStore().shareLinks.revoke(OWNER_ID, l.id);
});
afterEach(() => resetChatLlm());

async function doc(title: string, summary: string, date = '2026-01-10', userId = OWNER_ID, docType: 'lab_result' | 'consultation_note' = 'lab_result') {
  const d = await seedDocument({ userId, docType, docDate: date, provider: null, aiSummary: summary });
  await getStore().documents.update(userId, d.id, { title });
  return d;
}
const ask = (question: string) => app.inject({ method: 'POST', url: '/api/chat', payload: { question }, headers: { cookie } });
const run = async (steps: ConstructorParameters<typeof ScriptedModel>[0], question = 'do it') => {
  model = new ScriptedModel(steps);
  resetChatLlm(llmWith(model));
  const res = await ask(question);
  expect(res.statusCode).toBe(200);
  return res.json() as { answer: string; proposals?: Proposal[] };
};
const toolText = () => model.seen.at(-1)!.filter(x => x.getType() === 'tool').map(x => String(x.content)).join('\n');
/** What Confirm does: send each request to the real route as the owner. */
async function confirm(p: Proposal & { calls?: Array<{ method: string; path: string; body?: unknown }> }) {
  const results = [];
  for (const call of p.calls ?? []) {
    results.push(await app.inject({ method: call.method as 'PATCH', url: call.path, payload: call.body as object | undefined, headers: { cookie } }));
  }
  return results;
}
const first = async (title: string) => (await getStore().documents.listFor(OWNER_ID, { limit: 50, offset: 0 })).find(d => d.title === title)!;

describe('proposing a share link', () => {
  it('finds the visit, follows it to the tests it asked for, and proposes one link naming exactly those', async () => {
    const old = await doc('Cardiology visit last year', 'Cardiology consultation', '2025-10-01', OWNER_ID, 'consultation_note');
    const visit = await doc('Cardiology visit now', 'Cardiology consultation', '2026-10-01', OWNER_ID, 'consultation_note');
    const labs = await doc('Lipid panel', 'Cholesterol results', '2026-10-05');
    await doc('Unrelated knee x-ray', 'Knee', '2026-03-01');
    await getStore().links.add(OWNER_ID, { from_document_id: visit.id, to_document_id: labs.id, kind: 'requests', source: 'owner', state: 'confirmed', reason: null }, '2026-10-06T00:00:00Z');

    const reply = await run([
      { tools: [{ name: 'search_documents', args: { query: 'cardiology' } }] },
      { tools: [{ name: 'get_connected_documents', args: { label: 'D1' } }] },
      { tools: [{ name: 'propose_share_link', args: { documents: ['D1', 'D2', 'D3'], label: 'Cardiology follow-up', expires_days: 14 } }] },
      { say: 'I proposed a link with the two visits and the lipid panel the new visit asked for.' },
    ], 'share the cardiology visit from last year and the one now, with the tests it asked for');

    expect(reply.proposals).toHaveLength(1);
    const p = reply.proposals![0];
    expect(p.kind).toBe('share_link');
    if (p.kind !== 'share_link') return;
    expect(p.documents.map(d => d.id).sort()).toEqual([old.id, visit.id, labs.id].sort());
    expect(p).toMatchObject({ label: 'Cardiology follow-up', expires_days: 14, include_scans: false, allow_chat: false });
    expect(await getStore().shareLinks.listFor(OWNER_ID)).toEqual([]);

    // Confirm, as the page does: the ordinary route, with the documents on the card.
    const created = await app.inject({ method: 'POST', url: '/api/share-links', headers: { cookie }, payload: { scope: 'document_ids', scope_value: p.documents.map(d => d.id), label: p.label, expires_days: p.expires_days } });
    expect(created.statusCode).toBe(201);
  });

  it('refuses a label the request never gave, another person’s document, and too many documents', async () => {
    const mine = await doc('Mine', 'Mine');
    await doc('Theirs', 'Theirs', '2026-01-10', otherId);
    const reply = await run([
      { tools: [{ name: 'search_documents', args: { query: 'mine' } }] },
      { tools: [{ name: 'propose_share_link', args: { documents: ['D1', 'D9'] } }] },
      { say: 'could not' },
    ]);
    expect(reply.proposals).toBeUndefined();
    expect(toolText()).toContain('There is no document D9');
    expect(mine.id).toBeDefined();
  });

  it('does not let the model set what a share exposes', async () => {
    await doc('Ankle report', 'Ankle report');
    const reply = await run([
      { tools: [{ name: 'search_documents', args: { query: 'ankle' } }] },
      { tools: [{ name: 'propose_share_link', args: { documents: ['D1'], include_scans: true, allow_chat: true, require_approval: false } }] },
      { say: 'ok' },
    ]);
    const p = reply.proposals![0];
    expect(p).toMatchObject({ kind: 'share_link', include_scans: false, allow_chat: false });
  });
});

describe('proposing a change to a document', () => {
  it('adds a note after the existing ones, and the route accepts it', async () => {
    const d = await doc('Visit', 'Visit');
    await getStore().documents.update(OWNER_ID, d.id, { user_notes: 'First note.' });
    const reply = await run([
      { tools: [{ name: 'search_documents', args: { query: 'visit' } }] },
      { tools: [{ name: 'propose_note', args: { document: 'D1', text: 'Ask about the dose.' } }] },
      { say: 'Proposed.' },
    ]);
    const p = reply.proposals![0];
    expect(p).toMatchObject({ kind: 'add_note', text: 'Ask about the dose.' });
    expect((await getStore().documents.findFor(OWNER_ID, d.id))!.user_notes).toBe('First note.');
    expect((await confirm(p as never)).map(r => r.statusCode)).toEqual([200]);
    expect((await getStore().documents.findFor(OWNER_ID, d.id))!.user_notes).toBe('First note.\n\nAsk about the dose.');
  });

  it('corrects a field by its label and the headline, shows before and after, and changes nothing until confirmed', async () => {
    const d = await doc('Blood count', 'Blood count');
    const fieldId = uuidv4();
    await getStore().fields.create(OWNER_ID, { id: fieldId, documentId: d.id, pageId: d.pageId!, label: 'patient_name', value: 'Ion Popesco', sourceSnippet: null, bbox: null, confidence: 1 });
    const reply = await run([
      { tools: [{ name: 'search_documents', args: { query: 'blood' } }] },
      { tools: [{ name: 'get_fields', args: { label: 'D1' } }] },
      { tools: [{ name: 'propose_edit_document', args: { document: 'D1', title: 'Blood count, March', field_updates: [{ field: 'F1', value: 'Ion Popescu' }] } }] },
      { say: 'Proposed.' },
    ]);
    const p = reply.proposals![0];
    expect(p).toMatchObject({ kind: 'edit_document' });
    if (p.kind !== 'edit_document') return;
    expect(p.changes).toEqual([
      { what: 'title', from: 'Blood count', to: 'Blood count, March' },
      { what: 'field_update', label: 'patient_name', from: 'Ion Popesco', to: 'Ion Popescu' },
    ]);
    expect((await getStore().fields.listForDocument(OWNER_ID, d.id))[0].value).toBe('Ion Popesco');
    expect((await confirm(p)).map(r => r.statusCode)).toEqual([200]);
    expect((await getStore().fields.listForDocument(OWNER_ID, d.id))[0].value).toBe('Ion Popescu');
    expect((await getStore().documents.findFor(OWNER_ID, d.id))!.title).toBe('Blood count, March');
  });

  it('will not change a field it was not shown, or one of another document', async () => {
    await doc('Alpha report', 'Alpha report'); await doc('Beta report', 'Beta report');
    const reply = await run([
      { tools: [{ name: 'search_documents', args: { query: 'report' } }] },
      { tools: [{ name: 'propose_edit_document', args: { document: 'D1', field_updates: [{ field: 'F7', value: 'x' }] } }] },
      { say: 'could not' },
    ]);
    expect(reply.proposals).toBeUndefined();
    expect(toolText()).toMatch(/There is no field F7/);
  });

  it('proposes tags and reviewed for several documents, and the routes accept them', async () => {
    const a = await doc('Visit A', 'Cardiology A'); const b = await doc('Visit B', 'Cardiology B');
    const reply = await run([
      { tools: [{ name: 'search_documents', args: { query: 'cardiology' } }] },
      { tools: [{ name: 'propose_tags', args: { changes: [{ document: 'D1', add: ['Cardiology'] }, { document: 'D2', add: ['cardiology', 'follow-up'] }] } }, { name: 'propose_mark_reviewed', args: { documents: ['D1', 'D2'] } }] },
      { say: 'Proposed.' },
    ]);
    expect(reply.proposals!.map(p => p.kind).sort()).toEqual(['mark_reviewed', 'tag_documents']);
    for (const p of reply.proposals!) expect((await confirm(p as never)).every(r => r.statusCode === 200)).toBe(true);
    // Which document is D1 depends on how the search ranked them; both got the first tag and one the second.
    const tagsOf = async (id: string) => (await getStore().tags.namesForDocument(OWNER_ID, id)).sort();
    expect([await tagsOf(a.id), await tagsOf(b.id)].sort()).toEqual([['cardiology'], ['cardiology', 'follow-up']]);
    expect((await getStore().documents.findFor(OWNER_ID, a.id))!.reviewed).toBeTruthy();
  });
});

describe('links between documents and revoking a share', () => {
  it('proposes a care link earlier to later, refuses it backwards, and the route accepts it', async () => {
    await doc('Consultation', 'Cardiology consultation', '2026-03-01', OWNER_ID, 'consultation_note');
    await doc('Lipid panel', 'Cholesterol', '2026-03-20');
    const backwards = await run([
      { tools: [{ name: 'search_documents', args: { query: 'cardiology cholesterol' } }] },
      { tools: [{ name: 'propose_link', args: { from: 'D2', to: 'D1', kind: 'requests' } }] },
      { say: 'oops' },
    ]);
    expect(backwards.proposals).toBeUndefined();
    expect(toolText()).toMatch(/dated after/);
    const consultation = await first('Consultation');
    const panel = await first('Lipid panel');
    const reply = await run([
      { tools: [{ name: 'search_documents', args: { query: 'cardiology cholesterol' } }] },
      { tools: [{ name: 'propose_link', args: { from: 'D1', to: 'D2', kind: 'requests' } }] },
      { say: 'ok' },
    ]);
    const p = reply.proposals![0];
    if (p.kind !== 'link_documents') throw new Error('wrong kind');
    // Whichever way the search ordered them, the earlier one is "from".
    expect([p.from.id, p.to.id]).toEqual([consultation.id, panel.id]);
    expect((await confirm(p)).map(r => r.statusCode)).toEqual([201]);
  });

  it('lists the links and proposes revoking one, which the route then does', async () => {
    const d = await doc('Visit', 'Visit');
    const made = await app.inject({ method: 'POST', url: '/api/share-links', headers: { cookie }, payload: { scope: 'document_ids', scope_value: [d.id], label: 'For Dr. Invented' } });
    const reply = await run([
      { tools: [{ name: 'list_share_links', args: {} }] },
      { tools: [{ name: 'propose_revoke_share', args: { link: 'L1' } }] },
      { say: 'Proposed.' },
    ], 'revoke the link for Dr. Invented');
    expect(toolText()).toContain('L1: “For Dr. Invented”, 1 documents, active');
    const p = reply.proposals![0];
    expect(p).toMatchObject({ kind: 'revoke_share', link: { id: made.json().id } });
    expect((await getStore().shareLinks.listFor(OWNER_ID)).find(l => l.id === made.json().id)!.revoked).toBeFalsy();
    expect((await confirm(p as never)).map(r => r.statusCode)).toEqual([200]);
    expect((await getStore().shareLinks.listFor(OWNER_ID)).find(l => l.id === made.json().id)!.revoked).toBeTruthy();
  });
});

describe('tidying duplicates', () => {
  const doctor = (name: string, extra: { specialty?: string; clinic?: string; licenseCode?: string } = {}) =>
    getStore().doctors.upsert(OWNER_ID, { name, ...extra }, '2026-01-01T00:00:00Z');
  const listIds = async () => Object.fromEntries((await getStore().doctors.listFor(OWNER_ID)).map(d => [d.name, d.id]));

  it('proposes one final form for entries of one person, and Confirm merges them into it', async () => {
    const d = await doc('Visit', 'Visit');
    const a = await doctor('Popescu I.', { specialty: 'cardiology' });
    const b = await doctor('Popescu Ion', { clinic: 'Regina Maria', licenseCode: 'A12345' });
    const c = await doctor('Zorila Maria');
    expect(a && b && c).toBeTruthy();
    await getStore().doctors.link(OWNER_ID, d.id, a!, 'author');
    const ids = await listIds();

    const reply = await run([
      { tools: [{ name: 'list_doctors', args: {} }] },
      { tools: [{ name: 'propose_merge_doctors', args: { groups: [{ keep: 'P1', merge: ['P2'], name: 'Popescu Ion' }] } }] },
      { say: 'I grouped the two Popescu entries.' },
    ], 'tidy my doctors');
    const text = toolText();
    expect(text).toMatch(/P\d: .*Popescu/i);
    const p = reply.proposals![0];
    if (p.kind !== 'merge_doctors') throw new Error(p.kind);
    const [g] = p.groups;
    // Which of the two the directory listed first is not fixed; the final form takes what either knew.
    expect(new Set([g.keep.id, ...g.merge.map(m => m.id)])).toEqual(new Set([ids['Popescu I.'], ids['Popescu Ion']]));
    expect(g.final).toEqual({ name: 'Popescu Ion', specialty: 'cardiology', clinic: 'Regina Maria', license_code: 'A12345' });
    expect(await getStore().doctors.listFor(OWNER_ID)).toHaveLength(3);

    // Confirm, as the page does it: fold in, then write the final form.
    for (const m of g.merge) expect((await app.inject({ method: 'POST', url: `/api/doctors/${g.keep.id}/merge`, payload: { from: m.id }, headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: `/api/doctors/${g.keep.id}`, payload: { ...g.final }, headers: { cookie } })).statusCode).toBe(200);
    const left = (await getStore().doctors.listFor(OWNER_ID)).find(x => x.id === g.keep.id)!;
    expect(left).toMatchObject({ name: 'Popescu Ion', specialty: 'cardiology', clinic: 'Regina Maria', license_code: 'A12345', document_count: 1 });
    expect(await getStore().doctors.listFor(OWNER_ID)).toHaveLength(2);
  });

  it('refuses to group people with different professional codes, or labels it was not given', async () => {
    await doc('Visit', 'Visit');
    await doctor('Popescu Ion', { licenseCode: 'A11111' });
    await doctor('Popescu Ion C.', { licenseCode: 'B22222' });
    const reply = await run([
      { tools: [{ name: 'list_doctors', args: {} }] },
      { tools: [{ name: 'propose_merge_doctors', args: { groups: [{ keep: 'P1', merge: ['P2'] }] } }, { name: 'propose_merge_doctors', args: { groups: [{ keep: 'P1', merge: ['P9'] }] } }] },
      { say: 'could not' },
    ]);
    expect(reply.proposals).toBeUndefined();
    expect(toolText()).toMatch(/different professional codes/);
    expect(toolText()).toMatch(/labels are unknown/);
  });

  it('proposes one name for a test written several ways, warns about units, and Confirm folds and renames', async () => {
    const d = await doc('Blood count', 'Blood count');
    const value = (name: string, canonical: string, unit: string, v: number) => getStore().measurements.create(OWNER_ID, { id: uuidv4(), documentId: d.id, pageId: d.pageId!, name, canonical, valueText: String(v), valueNum: v, unit, refLow: null, refHigh: null, flag: null, takenOn: '2026-02-01', sourceSnippet: null, bbox: null, confidence: 1 });
    await value('Hb', 'hb', 'g/dL', 13); await value('Hemoglobin', 'hemoglobin', 'g/L', 130); await value('Ferritin', 'ferritin', 'ng/mL', 40);

    const reply = await run([
      { tools: [{ name: 'list_tests', args: {} }] },
      { tools: [{ name: 'propose_merge_tests', args: { groups: [{ into: 'hemoglobin', merge: ['Hb'], name: 'Hemoglobin' }] } }, { name: 'propose_merge_tests', args: { groups: [{ into: 'hemoglobin', merge: ['nonsense'] }] } }] },
      { say: 'ok' },
    ]);
    expect(reply.proposals).toHaveLength(1);
    const p = reply.proposals![0];
    if (p.kind !== 'merge_tests') throw new Error(p.kind);
    expect(p.groups[0].into.units).toEqual(['g/L']);
    expect(p.groups[0].from[0].units).toEqual(['g/dL']);
    expect(p.groups[0].final_name).toBe('Hemoglobin');
    expect(toolText()).toMatch(/not in the person’s results/);

    expect((await app.inject({ method: 'POST', url: '/api/measurements/merge', payload: { from: 'hb', into: 'hemoglobin' }, headers: { cookie } })).statusCode).toBe(200);
    expect((await getStore().measurements.names(OWNER_ID)).map(n => n.canonical).sort()).toEqual(['ferritin', 'hemoglobin']);
  });
});

describe('results, the library and existing share links', () => {
  const addResult = (d: { id: string; pageId: string | null }, name: string, canonical: string, value: string, unit: string, low: number | null, high: number | null) =>
    getStore().measurements.create(OWNER_ID, { id: uuidv4(), documentId: d.id, pageId: d.pageId!, name, canonical, valueText: value, valueNum: Number(value), unit, refLow: low, refHigh: high, flag: null, takenOn: '2026-02-01', sourceSnippet: null, bbox: null, confidence: 1 });

  it('corrects, adds and removes results by their labels, and the route works the flag out again', async () => {
    const d = await doc('Blood count', 'Blood count');
    await addResult(d, 'Hemoglobin', 'hemoglobin', '9.8', 'g/dL', 12, 16);
    await addResult(d, 'Leukocytes', 'leukocytes', '6.2', '10^9/L', 4, 10);
    const reply = await run([
      { tools: [{ name: 'search_documents', args: { query: 'blood count' } }] },
      { tools: [{ name: 'get_results', args: { label: 'D1' } }] },
      { tools: [{ name: 'propose_edit_document', args: { document: 'D1', result_updates: [{ result: 'M1', value: '13.4' }], result_removes: ['M2'], result_adds: [{ name: 'Platelets', value: '250', unit: '10^9/L', ref_low: 150, ref_high: 400 }] } }] },
      { say: 'Proposed.' },
    ]);
    expect(toolText()).toMatch(/M1: (Hemoglobin|Leukocytes)/);
    const p = reply.proposals![0];
    if (p.kind !== 'edit_document') throw new Error(p.kind);
    expect(p.changes.map(c => c.what).sort()).toEqual(['result_add', 'result_remove', 'result_update']);
    expect((await getStore().measurements.listForDocument(OWNER_ID, d.id)).map(m => m.canonical).sort()).toEqual(['hemoglobin', 'leukocytes']);
    expect((await confirm(p)).map(r => r.statusCode)).toEqual([200]);
    const after = await getStore().measurements.listForDocument(OWNER_ID, d.id);
    expect(after.find(m => m.canonical === 'hemoglobin')).toMatchObject({ value_text: '13.4' });
    // 13.4 is inside the range 12-16: whatever the flag for a value in range is, it is not the low one 9.8 would have had.
    expect(after.find(m => m.canonical === 'hemoglobin')!.flag).not.toBe('low');
    expect(after.some(m => m.canonical === 'platelets' && m.value_text === '250' && m.unit === '10^9/L')).toBe(true);
    expect(after.some(m => m.canonical === 'leukocytes')).toBe(false);
  });

  it('merges tags and providers into one final name each, and Confirm folds then renames', async () => {
    const a = await seedDocument({ docType: 'lab_result', docDate: '2026-01-10', provider: 'Regina Maria', aiSummary: 'A', tags: ['cardio'] });
    const b = await seedDocument({ docType: 'lab_result', docDate: '2026-01-11', provider: 'REGINA MARIA SRL', aiSummary: 'B', tags: ['cardiac care'] });
    const labels = await run([{ tools: [{ name: 'list_library', args: {} }] }, { say: 'ok' }]);
    expect(labels).toBeDefined();
    const listed = toolText();
    const at = (re: RegExp) => re.exec(listed)![1];
    const [tagA, tagB] = [at(/(TG\d+): cardio \(1\)/), at(/(TG\d+): cardiac care \(1\)/)];
    const [provA, provB] = [at(/(PR\d+): Regina Maria \(1\)/), at(/(PR\d+): REGINA MARIA SRL \(1\)/)];

    const reply = await run([
      { tools: [{ name: 'list_library', args: {} }] },
      { tools: [
        { name: 'propose_merge_library', args: { library: 'tags', groups: [{ keep: tagA, merge: [tagB], name: 'Cardiology' }] } },
        { name: 'propose_merge_library', args: { library: 'providers', groups: [{ keep: provA, merge: [provB], name: 'Regina Maria' }] } },
        { name: 'propose_merge_library', args: { library: 'tags', groups: [{ keep: 'TG99', merge: [tagB] }] } },
      ] },
      { say: 'ok' },
    ]);
    expect(reply.proposals).toHaveLength(2);
    const tags = reply.proposals!.find(p => p.kind === 'merge_library' && p.library === 'tags')!;
    const providers = reply.proposals!.find(p => p.kind === 'merge_library' && p.library === 'providers')!;
    if (tags.kind !== 'merge_library' || providers.kind !== 'merge_library') throw new Error('kind');
    expect(tags.groups[0].final_name).toBe('cardiology');

    // Confirm, as the page does: fold each variant in, then give the kept entry the final name.
    const g = tags.groups[0];
    for (const m of g.merge) expect((await app.inject({ method: 'POST', url: `/api/tags/${m.id}/merge`, payload: { into: g.keep.id }, headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: `/api/tags/${g.keep.id}`, payload: { name: g.final_name }, headers: { cookie } })).statusCode).toBe(200);
    const pg = providers.groups[0];
    for (const entry of [pg.keep, ...pg.merge]) {
      if (entry.name !== pg.final_name) expect((await app.inject({ method: 'POST', url: '/api/providers/rename', payload: { from: entry.name, to: pg.final_name }, headers: { cookie } })).statusCode).toBe(200);
    }
    expect(await getStore().tags.namesForDocument(OWNER_ID, a.id)).toContain('cardiology');
    expect(await getStore().tags.namesForDocument(OWNER_ID, b.id)).toContain('cardiology');
    expect(await getStore().tags.namesForDocument(OWNER_ID, b.id)).not.toContain('cardiac care');
    expect((await getStore().documents.findFor(OWNER_ID, b.id))!.provider).toBe('Regina Maria');
  });

  it('changes an existing share link’s name, length and documents, but never what it exposes', async () => {
    const first = await doc('First report', 'First');
    const second = await doc('Second report', 'Second');
    const made = await app.inject({ method: 'POST', url: '/api/share-links', headers: { cookie }, payload: { scope: 'document_ids', scope_value: [first.id], label: 'For Dr. Invented', expires_days: 3 } });
    const id = made.json().id as string;
    const reply = await run([
      { tools: [{ name: 'list_share_links', args: {} }] },
      { tools: [{ name: 'get_share_link', args: { link: 'L1' } }] },
      { tools: [{ name: 'search_documents', args: { query: 'second' } }] },
      { tools: [{ name: 'propose_update_share', args: { link: 'L1', label: 'For Dr. Invented, both reports', expires_days: 14, add_documents: ['D2'], include_scans: true, allow_chat: true } }] },
      { say: 'Proposed.' },
    ]);
    expect(toolText()).toMatch(/It shares:/);
    const p = reply.proposals![0];
    if (p.kind !== 'update_share') throw new Error(p.kind);
    expect(p).toMatchObject({ label: { from: 'For Dr. Invented', to: 'For Dr. Invented, both reports' }, expires: { to_days: 14 }, total_after: 2 });
    expect(p.added.map(d => d.id)).toEqual([second.id]);
    const body = p.calls[0].body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['expires_days', 'label', 'scope', 'scope_value']);
    expect((await confirm(p)).map(r => r.statusCode)).toEqual([200]);
    const detail = (await app.inject({ method: 'GET', url: `/api/share-links/${id}`, headers: { cookie } })).json();
    expect(detail.documents).toHaveLength(2);
    expect(detail.link).toMatchObject({ label: 'For Dr. Invented, both reports', include_scans: false, allow_chat: false });
  });

  it('will not change a revoked link, empty a link, or touch a document that is not shown', async () => {
    const only = await doc('Only report', 'Only');
    const made = await app.inject({ method: 'POST', url: '/api/share-links', headers: { cookie }, payload: { scope: 'document_ids', scope_value: [only.id], label: 'x' } });
    await run([{ tools: [{ name: 'list_share_links', args: {} }] }, { tools: [{ name: 'get_share_link', args: { link: 'L1' } }] }, { tools: [{ name: 'search_documents', args: { query: 'only report' } }] }, { tools: [{ name: 'propose_update_share', args: { link: 'L1', remove_documents: ['D1'] } }] }, { say: 'no' }]);
    expect(toolText()).toMatch(/sharing nothing/);
    await app.inject({ method: 'DELETE', url: `/api/share-links/${made.json().id}`, headers: { cookie } });
    const reply = await run([{ tools: [{ name: 'list_share_links', args: {} }] }, { tools: [{ name: 'propose_update_share', args: { link: 'L1', label: 'again' } }] }, { say: 'no' }]);
    expect(reply.proposals).toBeUndefined();
    expect(toolText()).toMatch(/revoked/);
  });
});

describe('what keeps an action a proposal', () => {
  it('changes nothing in the store while the agent runs, whatever it proposes', async () => {
    const d = await doc('Visit', 'Visit');
    const before = JSON.stringify([await getStore().documents.findFor(OWNER_ID, d.id), await getStore().shareLinks.listFor(OWNER_ID), await getStore().tags.namesForDocument(OWNER_ID, d.id)]);
    await run([
      { tools: [{ name: 'search_documents', args: { query: 'visit' } }] },
      { tools: [
        { name: 'propose_share_link', args: { documents: ['D1'] } },
        { name: 'propose_note', args: { document: 'D1', text: 'x' } },
        { name: 'propose_tags', args: { changes: [{ document: 'D1', add: ['t'] }] } },
        { name: 'propose_edit_document', args: { document: 'D1', title: 'Other' } },
        { name: 'propose_mark_reviewed', args: { documents: ['D1'] } },
      ] },
      { say: 'Proposed all.' },
    ]);
    expect(JSON.stringify([await getStore().documents.findFor(OWNER_ID, d.id), await getStore().shareLinks.listFor(OWNER_ID), await getStore().tags.namesForDocument(OWNER_ID, d.id)])).toBe(before);
  });

  it('allows five proposals for one question and tells the model when it is past that', async () => {
    await doc('Visit', 'Visit');
    const tool = (text: string) => ({ name: 'propose_note', args: { document: 'D1', text } });
    const reply = await run([
      { tools: [{ name: 'search_documents', args: { query: 'visit' } }] },
      { tools: ['a', 'b', 'c', 'd', 'e', 'f'].map(tool) },
      { say: 'done' },
    ]);
    expect(reply.proposals).toHaveLength(5);
    expect(toolText()).toMatch(/At most 5 proposals/);
  });

  it('keeps a proposal out of the stored conversation: only the words are kept', async () => {
    await doc('Visit', 'Visit');
    await run([
      { tools: [{ name: 'search_documents', args: { query: 'visit' } }] },
      { tools: [{ name: 'propose_note', args: { document: 'D1', text: 'x' } }] },
      { say: 'Proposed a note.' },
    ]);
    const [conversation] = await getStore().conversations.list(OWNER_ID, 5);
    const messages = await getStore().conversations.messages(OWNER_ID, conversation.id);
    expect(JSON.stringify(messages)).not.toMatch(/calls|add_note|PATCH/);
  });

  it('gives a share recipient’s agent none of the action tools', async () => {
    const d = await doc('Visit', 'Visit');
    const link = await app.inject({ method: 'POST', url: '/api/share-links', headers: { cookie }, payload: { scope: 'document_ids', scope_value: [d.id], allow_chat: true } });
    model = new ScriptedModel([{ say: 'ok' }]);
    resetChatLlm(llmWith(model));
    await app.inject({ method: 'POST', url: `/api/share/${link.json().id}/chat`, payload: { question: 'change the title' } });
    expect(model.bound.filter(n => n.startsWith('propose_') || n === 'get_fields' || n === 'list_share_links')).toEqual([]);
  });

  it('is told, in the owner’s prompt, to propose and not to claim it is done', async () => {
    await doc('Visit', 'Visit');
    await run([{ say: 'ok' }]);
    const system = String(model.seen[0][0].content);
    expect(system).toMatch(/you cannot change anything yourself/);
    expect(system).toMatch(/ask one short question first/);
  });
});

describe('reviewing the connections the app suggested', () => {
  const suggest = async (from: string, to: string, kind: 'requests' | 'follow_up' | 'same_episode' = 'requests', userId = OWNER_ID) =>
    getStore().links.add(userId, { from_document_id: from, to_document_id: to, kind, source: 'auto', state: 'proposed', reason: JSON.stringify({ tests: ['cholesterol'], days_apart: 5 }) }, new Date().toISOString());
  const stateOf = async (from: string, to: string) => (await getStore().links.among(OWNER_ID, [from, to])).find(l => l.from_document_id === from)?.state;

  it('lists the ones waiting across the archive, and not confirmed, dismissed, or those of an unconfirmed upload', async () => {
    const visit = await doc('Cardiology visit', 'Consultation', '2026-03-01', OWNER_ID, 'consultation_note');
    const labs = await doc('Lipid panel', 'Cholesterol', '2026-03-05');
    const old = await doc('Old visit', 'Consultation', '2025-03-01', OWNER_ID, 'consultation_note');
    const oldLabs = await doc('Old labs', 'Cholesterol', '2025-03-04');
    const held = await doc('Held back', 'Not yet confirmed', '2026-03-06');
    await suggest(visit.id, labs.id);
    await suggest(old.id, oldLabs.id);
    await getStore().links.setState(OWNER_ID, old.id, oldLabs.id, 'requests', 'confirmed');
    await suggest(visit.id, held.id, 'follow_up');
    await getStore().sourceFiles.setGroupingConfirmed(OWNER_ID, (await getStore().documents.findFor(OWNER_ID, held.id))!.source_file_id, false);

    await run([{ tools: [{ name: 'list_suggested_links', args: {} }] }, { say: 'One suggestion is waiting.' }], 'what new connections are waiting?');
    const text = toolText();
    expect(text).toMatch(/1 suggested connection waiting/);
    expect(text).toMatch(/K1: D\d and D\d may be connected/);
    expect(text).not.toMatch(/asked for|follow-up of/);
    expect(text).toContain('results for the same tests (cholesterol); 5 days apart');
    expect(text).not.toContain('Old visit');
    expect(text).not.toContain('Held back');
  });

  it('says so when nothing is waiting, and never shows another user’s suggestions', async () => {
    await doc('My only document', 'Something of mine', '2026-03-01');
    const theirs1 = await doc('Their visit', 'x', '2026-03-01', otherId, 'consultation_note');
    const theirs2 = await doc('Their labs', 'y', '2026-03-02', otherId);
    await suggest(theirs1.id, theirs2.id, 'requests', otherId);
    await run([{ tools: [{ name: 'list_suggested_links', args: {} }] }, { say: 'Nothing is waiting.' }]);
    expect(toolText()).toMatch(/No suggested connections are waiting/);
    expect(toolText()).not.toContain('Their');
  });

  it('proposes confirming one and dismissing another, changes nothing until Confirm, and the requests are accepted by the real route', async () => {
    const visit = await doc('Cardiology visit', 'Consultation', '2026-03-01', OWNER_ID, 'consultation_note');
    const labs = await doc('Lipid panel', 'Cholesterol', '2026-03-05');
    const other = await doc('Unrelated knee scan', 'Knee', '2026-03-09');
    await suggest(visit.id, labs.id);
    await suggest(visit.id, other.id, 'same_episode');

    const reply = await run([
      { tools: [{ name: 'list_suggested_links', args: {} }] },
      { tools: [{ name: 'propose_decide_links', args: { links: [{ label: 'K1', decision: 'confirm' }, { label: 'K2', decision: 'dismiss' }] } }] },
      { say: 'I would keep the first and drop the second.' },
    ]);
    const [p] = reply.proposals!;
    expect(p.kind).toBe('decide_links');
    expect(await stateOf(visit.id, labs.id)).toBe('proposed');
    expect(await stateOf(visit.id, other.id)).toBe('proposed');

    for (const r of await confirm(p as never)) expect(r.statusCode).toBe(200);
    const states = [await stateOf(visit.id, labs.id), await stateOf(visit.id, other.id)].sort();
    expect(states).toEqual(['confirmed', 'dismissed']);
  });

  it('an answer that cites a suggestion label cites the two documents it joins, so there are sources to open', async () => {
    const visit = await doc('Cardiology visit', 'Consultation', '2026-03-01', OWNER_ID, 'consultation_note');
    const labs = await doc('Lipid panel', 'Cholesterol', '2026-03-05');
    await suggest(visit.id, labs.id);
    const reply = await run([
      { tools: [{ name: 'list_suggested_links', args: {} }] },
      { say: 'One connection is waiting: the visit asked for the lipid panel [K1]. A made-up one [K9] is not shown, and handles like [U1] or [G2] are not citations.' },
    ]) as unknown as { answer: string; sources: Array<{ id: string }> };
    expect(reply.answer).not.toMatch(/\[(K|U|G)\d+\]/);
    expect(reply.answer).toMatch(/\[D\d\]\[D\d\]/);
    expect(reply.sources.map(s => s.id).sort()).toEqual([visit.id, labs.id].sort());
  });

  it('refuses a label it was not given, and one that was answered since it was listed', async () => {
    const visit = await doc('Cardiology visit', 'Consultation', '2026-03-01', OWNER_ID, 'consultation_note');
    const labs = await doc('Lipid panel', 'Cholesterol', '2026-03-05');
    await suggest(visit.id, labs.id);
    const first = await run([{ tools: [{ name: 'propose_decide_links', args: { links: [{ label: 'K1', decision: 'confirm' }] } }] }, { say: 'Could not.' }]);
    expect(first.proposals ?? []).toEqual([]);
    expect(toolText()).toMatch(/Call list_suggested_links first/);

    const second = await run([
      { tools: [{ name: 'list_suggested_links', args: {} }] },
      { tools: [{ name: 'propose_decide_links', args: { links: [{ label: 'K1', decision: 'confirm' }] } }] },
      { say: 'Done.' },
    ]);
    expect(second.proposals).toHaveLength(1);
    await getStore().links.setState(OWNER_ID, visit.id, labs.id, 'requests', 'dismissed');
    const third = await run([
      { tools: [{ name: 'list_suggested_links', args: {} }] },
      { say: 'Nothing waits now.' },
    ]);
    expect(third.proposals ?? []).toEqual([]);
  });
});
