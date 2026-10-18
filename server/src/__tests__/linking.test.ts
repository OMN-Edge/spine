import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { buildTestApp, loginAs, loginSession } from './helpers/app.js';
import { OWNER_ID, createTestUser, seedDocument, seedPage, seedSourceFile } from './helpers/seed.js';
import { getStore } from '../store/index.js';
import { resetChatLlm, type ChatLlm } from '../llm/index.js';
import type { LinkCard, LinkJudgement, LinkRelation } from '../llm/types.js';
import { chainOf, findLinks, linkFromRelation, settleLinking } from '../linking/index.js';
import type { Document } from '../types.js';

/**
 * Care chains: who is a candidate (no model), what the model is shown, how its answer becomes links, what the owner's
 * decisions do to later searches, and that none of it crosses to another person. The model is a stand-in that answers with
 * one relation for every candidate it is shown.
 */
const calls: Array<{ target: LinkCard; candidates: LinkCard[] }> = [];
let relation: LinkRelation | null = 'candidate_requested_target';
let broken = false;
const fakeLlm = {
  link: async (target: LinkCard, candidates: LinkCard[]): Promise<LinkJudgement[] | null> => {
    calls.push({ target, candidates });
    if (broken) return null;
    return relation ? candidates.map(c => ({ candidate: c.id, relation: relation!, reason: 'Asked for these tests.' })) : [];
  },
} as unknown as ChatLlm;

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
let otherCookie: string;
let otherId: string;
const savedLinking = process.env.SPINE_LINKING;
beforeAll(async () => {
  app = await buildTestApp();
  cookie = await loginSession(app);
  const other = await createTestUser('other@spine.test');
  otherId = other.id;
  otherCookie = await loginAs(app, other.email, other.password);
});
afterAll(async () => { await app.close(); });
beforeEach(async () => {
  calls.length = 0; relation = 'candidate_requested_target'; broken = false; resetChatLlm(fakeLlm);
  // Every test starts from an empty archive for both people.
  for (const userId of [OWNER_ID, otherId]) {
    for (const f of await getStore().sourceFiles.listFor(userId)) await getStore().sourceFiles.delete(userId, f.id);
  }
});
afterEach(() => {
  resetChatLlm();
  if (savedLinking === undefined) delete process.env.SPINE_LINKING; else process.env.SPINE_LINKING = savedLinking;
});

const get = (url: string, who = cookie) => app.inject({ method: 'GET', url, headers: { cookie: who } });
const post = (url: string, payload: unknown, who = cookie) => app.inject({ method: 'POST', url, payload: payload as object, headers: { cookie: who } });

async function doc(title: string, docType: Document['doc_type'], docDate: string | null, userId = OWNER_ID) {
  const d = await seedDocument({ userId, docType: docType ?? 'other', docDate, provider: null, aiSummary: `${title} summary` });
  await getStore().documents.update(userId, d.id, { title });
  return d;
}
const asDocument = async (id: string, userId = OWNER_ID) => (await getStore().documents.findFor(userId, id))!;
const linksOf = async (id: string, userId = OWNER_ID) => getStore().links.forDocument(userId, id);

/** A consultation and a blood test five weeks later, with nothing else in common. */
async function consultAndLab(userId = OWNER_ID) {
  const consult = await doc('Cardiology visit', 'consultation_note', '2026-03-02', userId);
  const lab = await doc('Blood count', 'lab_result', '2026-04-06', userId);
  return { consult, lab };
}

