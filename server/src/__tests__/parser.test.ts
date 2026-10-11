import { describe, it, expect, vi } from 'vitest';
import { createParser, PARSERS, ParserConfigError } from '../parser/index.js';
import type { ParserDeps } from '../parser/deps.js';
import type { ParserConfig } from '../parser/types.js';
import type { OcrReading } from '../parser/ocr.js';
import type { PageReading } from '../llm/types.js';
import type { ParseResponse, UnstructuredElement } from '../types.js';
import { groundSnippet } from '../ingestion/grounding.js';
import { loadConfig, loadParserConfig } from '../config.js';

/**
 * The parser interface's contract: one entry per page image, in order, with boxes in
 * that image's pixel space. And M-7: nothing that can send an image runs unless it
 * was asked for twice.
 */

// An A4 page as the sidecar sees native text (PDF points, 72 per inch) and as the
// rasterizer renders it (200 DPI).
const POINTS = { w: 595, h: 842 };
const PIXELS = { w: 1654, h: 2339 };

const input = (count: number) => ({
  sourceFileId: 'sf-1',
  filePath: '/data/originals/u/2026/x.pdf',
  pages: Array.from({ length: count }, (_, i) => ({
    page_number: i + 1,
    image_path: `/data/pages/sf-1/page-${i + 1}.png`,
  })),
});

const el = (text: string, bbox: UnstructuredElement['bbox'], source: UnstructuredElement['source'] = 'native_text'): UnstructuredElement =>
  ({ type: 'NarrativeText', text, page_number: 1, bbox, source });

function sidecarPage(n: number, elements: UnstructuredElement[], source: 'native_text' | 'ocr' | 'mixed' = 'native_text') {
  return { page_number: n, elements, extraction_source: source, image_width: POINTS.w, image_height: POINTS.h };
}

const cfg = (mode: string, multimodalEnabled = false): ParserConfig => ({
  mode, multimodalEnabled,
  textLayerMinChars: 50, ocrMinConfidence: 85, ocrMaxLowShare: 0.1, ocrLangs: 'ron+eng',
});

/** A local OCR reading with the figures the routing looks at. */
const ocr = (words: number, meanConfidence: number, lowConfidenceShare = 0, text = 'local ocr text'): OcrReading => ({
  words, meanConfidence, lowConfidenceShare,
  elements: words === 0 ? [] : [{ type: 'Text', text, page_number: 1, source: 'ocr', bbox: { x0: 10, y0: 10, x1: 400, y1: 40 } }],
});

function deps(over: {
  sidecar?: ParseResponse | Error;
  readPage?: (path: string) => Promise<PageReading | null>;
  ocrPage?: (path: string, page: number) => Promise<OcrReading>;
} = {}) {
  const readPage = vi.fn(over.readPage ?? (async () => null));
  const ocrPage = vi.fn(over.ocrPage ?? (async () => ocr(60, 93)));
  const sidecar = vi.fn(async () => {
    if (over.sidecar instanceof Error) throw over.sidecar;
    return over.sidecar ?? { pages: [] };
  });
  const logs = { info: vi.fn(), warn: vi.fn() };
  const d: ParserDeps = {
    sidecar,
    imageSize: () => ({ width: PIXELS.w, height: PIXELS.h }),
    ocrPage,
    readPage,
    logger: logs,
  };
  return { d, readPage, ocrPage, sidecar, logs };
}

const reading = (...regions: Array<[string, number, number, number, number]>): PageReading => ({
  regions: regions.map(([text, x0, y0, x1, y1]) => ({ text, x0, y0, x1, y1 })),
});

