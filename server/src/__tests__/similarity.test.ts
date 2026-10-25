import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { buildTestApp, loginAs, loginSession } from './helpers/app.js';
import { OWNER_ID, createTestUser, seedDocument } from './helpers/seed.js';
import { getStore } from 'spine-core/store/index.js';
import { resetEmbedder, createEmbedder, type Embedder, type EmbedKind } from 'spine-core/embedding/index.js';
import { createVertexEmbedder } from 'spine-core/embedding/adapters/vertex.js';
import { loadEmbeddingConfig } from 'spine-core/config.js';
import { embeddingStatus, hybridSearch, relatedTo, searchByMeaning, settleSync, similarTo, syncEmbeddings } from 'spine-core/similarity/index.js';

/**
 * A stand-in for a model: words hashed into a small vector, so texts that share words are close. Enough to prove the
 * plumbing (what is embedded, when it is stale, what is compared with what); whether a real model finds the right things
 * is for the real model.
 */
const DIMS = 64;
const embedCalls: Array<{ texts: string[]; kind: EmbedKind }> = [];
function fake(id = 'fake:v1'): Embedder {
  return {
    enabled: true, id, dims: DIMS,
    async embed(texts, kind) {
      embedCalls.push({ texts, kind });
      return texts.map(text => {
        const v = new Float32Array(DIMS);
        // One synonym, so a likeness the words alone would miss can be tested.
        for (const w of text.toLowerCase().replace(/redusa|redus/g, 'scazuta').match(/[a-zăâîșț]{3,}/g) ?? []) {
          let h = 0; for (const c of w) h = (h * 31 + c.charCodeAt(0)) % DIMS;
          v[h] += 1;
        }
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map(x => x / norm) as Float32Array;
      });
    },
  };
}

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
let otherCookie: string;
let otherId: string;
beforeAll(async () => {
  app = await buildTestApp();
  cookie = await loginSession(app);
  const other = await createTestUser('other@spine.test');
  otherId = other.id;
  otherCookie = await loginAs(app, other.email, other.password);
});
afterAll(async () => { await app.close(); });
beforeEach(() => { embedCalls.length = 0; resetEmbedder(fake()); });
afterEach(() => resetEmbedder());

async function doc(title: string, summary: string, userId = OWNER_ID, extra: Parameters<typeof seedDocument>[0] = {}) {
  const d = await seedDocument({ userId, aiSummary: summary, provider: null, ...extra });
  await getStore().documents.update(userId, d.id, { title });
  return d;
}
const get = (url: string, who = cookie) => app.inject({ method: 'GET', url, headers: { cookie: who } });

