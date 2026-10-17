import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { buildTestApp, loginSession } from './helpers/app.js';
import { seedPage, seedSourceFile, OWNER_ID } from './helpers/seed.js';
import { getStore } from '../store/index.js';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { loadLlmConfig } from '../config.js';
import { getModelParser, resetParser } from '../parser/index.js';
import { chooseModel, getChatLlm, resetChatLlm } from '../llm/index.js';
import { useLogger, type AppLogger } from '../logger.js';
import { EXTRACTION_FALLBACK, type ChatLlm } from '../llm/types.js';

/**
 * Picking a model for a reading: the list the operator offers, the check that a request names only
 * one of them, and that the choice reaches the call that reads.
 */
const mockExtractFields = vi.hoisted(() => vi.fn());
vi.mock('../ingestion/extraction.js', () => ({ extractFields: mockExtractFields }));

const saved = process.env.SPINE_LLM_MODELS;
afterEach(() => {
  if (saved === undefined) delete process.env.SPINE_LLM_MODELS;
  else process.env.SPINE_LLM_MODELS = saved;
  resetChatLlm();
});

describe('SPINE_LLM_MODELS', () => {
  it('offers just the default model when it is not set', () => {
    delete process.env.SPINE_LLM_MODELS;
    expect(loadLlmConfig().models).toEqual([{ id: loadLlmConfig().model, label: loadLlmConfig().model }]);
  });

  it('puts the default first and adds the others, with labels where given', () => {
    process.env.SPINE_LLM_MODEL = 'model-a';
    process.env.SPINE_LLM_MODELS = 'model-b=Model B, model-c';
    try {
      expect(loadLlmConfig().models).toEqual([
        { id: 'model-a', label: 'model-a' },
        { id: 'model-b', label: 'Model B' },
        { id: 'model-c', label: 'model-c' },
      ]);
    } finally { delete process.env.SPINE_LLM_MODEL; }
  });

  it('lets naming the default only give it a label, and ignores repeats and blanks', () => {
    process.env.SPINE_LLM_MODEL = 'model-a';
    process.env.SPINE_LLM_MODELS = 'model-a=The usual one,,model-b,model-b';
    try {
      expect(loadLlmConfig().models).toEqual([
        { id: 'model-a', label: 'The usual one' },
        { id: 'model-b', label: 'model-b' },
      ]);
    } finally { delete process.env.SPINE_LLM_MODEL; }
  });

  it('refuses an id that is not a model id, and too many', () => {
    process.env.SPINE_LLM_MODELS = 'good-one,bad one!';
    expect(() => loadLlmConfig()).toThrow(/not a model id/);
    process.env.SPINE_LLM_MODELS = Array.from({ length: 9 }, (_, i) => `m${i}`).join(',');
    expect(() => loadLlmConfig()).toThrow(/most is 8/);
  });
});

