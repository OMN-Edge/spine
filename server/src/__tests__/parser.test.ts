import { describe, it, expect, vi } from 'vitest';
import { createParser, PARSERS, ParserConfigError } from '../parser/index.js';
import type { ParserDeps } from '../parser/deps.js';
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

function deps(over: {
  sidecar?: ParseResponse;
  readPage?: (path: string) => Promise<PageReading | null>;
} = {}) {
  const readPage = vi.fn(over.readPage ?? (async () => null));
  const logs = { info: vi.fn(), warn: vi.fn() };
  const d: ParserDeps = {
    sidecar: vi.fn(async () => over.sidecar ?? { pages: [] }),
    imageSize: () => ({ width: PIXELS.w, height: PIXELS.h }),
    readPage,
    logger: logs,
  };
  return { d, readPage, logs };
}

const reading = (...regions: Array<[string, number, number, number, number]>): PageReading => ({
  regions: regions.map(([text, x0, y0, x1, y1]) => ({ text, x0, y0, x1, y1 })),
});

describe('the sidecar parser', () => {
  it('scales its boxes from PDF points into the page image’s pixels', async () => {
    const box = { x0: 59.5, y0: 84.2, x1: 297.5, y1: 126.3 };
    const { d } = deps({ sidecar: { pages: [sidecarPage(1, [el('Diagnostic', box)])] } });

    const page = (await createParser({ mode: 'sidecar', multimodalEnabled: false }, d).parse(input(1))).pages[0];

    expect(page.image_width).toBe(PIXELS.w);
    expect(page.elements[0].bbox!.x0).toBeCloseTo(box.x0 * (PIXELS.w / POINTS.w), 5);
    expect(page.elements[0].bbox!.y1).toBeCloseTo(box.y1 * (PIXELS.h / POINTS.h), 5);
  });

  it('keeps a box at the same place on the page: the fraction does not change', async () => {
    const box = { x0: 59.5, y0: 84.2, x1: 297.5, y1: 126.3 };
    const { d } = deps({ sidecar: { pages: [sidecarPage(1, [el('Diagnostic', box)])] } });
    const page = (await createParser({ mode: 'sidecar', multimodalEnabled: false }, d).parse(input(1))).pages[0];

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

    const { pages } = await createParser({ mode: 'sidecar', multimodalEnabled: false }, d).parse(input(3));

    expect(pages.map(p => p.page_number)).toEqual([1, 2, 3]);
    expect(pages[1].elements).toEqual([]);
    expect(pages[2].elements[0].text).toBe('three'); // not shifted onto page 2's image
  });

  it('leaves a box alone when the sidecar gave no coordinate system to scale from', async () => {
    const box = { x0: 5, y0: 6, x1: 7, y1: 8 };
    const page = { ...sidecarPage(1, [el('x', box)]), image_width: 0, image_height: 0 };
    const { d } = deps({ sidecar: { pages: [page] } });

    const out = (await createParser({ mode: 'sidecar', multimodalEnabled: false }, d).parse(input(1))).pages[0];
    expect(out.elements[0].bbox).toEqual(box);
  });

  it('keeps a missing box missing', async () => {
    const { d } = deps({ sidecar: { pages: [sidecarPage(1, [el('no coordinates', null)])] } });
    const out = (await createParser({ mode: 'sidecar', multimodalEnabled: false }, d).parse(input(1))).pages[0];
    expect(out.elements[0].bbox).toBeNull();
  });

  it('never sends an image', async () => {
    const { d, readPage } = deps({ sidecar: { pages: [sidecarPage(1, [], 'ocr')] } });
    const parser = createParser({ mode: 'sidecar', multimodalEnabled: false }, d);

    await parser.parse(input(1));

    expect(parser.imageEgress).toBe(false);
    expect(readPage).not.toHaveBeenCalled();
  });
});