describe('the sidecar parser', () => {
  it('scales its boxes from PDF points into the page image’s pixels', async () => {
    const box = { x0: 59.5, y0: 84.2, x1: 297.5, y1: 126.3 };
    const { d } = deps({ sidecar: { pages: [sidecarPage(1, [el('Diagnostic', box)])] } });

    const page = (await createParser(cfg('sidecar'), d).parse(input(1))).pages[0];

    expect(page.image_width).toBe(PIXELS.w);
    expect(page.elements[0].bbox!.x0).toBeCloseTo(box.x0 * (PIXELS.w / POINTS.w), 5);
    expect(page.elements[0].bbox!.y1).toBeCloseTo(box.y1 * (PIXELS.h / POINTS.h), 5);
  });

  it('keeps a box at the same place on the page: the fraction does not change', async () => {
    const box = { x0: 59.5, y0: 84.2, x1: 297.5, y1: 126.3 };
    const { d } = deps({ sidecar: { pages: [sidecarPage(1, [el('Diagnostic', box)])] } });
    const page = (await createParser(cfg('sidecar'), d).parse(input(1))).pages[0];

    // What grounding stores, using the page image's size as the pipeline now does.
    const grounded = groundSnippet('Diagnostic', page.elements, page.image_width, page.image_height);

    expect(grounded.bbox_x0).toBeCloseTo(box.x0 / POINTS.w, 6);
    expect(grounded.bbox_y0).toBeCloseTo(box.y0 / POINTS.h, 6);
    expect(grounded.bbox_x1).toBeCloseTo(box.x1 / POINTS.w, 6);
    expect(grounded.bbox_y1).toBeCloseTo(box.y1 / POINTS.h, 6);
  });

  it('returns an entry for every page image even when the sidecar leaves one out', async () => {
    // Page 2 is blank, so the sidecar returns pages 1 and 3 only.
    const { d } = deps({ sidecar: { pages: [
      sidecarPage(1, [el('one', { x0: 0, y0: 0, x1: 10, y1: 10 })]),
      sidecarPage(3, [el('three', { x0: 0, y0: 0, x1: 10, y1: 10 })]),
    ] } });

    const { pages } = await createParser(cfg('sidecar'), d).parse(input(3));

    expect(pages.map(p => p.page_number)).toEqual([1, 2, 3]);
    expect(pages[1].elements).toEqual([]);
    expect(pages[2].elements[0].text).toBe('three'); // not shifted onto page 2's image
  });

  it('leaves a box alone when the sidecar gave no coordinate system to scale from', async () => {
    const box = { x0: 5, y0: 6, x1: 7, y1: 8 };
    const page = { ...sidecarPage(1, [el('x', box)]), image_width: 0, image_height: 0 };
    const { d } = deps({ sidecar: { pages: [page] } });

    const out = (await createParser(cfg('sidecar'), d).parse(input(1))).pages[0];
    expect(out.elements[0].bbox).toEqual(box);
  });

  it('keeps a missing box missing', async () => {
    const { d } = deps({ sidecar: { pages: [sidecarPage(1, [el('no coordinates', null)])] } });
    const out = (await createParser(cfg('sidecar'), d).parse(input(1))).pages[0];
    expect(out.elements[0].bbox).toBeNull();
  });

  it('never sends an image', async () => {
    const { d, readPage } = deps({ sidecar: { pages: [sidecarPage(1, [], 'ocr')] } });
    const parser = createParser(cfg('sidecar'), d);

    await parser.parse(input(1));

    expect(parser.imageEgress).toBe(false);
    expect(readPage).not.toHaveBeenCalled();
  });
});

describe('the multimodal parser', () => {
  const config = cfg('multimodal', true);

  it('turns the model’s fractions into pixel boxes', async () => {
    const { d } = deps({ readPage: async () => reading(['Diagnostic: anemie', 0.1, 0.2, 0.6, 0.25]) });
    const page = (await createParser(config, d).parse(input(1))).pages[0];

    expect(page.extraction_source).toBe('multimodal');
    expect(page.elements[0]).toMatchObject({ text: 'Diagnostic: anemie', source: 'multimodal' });
    expect(page.elements[0].bbox!.x0).toBeCloseTo(0.1 * PIXELS.w);
    expect(page.elements[0].bbox!.y1).toBeCloseTo(0.25 * PIXELS.h);
  });

  it('reads every page, from its own image, and never calls the sidecar', async () => {
    const { d, readPage } = deps({ readPage: async () => reading(['x', 0, 0, 1, 1]) });
    await createParser(config, d).parse(input(3));

    expect(readPage.mock.calls.map(c => c[0])).toEqual([
      '/data/pages/sf-1/page-1.png', '/data/pages/sf-1/page-2.png', '/data/pages/sf-1/page-3.png',
    ]);
    expect(d.sidecar).not.toHaveBeenCalled();
  });

  it('keeps a blank page as an empty entry rather than failing', async () => {
    const { d } = deps({ readPage: async () => ({ regions: [] }) });
    const page = (await createParser(config, d).parse(input(1))).pages[0];
    expect(page.elements).toEqual([]);
  });

  it('fails the upload, naming the page, when an answer is unusable', async () => {
    const { d } = deps({ readPage: async path => (path.endsWith('page-2.png') ? null : reading(['ok', 0, 0, 1, 1])) });
    await expect(createParser(config, d).parse(input(3))).rejects.toThrow(/page 2 could not be read/);
  });

  it('lets a provider failure through, since there is nothing to fall back to', async () => {
    const { d } = deps({ readPage: async () => { throw new Error('503 from provider'); } });
    await expect(createParser(config, d).parse(input(1))).rejects.toThrow('503 from provider');
  });

  it('logs each image it sends, and says it can send images', async () => {
    const { d, logs } = deps({ readPage: async () => reading(['x', 0, 0, 1, 1]) });
    const parser = createParser(config, d);
    await parser.parse(input(2));

    expect(parser.imageEgress).toBe(true);
    expect(logs.info).toHaveBeenCalledTimes(2);
    expect(logs.info).toHaveBeenCalledWith('sending a page image to the model provider', expect.objectContaining({ page: 2 }));
  });
});

