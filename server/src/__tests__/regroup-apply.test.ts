import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { buildTestApp, loginSession } from './helpers/app.js';
import { OWNER_ID, createTestUser, seedPage, seedSourceFile, TEST_PASSWORD } from './helpers/seed.js';
import { getStore } from '../store/index.js';
import { planRegroup } from '../ingestion/regroup.js';
import { resetChatLlm, type ChatLlm } from '../llm/index.js';
import { resetRegroupJobs } from '../regroup/jobs.js';
import { ScriptedModel } from './helpers/scripted-model.js';

/**
 * Rearranging a mixed upload: the list work (pure), the transaction behind the route, and the analysis that finds the groups. The
 * text is invented; the model is a stand-in that knows which pages go together.
 */
describe('planRegroup', () => {
  const current = [{ documentId: 'X', pageIds: ['a1', 'd1', 'r1'] }, { documentId: 'Y', pageIds: ['a2', 'r2', 'd2', 'a3'] }];
  let n = 0;
  const fresh = () => `new${++n}`;

  it('keeps the identity of the document a group mostly is, makes new ones for the rest, and drops a document nothing kept', () => {
    const plan = planRegroup(current, [['a1', 'a2', 'a3'], ['d1', 'd2'], ['r1', 'r2']], fresh);
    expect(plan.groups.map(g => [g.documentId.startsWith('new') ? 'new' : g.documentId, g.pageIds.join(',')])).toEqual([
      ['new', 'a1,a2,a3'], ['new', 'd1,d2'], ['new', 'r1,r2'],
    ].map(([id, pages], i) => [i === 0 ? 'Y' : id, pages]));
    expect(plan.deleted).toEqual(['X']);
    expect(plan.touched).toHaveLength(3);
  });

  it('keeps what it was not told to move: the pages left in a document stay together, in their order', () => {
    const plan = planRegroup(current, [['a1', 'a2', 'a3']], fresh);
    expect(plan.groups.map(g => g.pageIds.join(','))).toEqual(['a1,a2,a3', 'd1,r1', 'r2,d2']);
    expect(plan.unchanged).toEqual([]);
  });

  it('changes nothing for a group a document already is', () => {
    const plan = planRegroup(current, [['a1', 'd1', 'r1']], fresh);
    expect(plan.groups.map(g => g.documentId)).toEqual(['X', 'Y']);
    expect(plan.touched).toEqual([]);
    expect(plan.unchanged).toEqual(['X', 'Y']);
  });

  it('refuses a page it does not know, a page twice, and an empty group', () => {
    expect(() => planRegroup(current, [['nope']], fresh)).toThrow(/not part of this upload/);
    expect(() => planRegroup(current, [['a1'], ['a1', 'a2']], fresh)).toThrow(/two groups/);
    expect(() => planRegroup(current, [[]], fresh)).toThrow(/no pages/);
  });
});

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;

beforeAll(async () => { app = await buildTestApp(); cookie = await loginSession(app); });
afterAll(async () => { await app.close(); });
beforeEach(async () => {
  for (const f of await getStore().sourceFiles.listFor(OWNER_ID)) await getStore().sourceFiles.delete(OWNER_ID, f.id);
  await getStore().conversations.removeAll(OWNER_ID);
  resetRegroupJobs();
});
afterEach(() => resetChatLlm());

const LAB = (n: number) => `Laborator Exemplu SRL Raport nr. LAB-2026-00417 Pagina ${n} din 3 Data recoltarii 12.03.2026 Hemoglobina 13.5 Leucocite 6.2 text suficient pentru a fi plasata ${n}`;
const DIS = (n: number) => `Spital Exemplu Foaie de externare ADM-884201 Pagina ${n} din 2 Internat 02.04.2026 externat 06.04.2026 diagnostic tratament recomandari ${n}`;
const RX = (n: number) => `Reteta electronica RX-5530917 pagina ${n} din 2 Emisa 20.05.2026 Medicina de familie Amoxicilina 500 mg tratament ${n}`;
const TRUTH: Record<string, string> = { a1: 'lab', a2: 'lab', a3: 'lab', d1: 'dis', d2: 'dis', r1: 'rx', r2: 'rx' };
const PAGES: Array<[string, string]> = [['a1', LAB(1)], ['d1', DIS(1)], ['r1', RX(1)], ['a2', LAB(2)], ['r2', RX(2)], ['d2', DIS(2)], ['a3', LAB(3)]];

