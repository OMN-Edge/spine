import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { buildTestApp, loginAs } from './helpers/app.js';
import { createTestUser, seedPage, seedSourceFile, OWNER_ID } from './helpers/seed.js';
import { getStore } from 'spine-core/store/index.js';
import { resetParser, type Parser, type ParseInput } from 'spine-core/parser/index.js';
import { getAiReading, resetAiReadings } from 'spine-core/ingestion/ai-reading.js';
import { EXTRACTION_FALLBACK } from 'spine-core/llm/types.js';

/**
 * Reading chosen pages with the model, and extracting the documents they belong to again.
 * The model is stubbed, but the stub records what it was asked to read, so what these assert
 * about "only these pages' images are sent" is real.
 */
const mockExtractFields = vi.hoisted(() => vi.fn());
vi.mock('spine-core/ingestion/extraction.js', () => ({ extractFields: mockExtractFields }));

let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
const saved = process.env.SPINE_MULTIMODAL_ENABLED;

/** A model parser that reads each page as "AI text N" and records every call. */
const sent: ParseInput[] = [];
let failOnPage: number | null = null;
const modelParser: Parser = {
  imageEgress: true,
  async parse(input) {
    sent.push(input);
    return {
      pages: input.pages.map(p => {
        if (p.page_number === failOnPage) throw new Error(`page ${p.page_number} could not be read: the model's answer was not usable`);
        return {
          page_number: p.page_number,
          elements: [{ type: 'Text', text: `AI text ${p.page_number}`, page_number: p.page_number, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 }, source: 'multimodal' as const }],
          extraction_source: 'multimodal' as const,
          image_width: 800,
          image_height: 1100,
        };
      }),
    };
  },
};

beforeAll(async () => {
  app = await buildTestApp();
  cookie = await loginAs(app);
});
afterAll(async () => { await app.close(); });
beforeEach(() => {
  process.env.SPINE_MULTIMODAL_ENABLED = 'true';
  resetParser(null, modelParser);
  resetAiReadings();
  sent.length = 0;
  failOnPage = null;
  mockExtractFields.mockReset();
});
afterEach(() => {
  resetParser(null, null);
  if (saved === undefined) delete process.env.SPINE_MULTIMODAL_ENABLED;
  else process.env.SPINE_MULTIMODAL_ENABLED = saved;
});

const reading = (title: string) => ({
  title, doc_date: '2026-05-01', provider: 'Synevo', doc_type: 'lab_result' as const,
  ai_summary: `${title} summary`, suggested_tags: ['lab'], doctors: [], measurements: [],
  fields: [{ label: 'value', value: title, source_snippet: 'AI text', page_number: 1, confidence: 0.9 }],
});

/** An upload of six pages read as two documents (pages 1-3 and 4-6), the second reviewed with notes. */
async function upload(userId = OWNER_ID) {
  const store = getStore();
  const sf = await seedSourceFile({ userId, status: 'done' });
  const pageIds: string[] = [];
  for (let n = 1; n <= 6; n++) pageIds.push(await seedPage(sf, { userId, pageNumber: n, rawText: `old text ${n}`, imagePath: `/data/pages/${sf}/page-${n}.png` }));
  const a = uuidv4(); const b = uuidv4();
  await store.documents.create(userId, { id: a, sourceFileId: sf, pageStart: 1, pageEnd: 3, title: 'Doc A', docType: 'other' });
  await store.documents.create(userId, { id: b, sourceFileId: sf, pageStart: 4, pageEnd: 6, title: 'Doc B', docType: 'other' });
  await store.documents.update(userId, b, { reviewed: true, user_notes: 'my notes' });
  return { sf, pageIds, a, b };
}

const start = (sf: string, page_ids: unknown, c = cookie) =>
  app.inject({ method: 'POST', url: `/api/source-files/${sf}/ai-reading`, payload: { page_ids }, headers: { cookie: c } });
