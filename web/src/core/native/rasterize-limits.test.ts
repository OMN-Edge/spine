import { describe, it, expect } from 'vitest';
import { MAX_KEPT_BYTES, MAX_PAGE_PIXELS, MAX_PDF_PAGES, PdfTooLargeError, RENDER_SCALE, checkKeptBytes, checkPageCount, scaleFor } from './rasterize-limits';

/** SECURITY.md S-55: what a PDF may ask of the device when its pages are drawn. */
describe('the limits on drawing a PDF into page images', () => {
  it('keeps the usual 200 DPI for an ordinary page, A4 and a large poster up to A2', () => {
    expect(scaleFor(595.28, 841.89)).toBe(RENDER_SCALE);
    expect(scaleFor(1190, 1684)).toBe(RENDER_SCALE);
  });

  it('draws a bigger page smaller, so its image has at most the pixel ceiling, whatever size it declares', () => {
    for (const side of [2000, 5000, 14_000, 1_000_000]) {
      const scale = scaleFor(side, side);
      expect(scale).toBeLessThan(RENDER_SCALE);
      expect(Math.ceil(side * scale) ** 2).toBeLessThanOrEqual(MAX_PAGE_PIXELS * 1.001);
    }
    // a long strip too
    expect(Math.ceil(100 * scaleFor(100, 1_000_000)) * Math.ceil(1_000_000 * scaleFor(100, 1_000_000))).toBeLessThanOrEqual(MAX_PAGE_PIXELS * 1.01);
  });

  it('does not let a page of no size or a size that is not a number through as an enormous scale', () => {
    expect(scaleFor(0, 0)).toBe(RENDER_SCALE);
    expect(scaleFor(NaN, 100)).toBe(RENDER_SCALE);
  });

  it('refuses more pages than the ceiling, with words a person can act on', () => {
    expect(() => checkPageCount(MAX_PDF_PAGES)).not.toThrow();
    expect(() => checkPageCount(MAX_PDF_PAGES + 1)).toThrow(PdfTooLargeError);
    expect(() => checkPageCount(300_000)).toThrow(/Split it/);
  });

  it('refuses images kept past the byte budget', () => {
    expect(() => checkKeptBytes(MAX_KEPT_BYTES)).not.toThrow();
    expect(() => checkKeptBytes(MAX_KEPT_BYTES + 1)).toThrow(PdfTooLargeError);
  });
});