describe('the hybrid parser: text layer, then local OCR, then the model', () => {
  const config = cfg('hybrid', true);
  const box = { x0: 0, y0: 0, x1: 10, y1: 10 };

  /** A page the sidecar returned `chars` characters of text for. A page it returns nothing for is a scan. */
  const text = (n: number, chars = 500) => sidecarPage(n, [el('x'.repeat(chars), box)], 'native_text');

  it('uses a page’s text layer and never runs OCR or the model on it', async () => {
    const { d, ocrPage, readPage } = deps({ sidecar: { pages: [text(1), text(2)] } });
    const { pages } = await createParser(config, d).parse(input(2));

    expect(pages.map(p => p.extraction_source)).toEqual(['native_text', 'native_text']);
    expect(ocrPage).not.toHaveBeenCalled();
    expect(readPage).not.toHaveBeenCalled();
  });

  it('keeps local OCR, and sends nothing, when OCR is confident', async () => {
    // The sidecar returned nothing for the page: it has no text layer.
    const { d, readPage, ocrPage } = deps({ ocrPage: async () => ocr(64, 93, 0) });
    const { pages } = await createParser(config, d).parse(input(1));

    expect(ocrPage).toHaveBeenCalledTimes(1);
    expect(readPage).not.toHaveBeenCalled();
    expect(pages[0].extraction_source).toBe('ocr');
    expect(pages[0].elements[0].source).toBe('ocr');
  });

  it('still keeps OCR for lightly tilted print: 87 with 6% weak words', async () => {
    // Measured: print tilted 3 degrees reads at 87 with 6% under 60, and every word was right.
    const { d, readPage } = deps({ ocrPage: async () => ocr(64, 87, 0.06) });
    await createParser(config, d).parse(input(1));
    expect(readPage).not.toHaveBeenCalled();
  });

  it.each([
    ['handwriting-style: 80 with 17% weak words', ocr(64, 80, 0.17)],
    ['confidence just under the line', ocr(64, 84.9, 0)],
    ['too many weak words', ocr(64, 92, 0.11)],
    ['no words at all (tilted past about 8 degrees, or blank)', ocr(0, 0, 1)],
  ])('sends the page to the model when %s', async (_name, reading) => {
    const { d, readPage } = deps({
      ocrPage: async () => reading,
      readPage: async () => ({ regions: [{ text: 'from the model', x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.2 }] }),
    });
    const { pages } = await createParser(config, d).parse(input(1));

    expect(readPage).toHaveBeenCalledTimes(1);
    expect(pages[0].extraction_source).toBe('multimodal');
    expect(pages[0].elements[0].text).toBe('from the model');
  });

  it('treats a page whose only text is a stray page number as having no text layer', async () => {
    const { d, ocrPage } = deps({ sidecar: { pages: [sidecarPage(1, [el('7', box)])] } });
    await createParser(config, d).parse(input(1));
    expect(ocrPage).toHaveBeenCalledTimes(1);
  });

  it('counts the characters across all of a page’s elements', async () => {
    // Three short lines that add up to enough text.
    const lines = ['a'.repeat(20), 'b'.repeat(20), 'c'.repeat(20)].map(t => el(t, box));
    const { d, ocrPage } = deps({ sidecar: { pages: [sidecarPage(1, lines)] } });
    await createParser(config, d).parse(input(1));
    expect(ocrPage).not.toHaveBeenCalled();
  });

  it('routes each page on its own in one document', async () => {
    // 1 typed, 2 confident scan, 3 handwriting, 4 typed. The sidecar returns only 1 and 4.
    const readings: Record<number, OcrReading> = { 2: ocr(60, 92), 3: ocr(50, 70, 0.3) };
    const { d, ocrPage, readPage } = deps({
      sidecar: { pages: [text(1), text(4)] },
      ocrPage: async (_p, n) => readings[n],
      readPage: async () => ({ regions: [{ text: 'handwritten', x0: 0, y0: 0, x1: 1, y1: 1 }] }),
    });
    const { pages } = await createParser(config, d).parse(input(4));

    expect(pages.map(p => p.extraction_source)).toEqual(['native_text', 'ocr', 'multimodal', 'native_text']);
    expect(ocrPage.mock.calls.map(c => c[1])).toEqual([2, 3]);
    expect(readPage.mock.calls.map(c => c[0])).toEqual(['/data/pages/sf-1/page-3.png']);
  });

  it('asks the sidecar once for the whole file', async () => {
    const { d, sidecar } = deps({ sidecar: { pages: [text(1)] }, ocrPage: async () => ocr(60, 93) });
    await createParser(config, d).parse(input(3));
    expect(sidecar).toHaveBeenCalledTimes(1);
  });

  it('fails the upload, and sends nothing, when the sidecar is down', async () => {
    // Treating every page as scanned would push digital PDFs through OCR and then the model
    // because of an outage. A retry costs nothing.
    const { d, ocrPage, readPage } = deps({ sidecar: new Error('Ingestion sidecar error 503') });

    await expect(createParser(config, d).parse(input(2))).rejects.toThrow(/sidecar error 503/);
    expect(ocrPage).not.toHaveBeenCalled();
    expect(readPage).not.toHaveBeenCalled();
  });

  it('keeps local OCR when the model fails, and says so', async () => {
    const { d, logs } = deps({
      ocrPage: async () => ocr(30, 60, 0.4, 'weak but something'),
      readPage: async () => { throw new Error('rate limited'); },
    });
    const { pages } = await createParser(config, d).parse(input(1));

    expect(pages[0].extraction_source).toBe('ocr');
    expect(pages[0].elements[0].text).toBe('weak but something');
    expect(logs.warn).toHaveBeenCalledWith(expect.stringMatching(/keeping local OCR/), expect.objectContaining({ error: 'rate limited' }));
  });

  it('keeps local OCR when the model’s answer is unusable or empty', async () => {
    for (const answer of [null, { regions: [] }]) {
      const { d } = deps({ ocrPage: async () => ocr(30, 60, 0.4, 'weak'), readPage: async () => answer });
      const { pages } = await createParser(config, d).parse(input(1));
      expect(pages[0].elements[0].text).toBe('weak');
    }
  });

  it('never loses a page: if OCR and the model both fail it comes back empty', async () => {
    const { d } = deps({
      ocrPage: async () => { throw new Error('tesseract crashed'); },
      readPage: async () => { throw new Error('down'); },
    });
    const { pages } = await createParser(config, d).parse(input(1));
    expect(pages).toHaveLength(1);
    expect(pages[0].elements).toEqual([]);
  });

  it('sends the model only the pages that need it, from their own images', async () => {
    const { d, readPage } = deps({
      ocrPage: async (_p, n) => (n === 2 ? ocr(0, 0, 1) : ocr(60, 93)),
      readPage: async () => ({ regions: [{ text: 'x', x0: 0, y0: 0, x1: 1, y1: 1 }] }),
    });
    await createParser(config, d).parse(input(3));
    expect(readPage.mock.calls.map(c => c[0])).toEqual(['/data/pages/sf-1/page-2.png']);
  });

  it('logs the route and the figures for every page, so thresholds can be tuned', async () => {
    const { d, logs } = deps({ ocrPage: async () => ocr(50, 78, 0.2) });
    await createParser(config, d).parse(input(1));

    expect(logs.info).toHaveBeenCalledWith('page routed', expect.objectContaining({
      page: 1, route: 'model', words: 50, meanConfidence: 78, lowShare: 0.2, why: expect.stringMatching(/confidence 78 is below 85/),
    }));
  });

  it('logs a text-layer page with how much text it had', async () => {
    const { d, logs } = deps({ sidecar: { pages: [text(1, 321)] } });
    await createParser(config, d).parse(input(1));
    expect(logs.info).toHaveBeenCalledWith('page routed', expect.objectContaining({ page: 1, route: 'text_layer', textChars: 321 }));
  });

  it('honours the thresholds it is given', async () => {
    const strict = { ...config, ocrMinConfidence: 95 };
    const { d, readPage } = deps({ ocrPage: async () => ocr(64, 93), readPage: async () => null });
    await createParser(strict, d).parse(input(1));
    expect(readPage).toHaveBeenCalledTimes(1);

    // And the minimum text for a layer: 40 characters passes at 30, fails at the default 50.
    const lenient = { ...config, textLayerMinChars: 30 };
    const forty = deps({ sidecar: { pages: [text(1, 40)] } });
    await createParser(lenient, forty.d).parse(input(1));
    expect(forty.ocrPage).not.toHaveBeenCalled();

    const dflt = deps({ sidecar: { pages: [text(1, 40)] } });
    await createParser(config, dflt.d).parse(input(1));
    expect(dflt.ocrPage).toHaveBeenCalledTimes(1);
  });

  it('says it can send images', () => {
    expect(createParser(config, deps().d).imageEgress).toBe(true);
  });
});

