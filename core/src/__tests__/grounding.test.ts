import { describe, it, expect } from 'vitest';
import { groundSnippet } from '../ingestion/grounding.js';
import type { UnstructuredElement } from '../types.js';

const el = (text: string, x0 = 0, y0 = 0, x1 = 100, y1 = 20): UnstructuredElement => ({
  type: 'NarrativeText',
  text,
  page_number: 1,
  bbox: { x0, y0, x1, y1 },
  source: 'native_text',
});

describe('groundSnippet', () => {
  it('returns fractional bbox on exact match', () => {
    const result = groundSnippet('blood pressure 120/80', [el('blood pressure 120/80', 10, 50, 200, 70)], 400, 200);
    expect(result.bbox_x0).toBeCloseTo(10 / 400);
    expect(result.bbox_y0).toBeCloseTo(50 / 200);
    expect(result.bbox_x1).toBeCloseTo(200 / 400);
    expect(result.bbox_y1).toBeCloseTo(70 / 200);
  });

  it('returns nulls for empty elements list', () => {
    const result = groundSnippet('something', [], 400, 200);
    expect(result.bbox_x0).toBeNull();
    expect(result.bbox_y0).toBeNull();
    expect(result.bbox_x1).toBeNull();
    expect(result.bbox_y1).toBeNull();
  });

  it('returns nulls for empty snippet', () => {
    const result = groundSnippet('', [el('some text')], 400, 200);
    expect(result.bbox_x0).toBeNull();
  });

  it('returns nulls when matched element has no bbox', () => {
    const noBox: UnstructuredElement = { type: 'Text', text: 'hello', page_number: 1, bbox: null, source: 'native_text' };
    const result = groundSnippet('hello', [noBox], 400, 200);
    expect(result.bbox_x0).toBeNull();
  });

  it('finds the right element when snippet is a substring', () => {
    const elements = [
      el('unrelated', 0, 0, 100, 20),
      el('diagnosis: hypertension grade II', 0, 100, 300, 120),
    ];
    const result = groundSnippet('hypertension', elements, 300, 200);
    expect(result.bbox_y0).toBeCloseTo(100 / 200);
  });

  it('fuzzy-matches when snippet is not an exact substring', () => {
    // OCR may introduce minor character differences
    const elements = [el('haemoglobin: 13.5 g/dL', 0, 40, 250, 60)];
    const result = groundSnippet('hemoglobin: 13.5 g/dL', elements, 250, 100);
    // Long common substring — should still match
    expect(result.bbox_x0).not.toBeNull();
  });

  it('returns nulls when no element is close enough', () => {
    const elements = [el('total bilirubin', 0, 0, 100, 20)];
    const result = groundSnippet('completely unrelated text xyz', elements, 100, 100);
    expect(result.bbox_x0).toBeNull();
  });
});