describe('a model that runs in its own region', () => {
  const vertex = { SPINE_LLM_PROVIDER: 'vertex', SPINE_LLM_ENDPOINT: 'aiplatform.eu.rep.googleapis.com', SPINE_LLM_REGION: 'eu', SPINE_LLM_PROJECT: 'p' };
  const set = (models: string) => { Object.assign(process.env, vertex); process.env.SPINE_LLM_MODELS = models; };
  afterEach(() => { for (const key of Object.keys(vertex)) delete process.env[key]; });

  it('is written id|region=Label, and its host follows from the region', () => {
    set('gemini-2.5-pro|europe-west4=Gemini 2.5 Pro (NL), other-one|eu, eu-model|us=US');
    const [, pro, other, us] = loadLlmConfig().models;
    expect(pro).toEqual({ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (NL)', region: 'europe-west4', endpoint: 'europe-west4-aiplatform.googleapis.com' });
    expect(other).toEqual({ id: 'other-one', label: 'other-one', region: 'eu', endpoint: 'aiplatform.eu.rep.googleapis.com' });
    expect(us.endpoint).toBe('aiplatform.us.rep.googleapis.com');
  });

  it('leaves a model with no region where the default is', () => {
    set('plain-one=Plain');
    expect(loadLlmConfig().models[1]).toEqual({ id: 'plain-one', label: 'Plain' });
  });

  it('refuses global, a name that is not a region, and a region with another provider', () => {
    set('m|global'); expect(() => loadLlmConfig()).toThrow(/not a region/);
    set('m|somewhere'); expect(() => loadLlmConfig()).toThrow(/not a region/);
    set('m|europe-west4'); process.env.SPINE_LLM_PROVIDER = 'anthropic';
    expect(() => loadLlmConfig()).toThrow(/only means something with SPINE_LLM_PROVIDER=vertex/);
  });

  it('builds the client there, and says where it runs', () => {
    set('gemini-2.5-pro|europe-west4=Pro');
    const lines: Array<[string, Record<string, unknown> | undefined]> = [];
    const capture: AppLogger = { info: (m, d) => lines.push([m, d]), warn: () => {}, error: () => {} };
    useLogger(capture);
    try {
      getChatLlm('gemini-2.5-pro');
      expect(lines).toContainEqual(['llm model ready', { model: 'gemini-2.5-pro', endpoint: 'europe-west4-aiplatform.googleapis.com', region: 'europe-west4' }]);
    } finally {
      // Back to what the logger starts as: console output.
      useLogger({ info: (m, d) => console.log(m, d ?? ''), warn: (m, d) => console.warn(m, d ?? ''), error: (m, d) => console.error(m, d ?? '') });
    }
  });
});

describe('choosing a model for a request', () => {
  beforeEach(() => { process.env.SPINE_LLM_MODELS = 'model-b'; });

  it('uses the default when none is named, and accepts one that is offered', () => {
    expect(chooseModel(undefined)).toBeUndefined();
    expect(chooseModel('')).toBeUndefined();
    expect(chooseModel('model-b')).toBe('model-b');
  });

  it('refuses one that is not offered, and anything that is not a string', () => {
    expect(chooseModel('some-other-model')).toBeNull();
    expect(chooseModel(7)).toBeNull();
    expect(chooseModel({})).toBeNull();
  });

  it('builds a client for an offered model once, and refuses an unoffered one', () => {
    process.env.SPINE_LLM_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      expect(getChatLlm('model-b')).toBe(getChatLlm('model-b'));
      expect(getChatLlm('model-b')).not.toBe(getChatLlm());
      expect(() => getChatLlm('not-offered')).toThrow(/not offered/);
    } finally { delete process.env.SPINE_LLM_PROVIDER; delete process.env.ANTHROPIC_API_KEY; }
  });

  it('can be replaced per model in tests', () => {
    const fake = { id: 'fake' } as unknown as ChatLlm;
    resetChatLlm(null, { 'model-b': fake });
    expect(getChatLlm('model-b')).toBe(fake);
  });
});

describe('the page reader for a chosen model', () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'spine-model-')); resetParser(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.SPINE_MULTIMODAL_ENABLED; resetParser(); });

  it('reads the page with that model, and with the default one when none is named', async () => {
    process.env.SPINE_MULTIMODAL_ENABLED = 'true';
    process.env.SPINE_LLM_MODELS = 'model-b';
    const reader = (text: string) => ({
      readPage: vi.fn(async () => ({ regions: [{ text, x0: 0, y0: 0, x1: 1, y1: 1 }] })),
    });
    const [chosen, usual] = [reader('from model b'), reader('from the default')];
    resetChatLlm(usual as unknown as ChatLlm, { 'model-b': chosen as unknown as ChatLlm });

    const image = path.join(dir, 'p.png');
    writeFileSync(image, PNG);
    const input = { sourceFileId: 's', filePath: image, pages: [{ page_number: 1, image_path: image }] };

    const viaB = await getModelParser('model-b').parse(input);
    expect(viaB.pages[0].elements[0].text).toBe('from model b');
    expect(chosen.readPage).toHaveBeenCalledTimes(1);
    expect(usual.readPage).not.toHaveBeenCalled();

    const viaDefault = await getModelParser().parse(input);
    expect(viaDefault.pages[0].elements[0].text).toBe('from the default');
  });
});

describe('routes that take a model', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let cookie: string;
  beforeAll(async () => { app = await buildTestApp(); cookie = await loginSession(app); });
  afterAll(async () => { await app.close(); });
  beforeEach(() => { mockExtractFields.mockReset(); process.env.SPINE_LLM_MODELS = 'model-b=Model B'; });

  async function document() {
    const sf = await seedSourceFile({ status: 'done' });
    await seedPage(sf, { pageNumber: 1, rawText: 'some text' });
    const id = uuidv4();
    await getStore().documents.create(OWNER_ID, { id, sourceFileId: sf, pageStart: 1, pageEnd: 1, title: 'Report' });
    return { id, sf };
  }
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload, headers: { cookie } });

  it('lists the models on /api/capabilities, the default first', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/capabilities', headers: { cookie } })).json();
    expect(body.models).toHaveLength(2);
    expect(body.models[0]).toMatchObject({ default: true });
    expect(body.models[1]).toMatchObject({ id: 'model-b', label: 'Model B', default: false });
    expect(typeof body.models[1].endpoint === 'string' || body.models[1].endpoint === null).toBe(true);
  });

  it('extracts again with the model asked for, and with the default when none is', async () => {
    const { id } = await document();
    mockExtractFields.mockResolvedValue(EXTRACTION_FALLBACK);
    await post(`/api/documents/${id}/reextract`, { model: 'model-b' });
    expect(mockExtractFields.mock.calls[0][2]).toBe('model-b');

    mockExtractFields.mockClear();
    await post(`/api/documents/${id}/reextract`, {});
    expect(mockExtractFields.mock.calls[0][2]).toBeUndefined();
  });

  it('refuses a model that is not offered, before it reads anything', async () => {
    const { id, sf } = await document();
    const res = await post(`/api/documents/${id}/reextract`, { model: 'not-offered' });
    expect(res.statusCode).toBe(400);
    expect(mockExtractFields).not.toHaveBeenCalled();

    process.env.SPINE_MULTIMODAL_ENABLED = 'true';
    try {
      const pageIds = (await getStore().pages.listForSourceFile(OWNER_ID, sf)).map(p => p.id);
      const reading = await post(`/api/source-files/${sf}/ai-reading`, { page_ids: pageIds, model: 'not-offered' });
      expect(reading.statusCode).toBe(400);
      expect(reading.json()).toEqual({ error: 'that model is not offered' });
    } finally { delete process.env.SPINE_MULTIMODAL_ENABLED; }
  });
});