/** The export as it came: seven mixed pages cut into two documents. */
async function mixedUpload(userId = OWNER_ID) {
  const upload = await seedSourceFile({ status: 'done', userId });
  const ids: Record<string, string> = {};
  for (const [i, [key, text]] of PAGES.entries()) ids[key] = await seedPage(upload, { userId, pageNumber: i + 1, rawText: text });
  const X = uuidv4(); const Y = uuidv4();
  await getStore().documents.create(userId, { id: X, sourceFileId: upload, pageStart: 1, pageEnd: 3, docType: 'other' });
  await getStore().documents.create(userId, { id: Y, sourceFileId: upload, pageStart: 4, pageEnd: 7, docType: 'other' });
  return { upload, ids, X, Y };
}
const keyOf = (ids: Record<string, string>) => Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
const post = (url: string, payload?: unknown, c = cookie) => app.inject({ method: 'POST', url, headers: { cookie: c }, payload: payload as object | undefined });

describe('POST /api/source-files/:id/regroup', () => {
  it('rearranges the pages in one go, renumbers them, and what was read from a page goes with it', async () => {
    const { upload, ids, X, Y } = await mixedUpload();
    const field = (pageKey: string, documentId: string) => getStore().fields.create(OWNER_ID, { id: uuidv4(), documentId, pageId: ids[pageKey], label: `on_${pageKey}`, value: 'v', sourceSnippet: null, bbox: null, confidence: 1 });
    await field('a1', X); await field('r2', Y);
    await getStore().measurements.create(OWNER_ID, { id: uuidv4(), documentId: Y, pageId: ids.a3, name: 'Hemoglobin', canonical: 'hemoglobin', valueText: '13.5', valueNum: 13.5, unit: 'g/dL', refLow: null, refHigh: null, flag: null, takenOn: '2026-03-12', sourceSnippet: null, bbox: null, confidence: 1 });
    await getStore().documents.update(OWNER_ID, Y, { reviewed: true });

    const res = await post(`/api/source-files/${upload}/regroup`, { groups: [[ids.a1, ids.a2, ids.a3], [ids.d1, ids.d2], [ids.r1, ids.r2]] });
    expect(res.statusCode).toBe(200);
    const result = res.json() as { touched: string[]; created: string[]; deleted: string[] };
    expect(result.deleted).toEqual([X]);
    expect(result.created).toHaveLength(2);
    expect(result.touched).toHaveLength(3);

    const docs = (await getStore().documents.listFor(OWNER_ID, { sourceFileId: upload, limit: 50, offset: 0, includeUnconfirmed: true })).sort((a, b) => a.page_start - b.page_start);
    expect(docs.map(d => [d.page_start, d.page_end])).toEqual([[1, 3], [4, 5], [6, 7]]);
    // The lab report is mostly what Y was, so it is Y: it kept its identity, and is unreviewed because its pages changed.
    expect(docs[0].id).toBe(Y);
    expect(docs.every(d => !d.reviewed)).toBe(true);

    const pages = await getStore().pages.listForSourceFile(OWNER_ID, upload);
    const order = keyOf(ids);
    expect(pages.sort((a, b) => a.page_number - b.page_number).map(p => order[p.id])).toEqual(['a1', 'a2', 'a3', 'd1', 'd2', 'r1', 'r2']);
    const fieldDoc = async (pageKey: string) => (await getStore().fields.listForDocument(OWNER_ID, docs.find(d => d.page_start <= pages.find(p => p.id === ids[pageKey])!.page_number && d.page_end >= pages.find(p => p.id === ids[pageKey])!.page_number)!.id)).map(f => f.label);
    expect(await fieldDoc('a1')).toContain('on_a1');
    expect(await fieldDoc('r2')).toContain('on_r2');
    expect(await fieldDoc('a3')).toEqual(expect.arrayContaining(['on_a1']));
    expect((await getStore().measurements.listForDocument(OWNER_ID, Y)).map(m => m.canonical)).toEqual(['hemoglobin']);
  });

  it('leaves the pages it was not told about where they were', async () => {
    const { upload, ids, X, Y } = await mixedUpload();
    const res = await post(`/api/source-files/${upload}/regroup`, { groups: [[ids.a1, ids.a2, ids.a3]] });
    expect(res.statusCode).toBe(200);
    const docs = (await getStore().documents.listFor(OWNER_ID, { sourceFileId: upload, limit: 50, offset: 0, includeUnconfirmed: true })).sort((a, b) => a.page_start - b.page_start);
    expect(docs).toHaveLength(3);
    expect(docs.map(d => d.page_end - d.page_start + 1)).toEqual([3, 2, 2]);
    expect([X, Y]).toContain(docs[0].id);
  });

  it('refuses what it should', async () => {
    const { upload, ids } = await mixedUpload();
    expect((await post(`/api/source-files/${upload}/regroup`, {})).statusCode).toBe(400);
    expect((await post(`/api/source-files/${upload}/regroup`, { groups: [['nope']] })).statusCode).toBe(400);
    expect((await post(`/api/source-files/${upload}/regroup`, { groups: [[ids.a1], [ids.a1]] })).statusCode).toBe(400);
    expect((await post(`/api/source-files/${upload}/regroup`, { groups: [[5]] })).statusCode).toBe(400);
    expect((await post(`/api/source-files/${uuidv4()}/regroup`, { groups: [[ids.a1]] })).statusCode).toBe(404);

    await getStore().sourceFiles.setStatus(OWNER_ID, upload, 'processing');
    expect((await post(`/api/source-files/${upload}/regroup`, { groups: [[ids.a1, ids.a2]] })).statusCode).toBe(409);
  });

  it('cannot rearrange another person’s upload, or use their pages', async () => {
    const mine = await mixedUpload();
    const other = await createTestUser('rearranger@spine.test');
    const theirs = await mixedUpload(other.id);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'rearranger@spine.test', password: TEST_PASSWORD } });
    const cookieB = login.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    expect((await post(`/api/source-files/${mine.upload}/regroup`, { groups: [[mine.ids.a1, mine.ids.a2]] }, cookieB)).statusCode).toBe(404);
    expect((await post(`/api/source-files/${theirs.upload}/regroup`, { groups: [[mine.ids.a1, mine.ids.a2]] }, cookieB)).statusCode).toBe(400);
    expect((await getStore().pages.listForSourceFile(OWNER_ID, mine.upload)).map(p => p.page_number).sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('analysing a mixed upload', () => {
  const kindOf = (label: string) => TRUTH[PAGES[Number(label.slice(1)) - 1][0]];
  const llm = (calls: string[][] = []): ChatLlm => ({
    judgeGrouping: async (pages: Array<{ id: string }>) => {
      calls.push(pages.map(p => p.id));
      const kinds = new Set(pages.map(p => kindOf(p.id)));
      return kinds.size === 1
        ? { coherent: true, confidence: 0.9, groups: [], order: pages.map(p => p.id), title: 'Report', reason: 'one report' }
        : { coherent: false, confidence: 0.9, groups: [...kinds].map(k => pages.filter(p => kindOf(p.id) === k).map(p => p.id)), order: [], title: null, reason: 'mixed' };
    },
  }) as unknown as ChatLlm;

  it('finds the groups in the background, keeps the plan, and tells the owner in a conversation of its own', async () => {
    const { upload, ids, X, Y } = await mixedUpload();
    // Page numbers are the labels the model sees (P1..P7); this stand-in answers from the order the pages were seeded in.
    const calls: string[][] = [];
    resetChatLlm(llm(calls));
    const started = await post(`/api/source-files/${upload}/regroup/analyze`);
    expect(started.statusCode).toBe(202);

    await vi.waitFor(async () => expect((await app.inject({ method: 'GET', url: `/api/source-files/${upload}/regroup`, headers: { cookie } })).json().job.status).toBe('done'));
    const body = (await app.inject({ method: 'GET', url: `/api/source-files/${upload}/regroup`, headers: { cookie } })).json();
    expect(body.plan.model_calls).toBe(calls.length);
    expect(body.plan.groups.map((g: { page_ids: string[] }) => g.page_ids.map(id => keyOf(ids)[id]).join(',')).sort()).toEqual(['a1,a2,a3', 'd1,d2', 'r1,r2']);
    expect(body.plan.groups.every((g: { from_documents: string[] }) => g.from_documents.every(d => [X, Y].includes(d)))).toBe(true);
    // The page text is not in the plan.
    expect(JSON.stringify(body.plan)).not.toMatch(/Laborator|Spital|Reteta/);

    await vi.waitFor(async () => expect((await getStore().conversations.list(OWNER_ID, 5)).some(c => c.origin === 'regroup')).toBe(true));
    const [c] = (await getStore().conversations.list(OWNER_ID, 5));
    expect(c).toMatchObject({ title: 'Regrouping suggestions', unread: true });

    // Applying it drops the plan: its page ids no longer mean the same.
    const groups = body.plan.groups.map((g: { page_ids: string[] }) => g.page_ids);
    expect((await post(`/api/source-files/${upload}/regroup`, { groups })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/source-files/${upload}/regroup`, headers: { cookie } })).json().plan).toBeNull();
  });

  it('says so when the model fails, and does not run twice at once', async () => {
    const { upload } = await mixedUpload();
    let release: () => void = () => undefined;
    const gate = new Promise<void>(r => { release = r; });
    resetChatLlm({ judgeGrouping: async () => { await gate; return null; } } as unknown as ChatLlm);
    const first = await post(`/api/source-files/${upload}/regroup/analyze`);
    const second = await post(`/api/source-files/${upload}/regroup/analyze`);
    expect(first.statusCode).toBe(202); expect(second.statusCode).toBe(202);
    expect(second.json().started_at).toBe(first.json().started_at);
    release();
    await vi.waitFor(async () => expect((await app.inject({ method: 'GET', url: `/api/source-files/${upload}/regroup`, headers: { cookie } })).json().job.status).toBe('done'));
    // No verdicts: every group is unchecked and none is offered as confirmed.
    const { plan } = (await app.inject({ method: 'GET', url: `/api/source-files/${upload}/regroup`, headers: { cookie } })).json();
    expect(plan.groups.every((g: { status: string }) => g.status === 'unchecked')).toBe(true);
  });

  it('is the owner’s own upload only', async () => {
    const other = await createTestUser('analyser@spine.test');
    const theirs = await mixedUpload(other.id);
    expect((await post(`/api/source-files/${theirs.upload}/regroup/analyze`)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/source-files/${theirs.upload}/regroup`, headers: { cookie } })).statusCode).toBe(404);
  });
});