describe('the Vertex embedder', () => {
  const config = { adapter: 'vertex', model: 'gemini-embedding-001', dims: 4, endpoint: 'aiplatform.eu.rep.googleapis.com', region: 'eu', project: 'p1' };
  const answer = (values: number[]) => async () => new Response(JSON.stringify({ predictions: [{ embeddings: { values } }] }), { status: 200 });

  it('calls the stated endpoint, region and project, with the task type, and returns unit vectors', async () => {
    const seen: Array<{ url: string; body: any; auth: string }> = [];
    const embedder = createVertexEmbedder({
      ...config, tokenProvider: async () => 'tok',
      fetchImpl: (async (url: string, init: RequestInit) => { seen.push({ url, body: JSON.parse(init.body as string), auth: (init.headers as Record<string, string>).authorization }); return answer([3, 0, 4, 0])(); }) as typeof fetch,
    });
    expect(embedder).toMatchObject({ enabled: true, id: 'vertex:gemini-embedding-001:4', dims: 4 });
    const [a, b] = await embedder.embed(['one', 'two'], 'query');
    expect(seen).toHaveLength(2); // one text a request
    expect(seen[0].url).toBe('https://aiplatform.eu.rep.googleapis.com/v1/projects/p1/locations/eu/publishers/google/models/gemini-embedding-001:predict');
    expect(seen[0].body).toEqual({ instances: [{ content: 'one', task_type: 'RETRIEVAL_QUERY' }], parameters: { outputDimensionality: 4, autoTruncate: true } });
    expect(seen[0].auth).toBe('Bearer tok');
    expect(Array.from(a)).toEqual([0.6000000238418579, 0, 0.800000011920929, 0]);
    expect(b.length).toBe(4);
    await embedder.embed(['x'], 'document');
    expect(seen.at(-1)?.body.instances[0].task_type).toBe('RETRIEVAL_DOCUMENT');
  });

  it('calls gemini-embedding-2 with embedContent, the task in a prefix and no task type, and reads either reply shape', async () => {
    const seen: Array<{ url: string; body: any }> = [];
    let reply: unknown = { embedding: { values: [3, 0, 4, 0] } };
    const embedder = createVertexEmbedder({
      ...config, model: 'gemini-embedding-2', tokenProvider: async () => 'tok',
      fetchImpl: (async (url: string, init: RequestInit) => { seen.push({ url, body: JSON.parse(init.body as string) }); return new Response(JSON.stringify(reply), { status: 200 }); }) as typeof fetch,
    });
    expect(embedder.id).toBe('vertex:gemini-embedding-2:4');
    const [a] = await embedder.embed(['my words'], 'query');
    expect(seen[0].url).toBe('https://aiplatform.eu.rep.googleapis.com/v1/projects/p1/locations/eu/publishers/google/models/gemini-embedding-2:embedContent');
    expect(seen[0].body).toEqual({ content: { parts: [{ text: 'task: search result | query: my words' }] }, outputDimensionality: 4 });
    expect(Array.from(a)[2]).toBeCloseTo(0.8);
    await embedder.embed(['a card'], 'document');
    expect(seen[1].body.content.parts[0].text).toBe('title: none | text: a card');
    reply = { embeddings: [{ values: [0, 0, 0, 2] }] };
    expect(Array.from((await embedder.embed(['x'], 'document'))[0])).toEqual([0, 0, 0, 1]);
  });

  it('lists the embedding models its endpoint serves, and nothing else', async () => {
    const seen: string[] = [];
    const embedder = createVertexEmbedder({
      ...config, tokenProvider: async () => 'tok',
      fetchImpl: (async (url: string) => { seen.push(url); return new Response(JSON.stringify({ publisherModels: [{ name: 'publishers/google/models/gemini-3.5-flash' }, { name: 'publishers/google/models/gemini-embedding-2' }] }), { status: 200 }); }) as typeof fetch,
    });
    expect(await embedder.availableModels!()).toEqual(['gemini-embedding-2']);
    expect(seen).toEqual(['https://aiplatform.eu.rep.googleapis.com/v1beta1/publishers/google/models?pageSize=200']);
  });

  it('keeps the order of its answers whatever order they arrive in', async () => {
    const embedder = createVertexEmbedder({
      ...config, tokenProvider: async () => 't',
      fetchImpl: (async (_u: string, init: RequestInit) => {
        const text = JSON.parse(init.body as string).instances[0].content as string;
        await new Promise(r => setTimeout(r, text === 'slow' ? 30 : 1));
        return answer(text === 'slow' ? [1, 0, 0, 0] : [0, 1, 0, 0])();
      }) as typeof fetch,
    });
    const out = await embedder.embed(['slow', 'fast', 'fast'], 'document');
    expect(Array.from(out[0])).toEqual([1, 0, 0, 0]);
    expect(Array.from(out[1])).toEqual([0, 1, 0, 0]);
  });

  it('fails without quoting the text, and refuses a reply of the wrong size', async () => {
    const down = createVertexEmbedder({ ...config, tokenProvider: async () => 't', fetchImpl: (async () => new Response('secret document text', { status: 503 })) as typeof fetch });
    const error = await down.embed(['a patient name'], 'document').catch(e => e as Error);
    expect((error as Error).message).toBe('the embedding service answered 503');
    expect((error as Error).message).not.toContain('secret');
    const wrong = createVertexEmbedder({ ...config, tokenProvider: async () => 't', fetchImpl: answer([1, 2]) as typeof fetch });
    await expect(wrong.embed(['a'], 'document')).rejects.toThrow(/returned 2 values, expected 4/);
  });

  it('refuses to start without a stated endpoint, region or project, and with a Google API key in the environment', () => {
    expect(() => createEmbedder({ ...config, endpoint: undefined })).toThrow(/endpoint/);
    expect(() => createEmbedder({ ...config, region: undefined })).toThrow(/region/);
    expect(() => createEmbedder({ ...config, project: undefined })).toThrow(/project/);
    process.env.GEMINI_API_KEY = 'k';
    try { expect(() => createEmbedder(config)).toThrow(/GEMINI_API_KEY/); } finally { delete process.env.GEMINI_API_KEY; }
    expect(() => createEmbedder({ ...config, adapter: 'nope' })).toThrow(/unknown SPINE_EMBEDDINGS/);
  });

  it('is off by default, and reads its settings from the chat model\'s when that is Vertex', () => {
    expect(loadEmbeddingConfig({}).adapter).toBe('none');
    expect(createEmbedder({ adapter: 'none', model: 'm', dims: 8 }).enabled).toBe(false);
    expect(() => loadEmbeddingConfig({ SPINE_EMBEDDINGS: 'vertex' })).toThrow(/endpoint/);
    expect(loadEmbeddingConfig({ SPINE_EMBEDDINGS: 'vertex', SPINE_LLM_PROVIDER: 'vertex', SPINE_LLM_ENDPOINT: 'e', SPINE_LLM_REGION: 'eu', SPINE_LLM_PROJECT: 'p' }))
      .toMatchObject({ adapter: 'vertex', model: 'gemini-embedding-2', dims: 768, endpoint: 'e', region: 'eu', project: 'p' });
    // An Anthropic chat model says nothing about where embeddings may go.
    expect(() => loadEmbeddingConfig({ SPINE_EMBEDDINGS: 'vertex', SPINE_LLM_ENDPOINT: 'e', SPINE_LLM_REGION: 'eu', SPINE_LLM_PROJECT: 'p' })).toThrow(/endpoint/);
    expect(() => loadEmbeddingConfig({ SPINE_EMBEDDING_DIMS: '5' })).toThrow(/128-3072/);
  });
});