describe('the multimodal parser', () => {
  const config = { mode: 'multimodal', multimodalEnabled: true };

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

describe('the hybrid parser', () => {
  const config = { mode: 'hybrid', multimodalEnabled: true };
  const box = { x0: 0, y0: 0, x1: 10, y1: 10 };

  // Page 1 native text, 2 scanned, 3 mixed, 4 blank (left out by the sidecar), 5 scanned.
  const sidecar = (): ParseResponse => ({ pages: [
    sidecarPage(1, [el('native one', box)], 'native_text'),
    sidecarPage(2, [el('garbled handwriting', box, 'ocr')], 'ocr'),
    sidecarPage(3, [el('partly native', box), el('partly ocr', box, 'ocr')], 'mixed'),
    sidecarPage(5, [el('another scan', box, 'ocr')], 'ocr'),
  ] });

  it('sends only the scanned and blank pages — never a native-text or mixed page', async () => {
    const { d, readPage } = deps({ sidecar: sidecar(), readPage: async () => reading(['from model', 0, 0, 1, 1]) });
    await createParser(config, d).parse(input(5));

    expect(readPage.mock.calls.map(c => c[0])).toEqual([
      '/data/pages/sf-1/page-2.png', '/data/pages/sf-1/page-4.png', '/data/pages/sf-1/page-5.png',
    ]);
  });

  it('replaces those pages with the model’s reading and leaves the rest untouched', async () => {
    const { d } = deps({ sidecar: sidecar(), readPage: async () => reading(['from model', 0.1, 0.1, 0.5, 0.2]) });
    const { pages } = await createParser(config, d).parse(input(5));

    expect(pages.map(p => p.extraction_source)).toEqual(['native_text', 'multimodal', 'mixed', 'multimodal', 'multimodal']);
    expect(pages[0].elements[0].text).toBe('native one');
    expect(pages[2].elements.map(e => e.text)).toEqual(['partly native', 'partly ocr']);
    expect(pages[1].elements.map(e => e.text)).toEqual(['from model']);
    expect(pages[3].elements.map(e => e.text)).toEqual(['from model']); // the blank one
  });

  it('keeps the sidecar’s result when the model fails, and says so', async () => {
    const { d, logs } = deps({ sidecar: sidecar(), readPage: async () => { throw new Error('rate limited'); } });
    const { pages } = await createParser(config, d).parse(input(5));

    expect(pages[1].extraction_source).toBe('ocr');
    expect(pages[1].elements[0].text).toBe('garbled handwriting');
    expect(logs.warn).toHaveBeenCalledWith(expect.stringMatching(/could not read a page/), expect.objectContaining({ error: 'rate limited' }));
  });

  it('keeps the sidecar’s result when the answer is unusable or empty', async () => {
    for (const answer of [null, { regions: [] }]) {
      const { d } = deps({ sidecar: sidecar(), readPage: async () => answer });
      const { pages } = await createParser(config, d).parse(input(5));
      expect(pages[1].elements[0].text).toBe('garbled handwriting');
      expect(pages[1].extraction_source).toBe('ocr');
    }
  });

  it('improves a page and never loses one: every input page comes back', async () => {
    const { d } = deps({ sidecar: sidecar(), readPage: async () => { throw new Error('down'); } });
    const { pages } = await createParser(config, d).parse(input(5));
    expect(pages.map(p => p.page_number)).toEqual([1, 2, 3, 4, 5]);
  });

  it('sends nothing when every page is native text', async () => {
    const native: ParseResponse = { pages: [sidecarPage(1, [el('a', box)]), sidecarPage(2, [el('b', box)])] };
    const { d, readPage } = deps({ sidecar: native });
    await createParser(config, d).parse(input(2));
    expect(readPage).not.toHaveBeenCalled();
  });

  it('says it can send images', () => {
    expect(createParser(config, deps().d).imageEgress).toBe(true);
  });
});

/** SECURITY.md M-7: asked for twice, so choosing a parser never turns it on by implication. */
describe('image egress needs two switches', () => {
  const base = { SESSION_SECRET: 'a'.repeat(32) };

  it('defaults to the sidecar, with no egress', () => {
    expect(loadParserConfig({})).toEqual({ mode: 'sidecar', multimodalEnabled: false });
  });

  it.each(['multimodal', 'hybrid'])('refuses SPINE_PARSER=%s without the second switch', mode => {
    expect(() => loadConfig({ ...base, SPINE_PARSER: mode })).toThrow(/SPINE_MULTIMODAL_ENABLED=true/);
    expect(() => createParser({ mode, multimodalEnabled: false }, deps().d)).toThrow(ParserConfigError);
  });

  it.each(['multimodal', 'hybrid'])('accepts %s once both are set', mode => {
    expect(loadConfig({ ...base, SPINE_PARSER: mode, SPINE_MULTIMODAL_ENABLED: 'true' }).parser)
      .toEqual({ mode, multimodalEnabled: true });
  });

  it('does not treat the second switch alone as asking for images', () => {
    const parser = createParser({ mode: 'sidecar', multimodalEnabled: true }, deps().d);
    expect(parser.imageEgress).toBe(false);
  });

  it('rejects an unknown parser, naming the valid ones', () => {
    expect(() => loadConfig({ ...base, SPINE_PARSER: 'tesseract' })).toThrow(/expected one of sidecar, multimodal, hybrid/);
    expect(() => createParser({ mode: 'tesseract', multimodalEnabled: false }, deps().d)).toThrow(/expected one of/);
  });

  it('lists the adapters that exist', () => {
    expect(PARSERS.sort()).toEqual(['hybrid', 'multimodal', 'sidecar']);
  });
});