const status = (sf: string, c = cookie) => app.inject({ method: 'GET', url: `/api/source-files/${sf}/ai-reading`, headers: { cookie: c } });

async function finished(sf: string) {
  for (let i = 0; i < 200; i++) {
    const job = getAiReading(sf);
    if (job && job.status !== 'running') return job;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('the reading did not finish');
}
const doc = async (id: string) => (await getStore().documents.findFor(OWNER_ID, id))!;
const pageText = async (sf: string, n: number) => (await getStore().pages.listForSourceFile(OWNER_ID, sf)).find(p => p.page_number === n)!;

describe('reading one page', () => {
  it('sends only that page’s image, replaces its text, and extracts only its document again', async () => {
    const { sf, pageIds, a, b } = await upload();
    mockExtractFields.mockResolvedValue(reading('Doc A, read again'));

    const res = await start(sf, [pageIds[1]]); // page 2, in Doc A
    expect(res.statusCode).toBe(202);
    const job = await finished(sf);
    expect(job).toMatchObject({ status: 'done', pages_total: 1, pages_read: 1, documents_updated: 1, documents_not_updated: 0 });

    // The image of page 2, and no other.
    expect(sent).toHaveLength(1);
    expect(sent[0].pages).toEqual([{ page_number: 2, image_path: `/data/pages/${sf}/page-2.png` }]);

    const page2 = await pageText(sf, 2);
    expect(page2.raw_text).toBe('AI text 2');
    expect(page2.extraction_source).toBe('multimodal');
    expect((await pageText(sf, 1)).raw_text).toBe('old text 1');

    // Doc A was read again from its own three pages; Doc B was left completely alone.
    expect(mockExtractFields).toHaveBeenCalledTimes(1);
    expect(mockExtractFields.mock.calls[0][0]).toContain('AI text 2');
    expect(mockExtractFields.mock.calls[0][0]).toContain('old text 1');
    expect(mockExtractFields.mock.calls[0][0]).not.toContain('old text 4');
    expect((await doc(a)).title).toBe('Doc A, read again');
    const untouched = await doc(b);
    expect([untouched.title, untouched.reviewed, untouched.user_notes]).toEqual(['Doc B', 1, 'my notes']);
  });

  it('puts the re-extracted document back in the review queue and keeps the owner’s notes', async () => {
    const { sf, pageIds, b } = await upload();
    mockExtractFields.mockResolvedValue(reading('Doc B, read again'));
    await start(sf, [pageIds[4]]); // page 5, in the reviewed Doc B
    await finished(sf);
    const after = await doc(b);
    expect([after.title, after.reviewed, after.user_notes]).toEqual(['Doc B, read again', 0, 'my notes']);
  });
});

/** The configured parser: the text layer where there is one, and nothing for a page marked unreadable. */
const configuredSent: ParseInput[] = [];
let unreadPage: number | null = null;
const configuredParser: Parser = {
  imageEgress: false,
  async parse(input) {
    configuredSent.push(input);
    return {
      pages: input.pages.map(p => p.page_number === unreadPage
        ? { page_number: p.page_number, elements: [], extraction_source: 'unread' as const, image_width: 800, image_height: 1100 }
        : {
          page_number: p.page_number,
          elements: [{ type: 'Text', text: `configured text ${p.page_number}`, page_number: p.page_number, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 }, source: 'native_text' as const }],
          extraction_source: 'native_text' as const,
          image_width: 800,
          image_height: 1100,
        }),
    };
  },
};

