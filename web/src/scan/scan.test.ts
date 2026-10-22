import { describe, it, expect } from 'vitest';
import { cornersOf, convexHull, defaultQuad, detectDocument, otsu, polygonArea, steady } from './detect';
import { enhance } from './enhance';
import { newRaster, type Point, type Quad, type Raster } from './image';
import { apply, homography, pageSize, warpPerspective } from './warp';

/** A frame of one grey with a lighter page (any four-sided shape) drawn on it, and a little noise so it is not too clean. */
function frameWithPage(width: number, height: number, page: Quad, ground = 70, paper = 235): Raster {
  const r = newRaster(width, height);
  let seed = 7;
  const noise = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return (seed / 4294967296 - 0.5) * 16; };
  const inside = (p: Point) => {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = page[i]; const b = page[(i + 1) % 4];
      const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      if (c !== 0) { if (sign === 0) sign = Math.sign(c); else if (Math.sign(c) !== sign) return false; }
    }
    return true;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = (inside({ x: x + 0.5, y: y + 0.5 }) ? paper : ground) + noise();
    const o = (y * width + x) * 4;
    r.data[o] = v; r.data[o + 1] = v; r.data[o + 2] = v; r.data[o + 3] = 255;
  }
  return r;
}
const near = (a: Point, b: Point, tolerance: number) => Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;

describe('finding the page', () => {
  it('finds a page held at an angle against a darker table, within a few pixels of each corner', () => {
    const page: Quad = [{ x: 120, y: 70 }, { x: 520, y: 100 }, { x: 490, y: 420 }, { x: 90, y: 380 }];
    const found = detectDocument(frameWithPage(640, 480, page))!;
    expect(found).not.toBeNull();
    found.forEach((p, i) => expect(near(p, page[i], 9), `corner ${i}: ${JSON.stringify(p)}`).toBe(true));
  });

  it('finds a dark sheet on a light table too', () => {
    const page: Quad = [{ x: 100, y: 80 }, { x: 500, y: 80 }, { x: 500, y: 400 }, { x: 100, y: 400 }];
    const found = detectDocument(frameWithPage(640, 480, page, 225, 60))!;
    expect(found).not.toBeNull();
    found.forEach((p, i) => expect(near(p, page[i], 9)).toBe(true));
  });

  it('finds nothing in an empty frame, or when the page is the whole frame', () => {
    const whole: Quad = [{ x: -5, y: -5 }, { x: 650, y: -5 }, { x: 650, y: 490 }, { x: -5, y: 490 }];
    expect(detectDocument(frameWithPage(640, 480, whole))).toBeNull();
    expect(detectDocument(frameWithPage(640, 480, [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]))).toBeNull();
  });

  it('does not take a small bright patch for a page', () => {
    const speck: Quad = [{ x: 300, y: 200 }, { x: 340, y: 200 }, { x: 340, y: 230 }, { x: 300, y: 230 }];
    expect(detectDocument(frameWithPage(640, 480, speck))).toBeNull();
  });

  it('offers the frame less a margin when it cannot, and says when two sightings are the same page held still', () => {
    const q = defaultQuad(640, 480);
    expect(q[0]).toEqual({ x: 640 * 0.08, y: 480 * 0.08 });
    expect(polygonArea(q)).toBeGreaterThan(0.6 * 640 * 480);
    const page: Quad = [{ x: 120, y: 70 }, { x: 520, y: 100 }, { x: 490, y: 420 }, { x: 90, y: 380 }];
    const shifted = page.map(p => ({ x: p.x + 3, y: p.y + 2 })) as Quad;
    const moved = page.map(p => ({ x: p.x + 40, y: p.y })) as Quad;
    expect(steady(page, shifted, { width: 640, height: 480 })).toBe(true);
    expect(steady(page, moved, { width: 640, height: 480 })).toBe(false);
    expect(steady(page, null, { width: 640, height: 480 })).toBe(false);
  });

  it('splits two groups of brightness between them, and orders corners', () => {
    const g = new Uint8Array(1000).map((_, i) => (i < 500 ? 40 + (i % 5) : 200 + (i % 5)));
    const t = otsu(g);
    expect(t).toBeGreaterThanOrEqual(44); expect(t).toBeLessThan(200);
    const hull = convexHull([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 5, y: 5 }]);
    expect(hull).toHaveLength(4);
    expect(cornersOf(hull)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]);
  });
});

describe('straightening it', () => {
  it('maps the corners of a rectangle onto the corners of the page, and the middle near the middle', () => {
    const page: Quad = [{ x: 120, y: 70 }, { x: 520, y: 100 }, { x: 490, y: 420 }, { x: 90, y: 380 }];
    const rect = [{ x: 0, y: 0 }, { x: 399, y: 0 }, { x: 399, y: 299 }, { x: 0, y: 299 }];
    const h = homography(rect, page);
    rect.forEach((p, i) => expect(near(apply(h, p), page[i], 1e-6)).toBe(true));
    const mid = apply(h, { x: 199.5, y: 149.5 });
    expect(near(mid, { x: 305, y: 242.5 }, 25)).toBe(true);
  });

  it('cuts an upright page out of a photo pixel for pixel, and fills outside the photo with white', () => {
    const src = newRaster(300, 200);
    for (let y = 0; y < 200; y++) for (let x = 0; x < 300; x++) {
      const o = (y * 300 + x) * 4; src.data[o] = x % 256; src.data[o + 1] = y % 256; src.data[o + 2] = 90; src.data[o + 3] = 255;
    }
    const quad: Quad = [{ x: 50, y: 40 }, { x: 249, y: 40 }, { x: 249, y: 139 }, { x: 50, y: 139 }];
    const out = warpPerspective(src, quad, { width: 200, height: 100 });
    for (const [u, v] of [[0, 0], [199, 0], [100, 50], [199, 99]]) {
      const o = (v * 200 + u) * 4;
      expect(Math.abs(out.data[o] - (50 + u))).toBeLessThanOrEqual(1);
      expect(Math.abs(out.data[o + 1] - (40 + v))).toBeLessThanOrEqual(1);
    }
    const beyond = warpPerspective(src, [{ x: -50, y: -50 }, { x: 50, y: -50 }, { x: 50, y: 50 }, { x: -50, y: 50 }], { width: 20, height: 20 });
    expect([beyond.data[0], beyond.data[1], beyond.data[2]]).toEqual([255, 255, 255]);
  });

  it('is as big as the longer of each pair of edges and no bigger than asked', () => {
    const page: Quad = [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 380, y: 300 }, { x: 20, y: 300 }];
    expect(pageSize(page)).toEqual({ width: 400, height: 301 }); // the slanted sides are a little longer than 300
    const big: Quad = [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 }];
    expect(pageSize(big, 2000)).toEqual({ width: 2000, height: 1500 });
  });

  it('refuses corners that are one point', () => {
    const p = { x: 5, y: 5 };
    expect(() => homography([{ x: 0, y: 0 }, { x: 9, y: 0 }, { x: 9, y: 9 }, { x: 0, y: 9 }], [p, p, p, p])).toThrow();
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