/** SECURITY.md M-7: asked for twice, so choosing a parser never turns it on by implication. */
describe('image egress needs two switches', () => {
  const base = { SESSION_SECRET: 'a'.repeat(32) };

  it('defaults to the sidecar, with no egress', () => {
    expect(loadParserConfig({})).toMatchObject({ mode: 'sidecar', multimodalEnabled: false });
  });

  it.each(['multimodal', 'hybrid'])('refuses SPINE_PARSER=%s without the second switch', mode => {
    expect(() => loadConfig({ ...base, SPINE_PARSER: mode })).toThrow(/SPINE_MULTIMODAL_ENABLED=true/);
    expect(() => createParser(cfg(mode, false), deps().d)).toThrow(ParserConfigError);
  });

  it.each(['multimodal', 'hybrid'])('accepts %s once both are set', mode => {
    expect(loadConfig({ ...base, SPINE_PARSER: mode, SPINE_MULTIMODAL_ENABLED: 'true' }).parser)
      .toMatchObject({ mode, multimodalEnabled: true });
  });

  it('does not treat the second switch alone as asking for images', () => {
    const parser = createParser(cfg('sidecar', true), deps().d);
    expect(parser.imageEgress).toBe(false);
  });

  it('rejects an unknown parser, naming the valid ones', () => {
    expect(() => loadConfig({ ...base, SPINE_PARSER: 'tesseract' })).toThrow(/expected one of sidecar, multimodal, hybrid/);
    expect(() => createParser(cfg('tesseract', false), deps().d)).toThrow(/expected one of/);
  });

  it('lists the adapters that exist', () => {
    expect(PARSERS.sort()).toEqual(['hybrid', 'multimodal', 'sidecar']);
  });
});