describe('keeping vectors current', () => {
  it('embeds each visible document once, and again only when what it says changes', async () => {
    const a = await doc('Hemoleucograma', 'Anemie feripriva cu hemoglobina scazuta');
    const b = await doc('Consult cardiologie', 'Hipertensiune arteriala controlata');
    expect((await syncEmbeddings(OWNER_ID)).embedded).toBeGreaterThanOrEqual(2);
    const before = embedCalls.length;
    expect((await syncEmbeddings(OWNER_ID)).embedded).toBe(0);
    expect(embedCalls.length).toBe(before); // nothing to do, nothing sent

    await getStore().documents.update(OWNER_ID, a.id, { ai_summary: 'Hemoglobina normalizata dupa tratament' });
    embedCalls.length = 0;
    expect((await syncEmbeddings(OWNER_ID)).embedded).toBe(1);
    expect(embedCalls.flatMap(c => c.texts).join('\n')).toContain('normalizata');
    expect(embedCalls.flatMap(c => c.texts).join('\n')).not.toContain('Hipertensiune');
    expect(embedCalls.every(c => c.kind === 'document')).toBe(true);
    void b;
  });

  it('puts the title, summary, doctors, key fields and test names on the card, and nothing from the pages', async () => {
    const d = await doc('Bilet de externare', 'Pacient internat pentru pneumonie');
    const store = getStore();
    await store.fields.create(OWNER_ID, { id: uuidv4(), documentId: d.id, pageId: d.pageId!, label: 'diagnosis', value: 'Pneumonie bacteriana', sourceSnippet: null, bbox: null, confidence: 1 });
    await store.measurements.create(OWNER_ID, { id: uuidv4(), documentId: d.id, pageId: d.pageId!, name: 'CRP', canonical: 'crp', valueText: '40', valueNum: 40, unit: 'mg/L', refLow: 0, refHigh: 5, flag: 'high', takenOn: '2026-01-01', sourceSnippet: null, bbox: null, confidence: 1 });
    const doctor = (await store.doctors.upsert(OWNER_ID, { name: 'Ion Popescu', specialty: 'pneumologie' }, '2026-01-01'))!;
    await store.doctors.link(OWNER_ID, d.id, doctor, 'author');
    embedCalls.length = 0;
    await syncEmbeddings(OWNER_ID);
    const card = embedCalls.flatMap(c => c.texts).find(t => t.includes('Bilet de externare'))!;
    expect(card).toContain('pneumonie');
    expect(card).toContain('diagnosis: Pneumonie bacteriana');
    expect(card).toContain('Ion Popescu, pneumologie');
    expect(card).toContain('tests: CRP');
    expect(card).not.toContain('page text'); // the page's own text is not on the card
    expect(card).not.toContain('40 mg/L'); // values are for the trends, not the meaning
  });

  it('leaves out documents the owner set aside, and removes vectors with the document', async () => {
    const hidden = await doc('Ascuns', 'Document pus deoparte despre alergie');
    await getStore().pages.setHiddenForDocument(OWNER_ID, hidden.id, true);
    const kept = await doc('Vizibil', 'Document despre alergie la polen');
    await syncEmbeddings(OWNER_ID);
    const model = 'fake:v1';
    const stored = (await getStore().embeddings.listFor(OWNER_ID, model)).map(e => e.documentId);
    expect(stored).toContain(kept.id);
    expect(stored).not.toContain(hidden.id);
    expect((await similarTo(OWNER_ID, kept.id, 10)).map(s => s.id)).not.toContain(hidden.id);

    await getStore().documents.delete(OWNER_ID, kept.id);
    expect((await getStore().embeddings.hashesFor(OWNER_ID, model)).has(kept.id)).toBe(false);
  });

  it('keeps one model\'s vectors apart from another\'s and drops the old ones when the new is complete', async () => {
    const d = await doc('Ecografie abdominala', 'Ficat normal ecografie');
    await syncEmbeddings(OWNER_ID);
    expect((await getStore().embeddings.hashesFor(OWNER_ID, 'fake:v1')).has(d.id)).toBe(true);
    resetEmbedder(fake('fake:v2'));
    expect((await embeddingStatus(OWNER_ID)).embedded).toBe(0); // nothing in the new space yet; the old is not used
    expect(await similarTo(OWNER_ID, d.id, 5)).toEqual([]);
    await syncEmbeddings(OWNER_ID);
    expect((await getStore().embeddings.hashesFor(OWNER_ID, 'fake:v2')).has(d.id)).toBe(true);
    expect((await getStore().embeddings.hashesFor(OWNER_ID, 'fake:v1')).size).toBe(0);
  });

  it('writes nothing for a document that is not the user\'s', async () => {
    const mine = await doc('Al meu', 'text unic zebra');
    await getStore().embeddings.put(otherId, { documentId: mine.id, model: 'fake:v1', dims: DIMS, textHash: 'x', vector: Buffer.alloc(DIMS * 4) }, 'now');
    expect((await getStore().embeddings.hashesFor(otherId, 'fake:v1')).size).toBe(0);
    expect((await getStore().embeddings.hashesFor(OWNER_ID, 'fake:v1')).has(mine.id)).toBe(false);
  });

  it('does nothing when embeddings are off', async () => {
    resetEmbedder(createEmbedder({ adapter: 'none', model: 'm', dims: 8 }));
    await doc('Orice', 'orice text');
    expect(await syncEmbeddings(OWNER_ID)).toEqual({ embedded: 0 });
    expect(await searchByMeaning(OWNER_ID, 'orice', 5)).toEqual([]);
    expect((await get('/api/similarity/status')).json()).toMatchObject({ enabled: false });
  });
});