describe('reading a whole document the way an upload does', () => {
  beforeEach(() => { resetParser(configuredParser, modelParser); configuredSent.length = 0; unreadPage = null; });

  const startWhole = (sf: string, page_ids: unknown, extra: object = {}, c = cookie) =>
    app.inject({ method: 'POST', url: `/api/source-files/${sf}/ai-reading`, payload: { page_ids, strategy: 'configured', ...extra }, headers: { cookie: c } });

  it('reads its pages once, together, with the configured parser and not the model, then extracts it again', async () => {
    const { sf, pageIds, a, b } = await upload();
    mockExtractFields.mockResolvedValue(reading('Doc A, read whole'));

    expect((await startWhole(sf, pageIds.slice(0, 3))).statusCode).toBe(202);
    expect(await finished(sf)).toMatchObject({ status: 'done', pages_total: 3, documents_updated: 1 });

    expect(configuredSent).toHaveLength(1);
    expect(configuredSent[0].pages.map(p => p.page_number)).toEqual([1, 2, 3]);
    expect(sent).toHaveLength(0);
    expect((await pageText(sf, 2)).raw_text).toBe('configured text 2');
    expect((await pageText(sf, 2)).extraction_source).toBe('native_text');
    expect((await doc(a)).title).toBe('Doc A, read whole');
    expect((await doc(b)).title).toBe('Doc B'); // the other document is left alone
    expect((await pageText(sf, 5)).raw_text).toBe('old text 5');
  });

  it('keeps the earlier text of a page the parser could read nothing from', async () => {
    const { sf, pageIds } = await upload();
    unreadPage = 2;
    mockExtractFields.mockResolvedValue(reading('Doc A'));
    await startWhole(sf, pageIds.slice(0, 3));
    await finished(sf);
    expect((await pageText(sf, 2)).raw_text).toBe('old text 2');
    expect((await pageText(sf, 1)).raw_text).toBe('configured text 1');
  });

  it('takes the model the owner picked for whatever the parser sends to one', async () => {
    const { sf, pageIds } = await upload();
    process.env.SPINE_LLM_MODELS = 'other-model';
    try {
      mockExtractFields.mockResolvedValue(reading('Doc A'));
      await startWhole(sf, pageIds.slice(0, 3), { model: 'other-model' });
      await finished(sf);
      expect(mockExtractFields.mock.calls[0][2]).toBe('other-model');
    } finally { delete process.env.SPINE_LLM_MODELS; }
  });

  it('needs no image switch when the configured parser sends no image, and sends nothing then', async () => {
    delete process.env.SPINE_MULTIMODAL_ENABLED;
    const { sf, pageIds } = await upload();
    mockExtractFields.mockResolvedValue(reading('Doc A'));
    expect((await startWhole(sf, pageIds.slice(0, 3))).statusCode).toBe(202);
    await finished(sf);
    expect(sent).toHaveLength(0);
  });

  it('does need the switch when the configured parser sends images', async () => {
    resetParser({ imageEgress: true, parse: configuredParser.parse }, modelParser);
    delete process.env.SPINE_MULTIMODAL_ENABLED;
    const { sf, pageIds } = await upload();
    expect((await startWhole(sf, pageIds.slice(0, 3))).statusCode).toBe(409);
  });

  it('refuses a strategy it does not know, and keeps the per-page reading as it was', async () => {
    const { sf, pageIds } = await upload();
    expect((await startWhole(sf, pageIds.slice(0, 1), { strategy: 'everything' })).statusCode).toBe(400);
    mockExtractFields.mockResolvedValue(reading('Doc A'));
    expect((await start(sf, [pageIds[0]])).statusCode).toBe(202); // no strategy: the model reads the page
    await finished(sf);
    expect(sent).toHaveLength(1);
    expect(configuredSent).toHaveLength(0);
  });
});

describe('thinking', () => {
  const startThinking = (sf: string, page_ids: unknown, thinking: unknown) =>
    app.inject({ method: 'POST', url: `/api/source-files/${sf}/ai-reading`, payload: { page_ids, thinking }, headers: { cookie } });

  it('takes true or false, and refuses anything else before reading', async () => {
    const { sf, pageIds } = await upload();
    for (const bad of ['yes', 1, {}, null]) {
      if (bad === null) continue; // null is "not given"
      expect((await startThinking(sf, [pageIds[0]], bad)).statusCode).toBe(400);
    }
    expect(sent).toHaveLength(0);
    mockExtractFields.mockResolvedValue(reading('Doc A'));
    expect((await startThinking(sf, [pageIds[0]], true)).statusCode).toBe(202);
    await finished(sf);
    expect(sent).toHaveLength(1);
  });
});