describe('the screening thresholds in config', () => {
  it('default to values measured on print, tilted print and handwriting-style text', () => {
    expect(loadParserConfig({})).toMatchObject({
      textLayerMinChars: 50, ocrMinConfidence: 85, ocrMaxLowShare: 0.1, ocrLangs: 'ron+eng',
    });
  });

  it('can be set', () => {
    expect(loadParserConfig({
      SPINE_TEXT_LAYER_MIN_CHARS: '30', SPINE_OCR_MIN_CONFIDENCE: '90',
      SPINE_OCR_MAX_LOW_SHARE: '0.05', SPINE_OCR_LANGS: 'eng',
    })).toMatchObject({ textLayerMinChars: 30, ocrMinConfidence: 90, ocrMaxLowShare: 0.05, ocrLangs: 'eng' });
  });

  it.each([
    ['SPINE_OCR_MIN_CONFIDENCE', '150'],
    ['SPINE_OCR_MAX_LOW_SHARE', '1.5'],
    ['SPINE_TEXT_LAYER_MIN_CHARS', '0'],
    ['SPINE_OCR_MIN_CONFIDENCE', 'high'],
    ['SPINE_OCR_LANGS', 'ron, eng'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => loadParserConfig({ [name]: value })).toThrow(new RegExp(name));
  });
});