describe('finding by meaning and related documents', () => {
  it('ranks documents that read alike above ones that do not, and never another user\'s', async () => {
    const anemia = await doc('Hemoleucograma completa', 'Anemie feripriva hemoglobina scazuta fier');
    const anemia2 = await doc('Control hematologie', 'Anemie feripriva hemoglobina fier tratament');
    const cardio = await doc('Ecocardiografie', 'Hipertensiune ventricul stang cardiologie');
    await doc('Analize straine', 'Anemie feripriva hemoglobina scazuta fier', otherId);
    await settleSync(OWNER_ID);
    const similar = await similarTo(OWNER_ID, anemia.id, 5);
    expect(similar[0].id).toBe(anemia2.id);
    expect(similar.map(s => s.id)).not.toContain(cardio.id);
    const found = await searchByMeaning(OWNER_ID, 'hemoglobina scazuta anemie', 5);
    expect(found[0].id === anemia.id || found[0].id === anemia2.id).toBe(true);
    expect(found.some(f => f.id === cardio.id)).toBe(false);
    expect((await getStore().documents.listFor(otherId, { limit: 50, offset: 0 })).length).toBeGreaterThan(0);
    for (const f of found) expect(await getStore().documents.findFor(OWNER_ID, f.id)).not.toBeNull();
  });

  it('relates documents by a shared test or doctor, saying why, without any vectors', async () => {
    resetEmbedder(createEmbedder({ adapter: 'none', model: 'm', dims: 8 }));
    const store = getStore();
    const a = await doc('Analize ianuarie', 'a');
    const b = await doc('Analize iulie', 'b');
    const c = await doc('Altceva', 'c');
    const value = (d: { id: string; pageId: string | null }, name: string, canonical: string) =>
      store.measurements.create(OWNER_ID, { id: uuidv4(), documentId: d.id, pageId: d.pageId!, name, canonical, valueText: '1', valueNum: 1, unit: null, refLow: null, refHigh: null, flag: null, takenOn: '2026-01-01', sourceSnippet: null, bbox: null, confidence: 1 });
    await value(a, 'TSH', 'tsh'); await value(b, 'Hormon tireostimulant', 'tsh'); await value(c, 'Glucoza', 'glucose');
    const doctor = (await store.doctors.upsert(OWNER_ID, { name: 'Ana Ionescu, MD' }, 'now'))!;
    await store.doctors.link(OWNER_ID, a.id, doctor, 'author'); await store.doctors.link(OWNER_ID, c.id, doctor, 'author');

    const related = await relatedTo(OWNER_ID, a.id);
    expect(related.map(r => r.id)).toEqual(expect.arrayContaining([b.id, c.id]));
    expect(related[0].id).toBe(b.id); // a shared test outweighs a shared doctor
    expect(related.find(r => r.id === b.id)?.reasons).toContainEqual({ kind: 'tests', names: ['Hormon tireostimulant'] });
    expect(related.find(r => r.id === c.id)?.reasons).toContainEqual({ kind: 'doctors', names: ['Ana Ionescu, MD'] }); // a name with a comma survives
    expect(related.some(r => r.id === a.id)).toBe(false);

    const res = await get(`/api/documents/${a.id}/related`);
    expect(res.json()).toMatchObject({ meaning: { enabled: false } });
    expect(res.body).not.toMatch(/vector|user_id/);
    expect((res.json() as { related: unknown[] }).related).toHaveLength(2);
    expect((await get(`/api/documents/${a.id}/related`, otherCookie)).statusCode).toBe(404);
    expect((await get(`/api/documents/${uuidv4()}/related`)).statusCode).toBe(404);
  });

  it('does not relate a document to one that is set aside', async () => {
    const store = getStore();
    const a = await doc('Cu TSH', 'x'); const b = await doc('Cu TSH ascuns', 'y');
    for (const d of [a, b]) await store.measurements.create(OWNER_ID, { id: uuidv4(), documentId: d.id, pageId: d.pageId!, name: 'TSH', canonical: 'tsh-aside', valueText: '1', valueNum: 1, unit: null, refLow: null, refHigh: null, flag: null, takenOn: null, sourceSnippet: null, bbox: null, confidence: 1 });
    await store.pages.setHiddenForDocument(OWNER_ID, b.id, true);
    expect((await relatedTo(OWNER_ID, a.id)).map(r => r.id)).not.toContain(b.id);
  });
});

