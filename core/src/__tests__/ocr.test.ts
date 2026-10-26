import { describe, it, expect } from 'vitest';
import { parseTesseractTsv } from '../parser/ocr.js';

/**
 * The parser behind the screening: Tesseract's TSV. Its output format is what these pin
 * down; the figures were measured on real Tesseract output (see the sample, trimmed from
 * a real run).
 */

// Real column order from `tesseract img - tsv`.
const HEADER = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
const row = (block: number, par: number, line: number, word: number, left: number, top: number, w: number, h: number, conf: number, text: string) =>
  ['5', 1, block, par, line, word, left, top, w, h, conf, text].join('\t');

describe('parseTesseractTsv', () => {
  const tsv = [
    HEADER,
    '1\t1\t0\t0\t0\t0\t0\t0\t1300\t1000\t-1\t',          // page
    '2\t1\t1\t0\t0\t0\t100\t100\t900\t80\t-1\t',        // block
    '4\t1\t1\t1\t1\t0\t100\t100\t500\t40\t-1\t',        // line
    row(1, 1, 1, 1, 100, 100, 120, 40, 96, 'Pacientul'),
    row(1, 1, 1, 2, 240, 100, 80, 40, 92, 'prezintă'),
    row(1, 1, 2, 1, 100, 160, 60, 40, 55, 'dureri'),    // second line, weak
    row(1, 1, 2, 2, 180, 164, 150, 36, 30, 'lombare'),  // weak
  ].join('\n');

  it('groups words into lines with a box that covers them', () => {
    const { elements } = parseTesseractTsv(tsv, 3);

    expect(elements.map(e => e.text)).toEqual(['Pacientul prezintă', 'dureri lombare']);
    expect(elements[0].bbox).toEqual({ x0: 100, y0: 100, x1: 320, y1: 140 });
    expect(elements[1].bbox).toEqual({ x0: 100, y0: 160, x1: 330, y1: 200 });
    expect(elements.every(e => e.page_number === 3 && e.source === 'ocr')).toBe(true);
  });

  it('reports word count, mean confidence and the share of weak words', () => {
    const reading = parseTesseractTsv(tsv, 1);

    expect(reading.words).toBe(4);
    expect(reading.meanConfidence).toBeCloseTo((96 + 92 + 55 + 30) / 4);
    expect(reading.lowConfidenceShare).toBeCloseTo(0.5); // 55 and 30 are under 60
  });

  it('ignores layout rows (confidence -1) and empty text', () => {
    expect(parseTesseractTsv(tsv, 1).words).toBe(4);
    expect(parseTesseractTsv([HEADER, row(1, 1, 1, 1, 0, 0, 5, 5, 90, '   ')].join('\n'), 1).words).toBe(0);
  });

  it('reads a page with no words as nothing, which is how a tilted or blank page looks', () => {
    // Measured: print tilted 8 degrees or more gives Tesseract no words at all.
    const reading = parseTesseractTsv(`${HEADER}\n1\t1\t0\t0\t0\t0\t0\t0\t1300\t1000\t-1\t`, 1);
    expect(reading).toMatchObject({ words: 0, meanConfidence: 0, lowConfidenceShare: 1, elements: [] });
  });

  it('keeps boxes in the image’s own pixels, unscaled', () => {
    const { elements } = parseTesseractTsv([HEADER, row(1, 1, 1, 1, 12, 34, 56, 78, 95, 'x')].join('\n'), 1);
    expect(elements[0].bbox).toEqual({ x0: 12, y0: 34, x1: 68, y1: 112 });
  });
});