describe('from the chat', () => {
  const kindOf = (label: string) => TRUTH[PAGES[Number(label.slice(1)) - 1][0]];
  const judge = async (pages: Array<{ id: string }>) => {
    const kinds = new Set(pages.map(p => kindOf(p.id)));
    return kinds.size === 1
      ? { coherent: true, confidence: 0.9, groups: [], order: pages.map(p => p.id), title: 'Report', reason: 'one report' }
      : { coherent: false, confidence: 0.9, groups: [...kinds].map(k => pages.filter(p => kindOf(p.id) === k).map(p => p.id)), order: [], title: null, reason: 'mixed' };
  };
  const ask = (model: ScriptedModel, question: string) => {
    resetChatLlm({ agentModel: () => model, answerQuestion: async () => null, judgeGrouping: judge } as unknown as ChatLlm);
    return app.inject({ method: 'POST', url: '/api/chat', headers: { cookie }, payload: { question, screen: { page: 'upload' } } });
  };

  it('sorts out a mixed export: propose the analysis, read the plan when it is ready, propose the groups, confirm', async () => {
    const { upload, ids } = await mixedUpload();

    // 1. The person says the pages are mixed. The assistant proposes an analysis; nothing runs until they confirm.
    const first = await ask(new ScriptedModel([
      { tools: [{ name: 'list_uploads', args: {} }] },
      { tools: [{ name: 'propose_analyse_pages', args: { upload: 'U1' } }] },
      { say: 'I can sort the pages out; confirm to start.' },
    ]), 'the pages of this export are all mixed up, can you sort them?');
    const analyse = first.json().proposals[0] as { kind: string; pages: number; calls: Array<{ method: string; path: string }> };
    expect(analyse).toMatchObject({ kind: 'analyse_pages', pages: 7 });
    expect(await getStore().regroupPlans.get(OWNER_ID, upload)).toBeNull();
    expect((await post(analyse.calls[0].path)).statusCode).toBe(202);
    await vi.waitFor(async () => expect((await getStore().regroupPlans.get(OWNER_ID, upload))).not.toBeNull());

    // 2. The plan is ready (the app tells them); they ask what it found, and the assistant proposes the groups.
    const model = new ScriptedModel([
      { tools: [{ name: 'list_uploads', args: {} }] },
      { tools: [{ name: 'get_regroup_plan', args: { upload: 'U1' } }] },
      { tools: [{ name: 'propose_regroup', args: { upload: 'U1', groups: ['G1', 'G2', 'G3', 'G9'] } }, { name: 'propose_regroup', args: { upload: 'U1', groups: ['G1', 'G2', 'G3'] } }] },
      { say: 'Three documents found.' },
    ]);
    const second = await ask(model, 'what did you find?');
    const seen = model.seen.at(-1)!.filter(m => m.getType() === 'tool').map(m => String(m.content)).join('\n');
    expect(seen).toMatch(/G1: pages 1, 4, 7 — validated/);
    expect(seen).toMatch(/G2: pages 2, 6 — validated/);
    expect(seen).toMatch(/No group G9/);
    expect(seen).not.toMatch(/Laborator|Spital|Reteta/);
    const proposal = second.json().proposals[0] as { kind: string; upload: { id: string }; groups: Array<{ label: string; page_ids: string[]; status: string }> };
    expect(second.json().proposals).toHaveLength(1);
    expect(proposal.kind).toBe('regroup');
    expect(proposal.groups.map(g => g.page_ids.map(id => keyOf(ids)[id]).join(','))).toEqual(['a1,a2,a3', 'd1,d2', 'r1,r2']);
    expect(proposal.groups.every(g => g.status === 'validated')).toBe(true);
    // Still nothing changed.
    expect((await getStore().pages.listForSourceFile(OWNER_ID, upload)).map(p => p.page_number).sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect((await getStore().documents.listFor(OWNER_ID, { sourceFileId: upload, limit: 10, offset: 0, includeUnconfirmed: true }))).toHaveLength(2);

    // 3. Confirm, as the card does: the groups it kept, to the ordinary route.
    const applied = await post(`/api/source-files/${proposal.upload.id}/regroup`, { groups: proposal.groups.map(g => g.page_ids) });
    expect(applied.statusCode).toBe(200);
    expect((await getStore().documents.listFor(OWNER_ID, { sourceFileId: upload, limit: 10, offset: 0, includeUnconfirmed: true }))).toHaveLength(3);
  });

  it('refuses a plan that is out of date, and an upload it was not shown', async () => {
    const { upload } = await mixedUpload();
    resetChatLlm({ judgeGrouping: judge } as unknown as ChatLlm);
    const analysed = await post(`/api/source-files/${upload}/regroup/analyze`);
    expect(analysed.statusCode).toBe(202);
    await vi.waitFor(async () => expect(await getStore().regroupPlans.get(OWNER_ID, upload)).not.toBeNull());
    // The upload is read again: its pages are new, the plan is gone, and the assistant is told there is none.
    await getStore().sourceFiles.clearDerived(OWNER_ID, upload);
    const model = new ScriptedModel([
      { tools: [{ name: 'list_uploads', args: {} }] },
      { tools: [{ name: 'get_regroup_plan', args: { upload: 'U1' } }, { name: 'get_regroup_plan', args: { upload: 'U7' } }] },
      { say: 'none' },
    ]);
    const res = await ask(model, 'what did you find?');
    expect(res.json().proposals).toBeUndefined();
    const seen = model.seen.at(-1)!.filter(m => m.getType() === 'tool').map(m => String(m.content)).join('\n');
    expect(seen).toMatch(/There is no analysis of U1/);
    expect(seen).toMatch(/no upload U7/);
  });
});