describe('search by words and meaning together', () => {
  it('lets a document found only by meaning appear, and one found by both rise', async () => {
    const both = await doc('Hemoglobina scazuta', 'Hemoglobina scazuta, anemie feripriva, fier');
    const meaningOnly = await doc('Hemoglobina redusa', 'Hemoglobina redusa, anemie feripriva, fier');
    const unrelated = await doc('Radiografie', 'Fractura radius examen ortopedic');
    await settleSync(OWNER_ID);
    const hits = await hybridSearch(OWNER_ID, 'hemoglobina scazuta anemie feripriva fier', 10);
    expect(hits[0].doc.id).toBe(both.id);
    expect(hits[0].via).toEqual(expect.arrayContaining(['words', 'meaning']));
    expect(hits.map(h => h.doc.id)).toContain(meaningOnly.id);
    expect(hits.map(h => h.doc.id)).not.toContain(unrelated.id);
    const viaRoute = (await get('/api/search/hybrid?q=hemoglobina%20scazuta%20anemie%20feripriva%20fier')).json() as Array<{ id: string; via: string[] }>;
    expect(viaRoute[0].id).toBe(both.id);
    expect(JSON.stringify(viaRoute)).not.toContain('user_id');
    expect(JSON.stringify(viaRoute)).not.toContain('vector'); // the numbers never leave the server
  });

  it('is plain word search when embeddings are off, and refuses an empty question', async () => {
    resetEmbedder(createEmbedder({ adapter: 'none', model: 'm', dims: 8 }));
    await doc('Colonoscopie', 'Examen digestiv colonoscopie');
    const hits = await hybridSearch(OWNER_ID, 'colonoscopie', 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every(h => h.via.length === 1 && h.via[0] === 'words')).toBe(true);
    expect((await get('/api/search/hybrid?q=')).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/search/hybrid?q=x' })).statusCode).toBe(401);
  });
});