describe('a page that was moved', () => {
  it('is still asked for by its place in the file, which is what the parser counts', async () => {
    const { sf, pageIds } = await upload();
    // Page 1 and page 2 swap places in the upload.
    await getStore().pages.renumber(OWNER_ID, sf, [pageIds[1], pageIds[0], ...pageIds.slice(2)]);
    mockExtractFields.mockResolvedValue(reading('Doc A'));

    await start(sf, [pageIds[0]]); // the page that is now number 2 and was number 1 in the file
    await finished(sf);
    expect(sent[0].pages).toEqual([{ page_number: 1, image_path: `/data/pages/${sf}/page-1.png` }]);
    // Its new text lands on it, not on the page that now has number 1.
    expect((await pageText(sf, 2)).raw_text).toBe('AI text 1');
    expect((await pageText(sf, 1)).raw_text).toBe('old text 2');
  });
});

describe('reading several pages', () => {
  it('reads each chosen page, one image at a time, and extracts each affected document once', async () => {
    const { sf, pageIds, a, b } = await upload();
    mockExtractFields.mockImplementation(async (text: string) => reading(text.includes('AI text 5') ? 'Doc B again' : 'Doc A again'));

    // Two pages of Doc A and one of Doc B.
    await start(sf, [pageIds[0], pageIds[1], pageIds[4]]);
    const job = await finished(sf);
    expect(job).toMatchObject({ status: 'done', pages_read: 3, documents_updated: 2 });

    expect(sent.map(s => s.pages.map(p => p.page_number))).toEqual([[1], [2], [5]]);
    expect(mockExtractFields).toHaveBeenCalledTimes(2); // not three: two pages share Doc A
    expect([(await doc(a)).title, (await doc(b)).title]).toEqual(['Doc A again', 'Doc B again']);
  });

  it('reads a whole document’s pages', async () => {
    const { sf, pageIds, a } = await upload();
    mockExtractFields.mockResolvedValue(reading('Doc A again'));
    await start(sf, pageIds.slice(0, 3));
    expect((await finished(sf)).documents_updated).toBe(1);
    expect(sent).toHaveLength(3);
    for (const n of [1, 2, 3]) expect((await pageText(sf, n)).raw_text).toBe(`AI text ${n}`);
    expect((await doc(a)).title).toBe('Doc A again');
  });
});

describe('when something fails', () => {
  it('changes nothing if the model cannot read one of the pages', async () => {
    const { sf, pageIds, a } = await upload();
    failOnPage = 3;
    await start(sf, [pageIds[0], pageIds[1], pageIds[2]]);
    const job = await finished(sf);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/page 3 could not be read/);

    // Pages 1 and 2 were read before page 3 failed, and still hold their old text.
    for (const n of [1, 2, 3]) expect((await pageText(sf, n)).raw_text).toBe(`old text ${n}`);
    expect((await doc(a)).title).toBe('Doc A');
    expect(mockExtractFields).not.toHaveBeenCalled();
  });

  it('keeps the new page text and the old details when extracting the document fails, and says so', async () => {
    const { sf, pageIds, a } = await upload();
    mockExtractFields.mockRejectedValue(new Error('provider down'));
    await start(sf, [pageIds[0]]);
    const job = await finished(sf);
    expect(job).toMatchObject({ status: 'done', documents_updated: 0, documents_not_updated: 1 });
    expect((await pageText(sf, 1)).raw_text).toBe('AI text 1');
    expect((await doc(a)).title).toBe('Doc A');
  });

  it('does not write "extraction failed" over a document when the answer fails validation', async () => {
    const { sf, pageIds, a } = await upload();
    mockExtractFields.mockResolvedValue(EXTRACTION_FALLBACK);
    await start(sf, [pageIds[0]]);
    expect((await finished(sf)).documents_not_updated).toBe(1);
    expect((await doc(a)).title).toBe('Doc A');
  });

  it('is refused when the model parser itself refuses, as when images are not allowed', async () => {
    const { sf, pageIds } = await upload();
    resetParser(null, { imageEgress: true, parse: async () => { throw new Error('image egress is not enabled'); } });
    await start(sf, [pageIds[0]]);
    expect((await finished(sf)).error).toMatch(/not enabled/);
  });
});

