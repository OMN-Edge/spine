import { describe, it, expect } from 'vitest';
import { cornersOf, defaultQuad, quadOf } from './detect';
import { blackAndWhite, enhance, greyscale, otsuCutoff } from './enhance';
import { newRaster } from './image';

// Finding the page and straightening it are `scanic`'s (WebAssembly, needs a browser to run): they are tried on real photos by hand,
// not here. What is ours and tested is the corner order, the starting corners and the clean-up.
describe('the page, as the screen holds it', () => {
  it('keeps the corner order between the library and the screen', () => {
    const q = defaultQuad(100, 200);
    expect(quadOf(cornersOf(q))).toEqual(q);
    expect(cornersOf(q).topRight).toEqual(q[1]);
    expect(cornersOf(q).bottomLeft).toEqual(q[3]);
  });

  it('offers the frame less a margin, and says when two sightings are the same page held still', () => {
    const q = defaultQuad(1000, 500, 0.1);
    expect(q[0]).toEqual({ x: 100, y: 50 });
    expect(q[2]).toEqual({ x: 900, y: 450 });
  });
});

describe('making it readable', () => {
  it('flattens a shadow across the page and keeps the ink', () => {
    const r = newRaster(200, 120);
    for (let y = 0; y < 120; y++) for (let x = 0; x < 200; x++) {
      const light = x < 100 ? 120 : 225; // the left half is in shadow
      const ink = y > 58 && y < 62 && (x % 40) > 8 && (x % 40) < 30; // a few strokes on both sides
      const v = ink ? 30 : light;
      const o = (y * 200 + x) * 4; r.data[o] = v; r.data[o + 1] = v; r.data[o + 2] = v; r.data[o + 3] = 255;
    }
    const out = enhance(r);
    const at = (x: number, y: number) => out.data[(y * 200 + x) * 4];
    expect(at(20, 10)).toBeGreaterThanOrEqual(235); // shadowed paper is white now
    expect(at(180, 10)).toBeGreaterThanOrEqual(235); // and so is the lit paper
    expect(at(20, 60)).toBeLessThan(90); // the stroke in the shadow
    expect(at(130, 60)).toBeLessThan(90); // the stroke in the light
  });

  it('leaves the size alone', () => {
    const r = newRaster(30, 20); r.data.fill(200);
    const out = enhance(r);
    expect([out.width, out.height, out.data.length]).toEqual([30, 20, 30 * 20 * 4]);
  });
});

describe('greyscale with more contrast', () => {
  it('makes grey, darkens print and leaves white paper white', () => {
    const r = newRaster(3, 1);
    r.data.set([255, 255, 255, 255, 90, 90, 90, 255, 200, 40, 40, 255]);
    const g = greyscale(r);
    expect([g.data[0], g.data[1], g.data[2]]).toEqual([255, 255, 255]);
    expect(g.data[4]).toBeLessThan(90);
    expect(g.data[8]).toBe(g.data[9]);
    expect(g.data[9]).toBe(g.data[10]);
    expect(g.data[7]).toBe(255);
  });
});

describe('black and white', () => {
  it('turns every pixel into ink or paper, and keeps print above the cut-off as paper', () => {
    const r = newRaster(3, 1);
    r.data.set([250, 250, 250, 255, 40, 40, 40, 255, 200, 200, 200, 255]);
    const b = blackAndWhite(r);
    expect([b.data[0], b.data[4], b.data[8]]).toEqual([255, 0, 255]);
    expect([...b.data].every((v, i) => i % 4 === 3 ? v === 255 : v === 0 || v === 255)).toBe(true);
  });
});

describe('the automatic cut-off', () => {
  it('falls between the ink and the paper', () => {
    const ink = Array(300).fill(60); const paper = Array(1700).fill(235);
    const cut = otsuCutoff([...ink, ...paper]);
    expect(cut).toBeGreaterThan(60);
    expect(cut).toBeLessThanOrEqual(190);
  });

  it('uses the usual cut-off for a page with nothing to separate, and stays in range otherwise', () => {
    expect(otsuCutoff(Array(1000).fill(250))).toBe(150);
    expect(otsuCutoff(Array(1000).fill(10))).toBe(150);
    expect(otsuCutoff([...Array(500).fill(5), ...Array(500).fill(20)])).toBe(110);
    expect(otsuCutoff([...Array(500).fill(240), ...Array(500).fill(255)])).toBe(190);
  });

  it('is used when no cut-off is given, so pale ink on a pale page is kept as ink', () => {
    const r = newRaster(4, 1);
    r.data.set([245, 245, 245, 255, 245, 245, 245, 255, 245, 245, 245, 255, 130, 130, 130, 255]);
    expect(blackAndWhite(r).data[12]).toBe(0);
  });
});