describe('candidates', () => {
  it('makes no model call when nothing could be linked', async () => {
    const a = await doc('Lonely note', 'consultation_note', '2026-03-02');
    // A lab far outside the window of a consultation, and one document of an unrelated type close by.
    await doc('Old lab', 'lab_result', '2020-01-01');
    await doc('Vaccine', 'vaccination', '2026-03-03');
    expect(await findLinks(OWNER_ID, a.id)).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('offers an examination soon after a consultation, and the consultation to the examination', async () => {
    const { consult, lab } = await consultAndLab();
    await findLinks(OWNER_ID, consult.id);
    expect(calls).toHaveLength(1);
    expect(calls[0].candidates).toHaveLength(1);
    expect(calls[0].candidates[0].text).toContain('Blood count');
    await findLinks(OWNER_ID, lab.id);
    expect(calls[1].candidates[0].text).toContain('Cardiology visit');
  });

  it('does not offer an examination before the consultation that would have asked for it', async () => {
    const consult = await doc('Late visit', 'consultation_note', '2026-03-02');
    await doc('Early lab', 'lab_result', '2026-02-20');
    await findLinks(OWNER_ID, consult.id);
    expect(calls).toHaveLength(0);
  });

  it('shows the model cards with doctors’ roles, not database ids or page text', async () => {
    const { consult, lab } = await consultAndLab();
    const doctor = (await getStore().doctors.upsert(OWNER_ID, { name: 'Ion Popescu', specialty: 'cardiology' }, '2026-01-01'))!;
    await getStore().doctors.link(OWNER_ID, consult.id, doctor, 'referrer');
    await findLinks(OWNER_ID, consult.id);
    const sent = JSON.stringify(calls[0]);
    expect(calls[0].target.text).toContain('referrer: Ion Popescu');
    expect(sent).not.toContain(consult.id);
    expect(sent).not.toContain(lab.id);
    expect(calls[0].candidates.map(c => c.id)).toEqual(['1']);
  });

  it('never offers another person’s documents, or documents the owner set aside', async () => {
    const consult = await doc('Cardiology visit', 'consultation_note', '2026-03-02');
    await doc('Someone else’s lab', 'lab_result', '2026-03-10', otherId);
    const hidden = await doc('Hidden lab', 'lab_result', '2026-03-11');
    await getStore().pages.setHiddenForDocument(OWNER_ID, hidden.id, true);
    await findLinks(OWNER_ID, consult.id);
    expect(calls).toHaveLength(0);
  });

  it('offers at most six', async () => {
    const consult = await doc('Visit', 'consultation_note', '2026-03-02');
    for (let i = 0; i < 9; i++) await doc(`Lab ${i}`, 'lab_result', `2026-03-${String(3 + i).padStart(2, '0')}`);
    await findLinks(OWNER_ID, consult.id);
    // Temporal candidates alone are capped lower still: the nearest few.
    expect(calls[0].candidates.length).toBeLessThanOrEqual(6);
    expect(calls[0].candidates.length).toBeGreaterThan(0);
  });
});

describe('the model’s answer', () => {
  it('drops a candidate label the model made up, and trims what it keeps', async () => {
    const { buildChatLlm } = await import('../llm/chat-llm.js');
    const { RunnableLambda } = await import('@langchain/core/runnables');
    const answer = { links: [
      { candidate: ' 1 ', relation: 'same_episode', reason: ' one episode ' },
      { candidate: '9', relation: 'same_episode', reason: 'no such candidate' },
    ] };
    const silent = RunnableLambda.from(async () => answer);
    const clients = Object.fromEntries(['continuation', 'extraction', 'page', 'pageThinking', 'stamps', 'translation', 'linking'].map(t => [t, silent]));
    const llm = buildChatLlm(clients as never, { provider: 'x', model: 'y', maxTokens: { continuation: 1, extraction: 1, page: 1 }, maxRetries: 0, contextChars: 1000, logger: { info() {}, warn() {} } });
    expect(await llm.link({ id: 'target', text: 't' }, [{ id: '1', text: 'c' }])).toEqual([{ candidate: '1', relation: 'same_episode', reason: 'one episode' }]);
    expect(await llm.link({ id: 'target', text: 't' }, [])).toEqual([]);
  });
});

describe('turning an answer into links', () => {
  const d = (id: string, date: string | null): Document => ({ id, doc_date: date } as Document);
  const earlier = d('a', '2026-01-01'); const later = d('b', '2026-02-01');

  it('puts the asking or followed-up document first', () => {
    expect(linkFromRelation('candidate_requested_target', later, earlier)).toMatchObject({ kind: 'requests', from: earlier, to: later });
    expect(linkFromRelation('target_requested_candidate', earlier, later)).toMatchObject({ kind: 'requests', from: earlier, to: later });
    expect(linkFromRelation('target_follows_up_candidate', later, earlier)).toMatchObject({ kind: 'follow_up', from: earlier, to: later });
    expect(linkFromRelation('candidate_follows_up_target', earlier, later)).toMatchObject({ kind: 'follow_up', from: earlier, to: later });
  });

  it('drops a request or a follow-up that runs backwards in time', () => {
    expect(linkFromRelation('candidate_requested_target', earlier, later)).toBeNull();
    expect(linkFromRelation('target_follows_up_candidate', earlier, later)).toBeNull();
  });

  it('stores an episode once, earlier first, whichever way it was found', () => {
    expect(linkFromRelation('same_episode', later, earlier)).toMatchObject({ kind: 'same_episode', from: earlier, to: later });
    expect(linkFromRelation('same_episode', earlier, later)).toMatchObject({ kind: 'same_episode', from: earlier, to: later });
    expect(linkFromRelation('same_episode', d('z', null), d('y', null))?.from.id).toBe('y');
  });

  it('keeps an undated request, since nothing contradicts it', () => {
    expect(linkFromRelation('candidate_requested_target', d('t', null), earlier)).toMatchObject({ kind: 'requests' });
  });
});

describe('finding links', () => {
  it('proposes what the model finds, from the earlier document to the later one', async () => {
    const { consult, lab } = await consultAndLab();
    expect(await findLinks(OWNER_ID, lab.id)).toBe(1);
    expect(await linksOf(lab.id)).toEqual([{
      from_document_id: consult.id, to_document_id: lab.id, kind: 'requests', source: 'auto', state: 'proposed', reason: 'Asked for these tests.', confidence: null,
    }]);
  });

  it('drops a relation that contradicts the dates', async () => {
    const { consult } = await consultAndLab();
    // The consultation as target: "the candidate requested the target" would have the lab ask for the visit.
    relation = 'candidate_requested_target';
    expect(await findLinks(OWNER_ID, consult.id)).toBe(0);
    expect(await linksOf(consult.id)).toEqual([]);
  });

  it('replaces its earlier proposals on a new search, and keeps the owner’s decisions', async () => {
    const { consult, lab } = await consultAndLab();
    const other = await doc('Second lab', 'lab_result', '2026-04-10');
    relation = 'target_requested_candidate';
    expect(await findLinks(OWNER_ID, consult.id)).toBe(2);
    await getStore().links.setState(OWNER_ID, consult.id, lab.id, 'requests', 'confirmed');
    await getStore().links.setState(OWNER_ID, consult.id, other.id, 'requests', 'dismissed');

    relation = 'same_episode';
    await findLinks(OWNER_ID, consult.id);
    const states = Object.fromEntries((await linksOf(consult.id)).map(l => [`${l.to_document_id === lab.id ? 'lab' : 'other'}:${l.kind}`, l.state]));
    // The confirmed request stays, the dismissed one stays dismissed, and no episode is proposed for the dismissed pair.
    expect(states).toMatchObject({ 'lab:requests': 'confirmed', 'lab:same_episode': 'proposed' });
    expect(states['other:same_episode']).toBeUndefined();
    expect((await linksOf(consult.id)).find(l => l.to_document_id === other.id)?.state).toBe('dismissed');
  });

  it('never proposes a dismissed pair again, and does not ask the model about it', async () => {
    const { consult, lab } = await consultAndLab();
    relation = 'target_requested_candidate';
    await findLinks(OWNER_ID, consult.id);
    await getStore().links.setState(OWNER_ID, consult.id, lab.id, 'requests', 'dismissed');
    calls.length = 0;
    expect(await findLinks(OWNER_ID, consult.id)).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('keeps the earlier proposals when the model could not answer', async () => {
    const { consult } = await consultAndLab();
    relation = 'target_requested_candidate';
    await findLinks(OWNER_ID, consult.id);
    broken = true;
    expect(await findLinks(OWNER_ID, consult.id)).toBe(0);
    expect(await linksOf(consult.id)).toHaveLength(1);
  });

  it('replaces only the pairs it judged again: another pair’s suggestion stays, and a pair judged unrelated goes', async () => {
    const consult = await doc('Cardiology visit', 'consultation_note', '2026-03-02');
    const lab1 = await doc('Blood count', 'lab_result', '2026-04-06');
    const lab2 = await doc('Lipids', 'lab_result', '2026-04-10');
    relation = 'target_requested_candidate';
    expect(await findLinks(OWNER_ID, consult.id)).toBe(2);

    // The first lab is searched on its own: the consultation is its only candidate, and the second lab is not looked at.
    relation = 'candidate_requested_target';
    await findLinks(OWNER_ID, lab1.id);
    expect((await linksOf(lab2.id)).map(l => [l.from_document_id, l.state])).toEqual([[consult.id, 'proposed']]);

    // Judged unrelated this time, the first pair's suggestion is gone and the other pair's is still there.
    relation = null;
    await findLinks(OWNER_ID, lab1.id);
    expect(await linksOf(lab1.id)).toEqual([]);
    expect(await linksOf(lab2.id)).toHaveLength(1);
  });

  it('never loses a link the owner confirmed, whichever document is searched or what the model says', async () => {
    const { consult, lab } = await consultAndLab();
    await post('/api/document-links', { from: consult.id, to: lab.id, kind: 'requests' });
    relation = null;
    await findLinks(OWNER_ID, lab.id);
    await findLinks(OWNER_ID, consult.id);
    relation = 'same_episode';
    await findLinks(OWNER_ID, lab.id);
    expect((await linksOf(lab.id)).find(l => l.kind === 'requests')).toMatchObject({ source: 'owner', state: 'confirmed' });
  });

  it('shows the model the owner’s notes, trimmed', async () => {
    const { consult, lab } = await consultAndLab();
    await getStore().documents.update(OWNER_ID, lab.id, { user_notes: `Asked for after the March visit.\n${'x'.repeat(2000)}` });
    await findLinks(OWNER_ID, consult.id);
    const text = calls[0].candidates[0].text;
    expect(text).toContain("owner's notes: Asked for after the March visit.");
    expect(text.length).toBeLessThan(2400 + 900);
  });

  it('does nothing when linking is switched off, and still lets the owner add a link', async () => {
    process.env.SPINE_LINKING = 'off';
    const { consult, lab } = await consultAndLab();
    expect(await findLinks(OWNER_ID, consult.id)).toBe(0);
    expect(calls).toHaveLength(0);
    expect((await post('/api/document-links', { from: consult.id, to: lab.id, kind: 'requests' })).statusCode).toBe(201);
    const chain = (await get(`/api/documents/${consult.id}/chain`)).json();
    expect(chain.enabled).toBe(false);
    expect(chain.edges).toHaveLength(1);
    expect((await post(`/api/documents/${consult.id}/chain/refresh`, {})).statusCode).toBe(409);
  });

  it('runs in the background for the documents it is told about', async () => {
    const { consult } = await consultAndLab();
    const { scheduleLinking } = await import('../linking/index.js');
    relation = 'target_requested_candidate';
    scheduleLinking(OWNER_ID, [consult.id]);
    await settleLinking(OWNER_ID);
    expect(await linksOf(consult.id)).toHaveLength(1);
  });
});

describe('the chain', () => {
  it('is the connected documents, by date, without dismissed links', async () => {
    const a = await doc('Visit', 'consultation_note', '2026-03-02');
    const b = await doc('Lab', 'lab_result', '2026-03-20');
    const c = await doc('Control visit', 'consultation_note', '2026-06-01');
    const stray = await doc('Unrelated', 'other', '2026-05-01');
    const store = getStore();
    const now = '2026-07-01T00:00:00Z';
    await store.links.add(OWNER_ID, { from_document_id: a.id, to_document_id: b.id, kind: 'requests', source: 'auto', state: 'proposed', reason: 'r' }, now);
    await store.links.add(OWNER_ID, { from_document_id: b.id, to_document_id: c.id, kind: 'follow_up', source: 'owner', state: 'confirmed', reason: null }, now);
    await store.links.add(OWNER_ID, { from_document_id: stray.id, to_document_id: c.id, kind: 'follow_up', source: 'auto', state: 'dismissed', reason: null }, now);

    // From the middle of the chain, the whole of it.
    const chain = (await chainOf(OWNER_ID, b.id))!;
    expect(chain.nodes.map(n => n.id)).toEqual([a.id, b.id, c.id]);
    expect(chain.edges.map(e => [e.kind, e.state])).toEqual(expect.arrayContaining([['requests', 'proposed'], ['follow_up', 'confirmed']]));
    expect(chain.edges).toHaveLength(2);
  });

  it('is capped', async () => {
    const hub = await doc('Hub', 'consultation_note', '2026-01-01');
    for (let i = 0; i < 40; i++) {
      const d = await doc(`Spoke ${i}`, 'lab_result', '2026-02-01');
      await getStore().links.add(OWNER_ID, { from_document_id: hub.id, to_document_id: d.id, kind: 'requests', source: 'owner', state: 'confirmed', reason: null }, '2026-07-01T00:00:00Z');
    }
    expect((await chainOf(OWNER_ID, hub.id))!.nodes.length).toBeLessThanOrEqual(30);
  });

  it('answers 404 for a document that is not the caller’s, in the chain and in every route', async () => {
    const mine = await doc('Mine', 'consultation_note', '2026-03-02');
    const theirs = await doc('Theirs', 'lab_result', '2026-03-05', otherId);
    expect((await get(`/api/documents/${theirs.id}/chain`)).statusCode).toBe(404);
    expect((await post('/api/document-links', { from: mine.id, to: theirs.id, kind: 'requests' })).statusCode).toBe(404);
    expect((await post(`/api/documents/${theirs.id}/chain/refresh`, {})).statusCode).toBe(404);
    expect(await linksOf(mine.id)).toEqual([]);
    expect(await linksOf(theirs.id, otherId)).toEqual([]);
  });

  it('lets the owner add, confirm, dismiss, and add a dismissed pair back', async () => {
    const { consult, lab } = await consultAndLab();
    const body = { from: consult.id, to: lab.id, kind: 'requests' };
    expect((await post('/api/document-links', body)).statusCode).toBe(201);
    expect((await linksOf(lab.id))[0]).toMatchObject({ source: 'owner', state: 'confirmed' });

    expect((await post('/api/document-links/state', { ...body, state: 'dismissed' })).statusCode).toBe(200);
    expect((await get(`/api/documents/${lab.id}/chain`)).json().edges).toEqual([]);

    expect((await post('/api/document-links', body)).statusCode).toBe(201);
    expect((await linksOf(lab.id))[0]).toMatchObject({ source: 'owner', state: 'confirmed' });
  });

  it('stores a hand-added episode once, whichever way round it was added', async () => {
    const { consult, lab } = await consultAndLab();
    await post('/api/document-links', { from: lab.id, to: consult.id, kind: 'same_episode' });
    await post('/api/document-links', { from: consult.id, to: lab.id, kind: 'same_episode' });
    expect(await linksOf(lab.id)).toMatchObject([{ from_document_id: consult.id, to_document_id: lab.id, kind: 'same_episode' }]);
  });

  it('refuses malformed bodies, a link to itself, and a state change on nothing', async () => {
    const { consult, lab } = await consultAndLab();
    expect((await post('/api/document-links', { from: consult.id, to: lab.id, kind: 'bogus' })).statusCode).toBe(400);
    expect((await post('/api/document-links', { from: consult.id })).statusCode).toBe(400);
    expect((await post('/api/document-links', { from: consult.id, to: consult.id, kind: 'requests' })).statusCode).toBe(404);
    expect((await post('/api/document-links/state', { from: consult.id, to: lab.id, kind: 'requests', state: 'confirmed' })).statusCode).toBe(404);
    expect((await post('/api/document-links/state', { from: consult.id, to: lab.id, kind: 'requests', state: 'proposed' })).statusCode).toBe(400);
  });

  it('cannot be decided on by someone else', async () => {
    const { consult, lab } = await consultAndLab();
    await post('/api/document-links', { from: consult.id, to: lab.id, kind: 'requests' });
    const res = await post('/api/document-links/state', { from: consult.id, to: lab.id, kind: 'requests', state: 'dismissed' }, otherCookie);
    expect(res.statusCode).toBe(404);
    expect((await linksOf(lab.id))[0].state).toBe('confirmed');
  });

  it('needs a session', async () => {
    const { consult } = await consultAndLab();
    expect((await app.inject({ method: 'GET', url: `/api/documents/${consult.id}/chain` })).statusCode).toBe(401);
  });

  it('queues a search on refresh', async () => {
    const { consult } = await consultAndLab();
    expect((await post(`/api/documents/${consult.id}/chain/refresh`, {})).statusCode).toBe(202);
    await settleLinking(OWNER_ID);
  });
});

describe('when it starts', () => {
  it('starts when the owner marks a document reviewed, and not when only other things are edited', async () => {
    const { lab } = await consultAndLab();
    relation = 'candidate_requested_target';
    expect((await app.inject({ method: 'PATCH', url: `/api/documents/${lab.id}`, payload: { title: 'Blood count (edited)' }, headers: { cookie } })).statusCode).toBe(200);
    await settleLinking(OWNER_ID);
    expect(calls).toHaveLength(0);

    expect((await app.inject({ method: 'PATCH', url: `/api/documents/${lab.id}`, payload: { reviewed: true }, headers: { cookie } })).statusCode).toBe(200);
    await settleLinking(OWNER_ID);
    expect(calls).toHaveLength(1);
    expect(await linksOf(lab.id)).toHaveLength(1);
  });
});

describe('reading a document again', () => {
  it('sends the owner’s notes with the text and keeps them afterwards', async () => {
    const seen: Array<string | null | undefined> = [];
    resetChatLlm({
      extractFields: async (_text: string, _tests?: string[], _tags?: string[], notes?: string | null) => {
        seen.push(notes);
        return { title: 'T', doc_date: '2026-03-02', provider: null, doc_type: 'consultation_note', ai_summary: 's', suggested_tags: [], doctors: [], fields: [], measurements: [] };
      },
    } as unknown as ChatLlm);
    const sf = await seedSourceFile({ status: 'done' });
    await seedPage(sf, { pageNumber: 1, rawText: 'Consultatie cardiologie' });
    const d = await seedDocument({ sourceFileId: sf, withPage: false });
    await getStore().documents.update(OWNER_ID, d.id, { user_notes: 'Asked for after the March visit' });
    const { rereadDocument } = await import('../ingestion/document-reading.js');
    expect(await rereadDocument(OWNER_ID, d.id)).toBe(true);
    expect(seen).toEqual(['Asked for after the March visit']);
    expect((await asDocument(d.id)).user_notes).toBe('Asked for after the March visit');
    await settleLinking(OWNER_ID);
  });
});

describe('deleting', () => {
  it('removes a document’s links with it, and an upload’s with the upload', async () => {
    const { consult, lab } = await consultAndLab();
    const store = getStore();
    await store.links.add(OWNER_ID, { from_document_id: consult.id, to_document_id: lab.id, kind: 'requests', source: 'owner', state: 'confirmed', reason: null }, '2026-07-01T00:00:00Z');
    await store.documents.delete(OWNER_ID, lab.id);
    expect(await linksOf(consult.id)).toEqual([]);

    const again = await doc('Another lab', 'lab_result', '2026-04-07');
    await store.links.add(OWNER_ID, { from_document_id: consult.id, to_document_id: again.id, kind: 'requests', source: 'owner', state: 'confirmed', reason: null }, '2026-07-01T00:00:00Z');
    expect(await store.sourceFiles.delete(OWNER_ID, again.sourceFileId)).toBe(true);
    expect(await linksOf(consult.id)).toEqual([]);
  });

  it('is part of deleting an account', async () => {
    const user = await createTestUser('leaving@spine.test');
    const { consult, lab } = await consultAndLab(user.id);
    await getStore().links.add(user.id, { from_document_id: consult.id, to_document_id: lab.id, kind: 'requests', source: 'owner', state: 'confirmed', reason: null }, '2026-07-01T00:00:00Z');
    await getStore().users.delete(user.id);
    expect(await getStore().users.findByEmail('leaving@spine.test')).toBeNull();
  });
});