describe('who may ask, and for what', () => {
  it('needs the operator’s switch, and sends nothing without it', async () => {
    const { sf, pageIds } = await upload();
    delete process.env.SPINE_MULTIMODAL_ENABLED;
    const res = await start(sf, [pageIds[0]]);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/not enabled/) });
    expect(sent).toHaveLength(0);
    expect(getAiReading(sf)).toBeNull();
  });

  it('is not found for someone else’s upload, and cannot name someone else’s pages', async () => {
    const mine = await upload();
    const intruder = await createTestUser(`ai-${uuidv4()}@spine.test`);
    const theirs = await upload(intruder.id);

    expect((await start(theirs.sf, [theirs.pageIds[0]])).statusCode).toBe(404);
    expect((await status(theirs.sf)).statusCode).toBe(404);
    // Their page id on my upload: the same answer as a page that does not exist.
    expect((await start(mine.sf, [theirs.pageIds[0]])).statusCode).toBe(400);
    // A page of another upload of mine is refused too.
    const other = await upload();
    expect((await start(mine.sf, [other.pageIds[0]])).statusCode).toBe(400);
    expect(sent).toHaveLength(0);

    const intruderCookie = await loginAs(app, intruder.email);
    expect((await start(mine.sf, [mine.pageIds[0]], intruderCookie)).statusCode).toBe(404);
  });

  it.each([
    ['no pages', []],
    ['not a list', 'page-1'],
    ['a non-string id', [5]],
    ['the same page twice', ['DUP', 'DUP']],
    ['more pages than one request may send', Array.from({ length: 201 }, (_, i) => `p${i}`)],
  ])('refuses %s', async (_name, body) => {
    const { sf, pageIds } = await upload();
    const ids = Array.isArray(body) && body[0] === 'DUP' ? [pageIds[0], pageIds[0]] : body;
    expect((await start(sf, ids)).statusCode).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it('caps how many pages one request may send, counting real pages of the upload', async () => {
    const store = getStore();
    const sf = await seedSourceFile({ status: 'done' });
    const ids: string[] = [];
    for (let n = 1; n <= 201; n++) ids.push(await seedPage(sf, { pageNumber: n, imagePath: `/data/pages/${sf}/page-${n}.png` }));
    await store.documents.create(OWNER_ID, { id: uuidv4(), sourceFileId: sf, pageStart: 1, pageEnd: 201, title: 'Long' });

    expect((await start(sf, ids)).statusCode).toBe(400);
    expect(sent).toHaveLength(0);

    mockExtractFields.mockResolvedValue(reading('Long'));
    expect((await start(sf, ids.slice(0, 200))).statusCode).toBe(202);
    expect((await finished(sf)).pages_read).toBe(200);
  });

  it('allows one reading at a time per upload', async () => {
    const { sf, pageIds } = await upload();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    resetParser(null, { imageEgress: true, parse: async input => { await gate; return modelParser.parse(input); } });
    mockExtractFields.mockResolvedValue(reading('x'));

    expect((await start(sf, [pageIds[0]])).statusCode).toBe(202);
    expect((await start(sf, [pageIds[1]])).statusCode).toBe(409);
    expect((await status(sf)).json()).toMatchObject({ status: 'running' });

    release();
    await finished(sf);
    expect((await status(sf)).json()).toMatchObject({ status: 'done' });
    expect((await start(sf, [pageIds[1]])).statusCode).toBe(202);
    await finished(sf);
  });

  it('is not allowed while the upload is still being processed', async () => {
    const store = getStore();
    const sf = await seedSourceFile({ status: 'processing' });
    const page = await seedPage(sf, { pageNumber: 1 });
    expect((await start(sf, [page])).statusCode).toBe(409);
    void store;
  });

  it('reports idle when nothing has run', async () => {
    const { sf } = await upload();
    expect((await status(sf)).json()).toEqual({ status: 'idle' });
  });

  it('requires a session', async () => {
    const { sf, pageIds } = await upload();
    expect((await app.inject({ method: 'POST', url: `/api/source-files/${sf}/ai-reading`, payload: { page_ids: [pageIds[0]] } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/source-files/${sf}/ai-reading` })).statusCode).toBe(401);
  });
});

describe('extracting a document again without images', () => {
  const reextract = (id: string, c = cookie) => app.inject({ method: 'POST', url: `/api/documents/${id}/reextract`, headers: { cookie: c } });

  it('uses the page text it already has, sends no image, and needs no operator switch', async () => {
    const { a } = await upload();
    delete process.env.SPINE_MULTIMODAL_ENABLED;
    mockExtractFields.mockResolvedValue(reading('Doc A, extracted again'));

    const res = await reextract(a);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ reread: 'done' });
    expect(sent).toHaveLength(0);
    expect(mockExtractFields.mock.calls[0][0]).toContain('old text 1');
    expect((await doc(a)).title).toBe('Doc A, extracted again');
  });

  it('puts a reviewed document back in the queue and keeps its notes', async () => {
    const { b } = await upload();
    mockExtractFields.mockResolvedValue(reading('Doc B again'));
    await reextract(b);
    const after = await doc(b);
    expect([after.reviewed, after.user_notes]).toEqual([0, 'my notes']);
  });

  it('keeps the details and says it failed when the model does not answer', async () => {
    const { a } = await upload();
    mockExtractFields.mockRejectedValue(new Error('down'));
    expect((await reextract(a)).json()).toEqual({ reread: 'failed' });
    expect((await doc(a)).title).toBe('Doc A');
  });

  it('is not found for someone else’s document and refused while the upload is busy', async () => {
    const mine = await upload();
    const intruder = await createTestUser(`re-${uuidv4()}@spine.test`);
    const theirs = await upload(intruder.id);
    expect((await reextract(theirs.a)).statusCode).toBe(404);
    expect((await reextract('no-such-document')).statusCode).toBe(404);

    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    resetParser(null, { imageEgress: true, parse: async input => { await gate; return modelParser.parse(input); } });
    mockExtractFields.mockResolvedValue(reading('x'));
    await start(mine.sf, [mine.pageIds[0]]);
    expect((await reextract(mine.a)).statusCode).toBe(409);
    release();
    await finished(mine.sf);
  });

  it('requires a session', async () => {
    const { a } = await upload();
    expect((await app.inject({ method: 'POST', url: `/api/documents/${a}/reextract` })).statusCode).toBe(401);
  });
});

describe('the page store', () => {
  it('will not change another user’s page', async () => {
    const intruder = await createTestUser(`pg-${uuidv4()}@spine.test`);
    const theirs = await upload(intruder.id);
    const ok = await getStore().pages.updateReading(OWNER_ID, theirs.pageIds[0], { rawText: 'hacked', elements: [], extractionSource: 'multimodal' });
    expect(ok).toBe(false);
    const page = (await getStore().pages.listForSourceFile(intruder.id, theirs.sf))[0];
    expect(page.raw_text).toBe('old text 1');
  });
});
