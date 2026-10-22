import type { Point, Quad, Raster } from './image';

/**
 * Finding the page in a camera frame, on the device (FR-ING-06, FR-ING-10): nothing is sent anywhere to do it.
 *
 * A page on a table is a bright region of a plain colour against a darker, different one. The frame is shrunk, the brightness split
 * at the level that best separates two groups (Otsu), the biggest bright region that is not the whole frame is taken, and its four
 * corners are the extremes of its outline along the two diagonals. That is a plain method and it fails on a page that is the same
 * colour as the table, a page against a cluttered background, or one that fills the frame; then `defaultQuad` offers the frame
 * with a margin and the person moves the corners (FR-ING-06: "automatic corner finding with manual adjustment").
 */
const WORK = 160;

function grayscaleSmall(src: Raster): { gray: Uint8Array; w: number; h: number; scale: number } {
  const scale = Math.min(1, WORK / Math.max(src.width, src.height));
  const w = Math.max(8, Math.round(src.width * scale));
  const h = Math.max(8, Math.round(src.height * scale));
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // The mean of the source pixels this one covers, so a thin line is not skipped over.
      const x0 = Math.floor((x * src.width) / w); const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * src.width) / w));
      const y0 = Math.floor((y * src.height) / h); const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * src.height) / h));
      let sum = 0; let n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const i = (yy * src.width + xx) * 4;
        sum += 0.299 * src.data[i] + 0.587 * src.data[i + 1] + 0.114 * src.data[i + 2];
        n++;
      }
      gray[y * w + x] = sum / n;
    }
  }
  return { gray, w, h, scale: w / src.width };
}

export function otsu(gray: Uint8Array): number {
  const hist = new Array<number>(256).fill(0);
  for (const v of gray) hist[v]++;
  const total = gray.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let wB = 0; let sumB = 0; let best = 0; let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB; const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}

/** The biggest 4-connected group of set cells that is neither tiny nor the whole frame, with its cells' coordinates. */
function bestRegion(mask: Uint8Array, w: number, h: number): Array<[number, number]> | null {
  const seen = new Uint8Array(w * h);
  let best: Array<[number, number]> | null = null;
  let bestScore = 0;
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const cells: Array<[number, number]> = [];
    let touching = 0; // how many sides of the frame the region reaches
    let top = false; let bottom = false; let left = false; let right = false;
    stack.push(start); seen[start] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      const x = c % w; const y = (c - x) / w;
      cells.push([x, y]);
      if (y === 0) top = true; if (y === h - 1) bottom = true; if (x === 0) left = true; if (x === w - 1) right = true;
      if (x > 0 && mask[c - 1] && !seen[c - 1]) { seen[c - 1] = 1; stack.push(c - 1); }
      if (x < w - 1 && mask[c + 1] && !seen[c + 1]) { seen[c + 1] = 1; stack.push(c + 1); }
      if (y > 0 && mask[c - w] && !seen[c - w]) { seen[c - w] = 1; stack.push(c - w); }
      if (y < h - 1 && mask[c + w] && !seen[c + w]) { seen[c + w] = 1; stack.push(c + w); }
    }
    touching = [top, bottom, left, right].filter(Boolean).length;
    const share = cells.length / (w * h);
    // A page is a good part of the frame, and a region that reaches three or more sides is the table or the wall, not a page.
    if (share < 0.12 || share > 0.97 || touching >= 3) continue;
    const score = cells.length * (touching === 0 ? 1.15 : 1);
    if (score > bestScore) { bestScore = score; best = cells; }
  }
  return best;
}

const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Convex hull, Andrew's monotone chain. */
export function convexHull(points: Point[]): Point[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const lower: Point[] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  const upper: Point[] = [];
  for (const q of [...p].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export function polygonArea(poly: Point[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) { const j = (i + 1) % poly.length; a += poly[i].x * poly[j].y - poly[j].x * poly[i].y; }
  return Math.abs(a) / 2;
}

/** The four corners of a set of points, clockwise from the top left: the extremes along the two diagonals. */
export function cornersOf(points: Point[]): Quad {
  let tl = points[0]; let tr = points[0]; let br = points[0]; let bl = points[0];
  for (const p of points) {
    if (p.x + p.y < tl.x + tl.y) tl = p;
    if (p.x - p.y > tr.x - tr.y) tr = p;
    if (p.x + p.y > br.x + br.y) br = p;
    if (p.x - p.y < bl.x - bl.y) bl = p;
  }
  return [tl, tr, br, bl];
}

/** Whether a mask picks the page: try bright-on-dark, then dark-on-bright (a white table under a dark sheet). */
export function detectDocument(src: Raster): Quad | null {
  const { gray, w, h, scale } = grayscaleSmall(src);
  const t = otsu(gray);
  for (const bright of [true, false]) {
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = (bright ? gray[i] > t : gray[i] <= t) ? 1 : 0;
    const region = bestRegion(mask, w, h);
    if (!region) continue;
    const hull = convexHull(region.map(([x, y]) => ({ x, y })));
    if (hull.length < 3) continue;
    const quad = cornersOf(hull);
    // The outline has to be close to the four-sided shape the corners make, or this is not a page.
    if (polygonArea(quad) < 0.8 * polygonArea(hull)) continue;
    // Cell centres to the corners of the cells, then back to the frame's own pixels.
    const grow = (p: Point, dx: number, dy: number): Point => ({ x: (p.x + 0.5 + dx * 0.5) / scale, y: (p.y + 0.5 + dy * 0.5) / scale });
    const [tl, tr, br, bl] = quad;
    return [grow(tl, -1, -1), grow(tr, 1, -1), grow(br, 1, 1), grow(bl, -1, 1)].map(p => ({
      x: Math.min(src.width - 1, Math.max(0, p.x)), y: Math.min(src.height - 1, Math.max(0, p.y)),
    })) as Quad;
  }
  return null;
}

/** The frame less a margin: where the corners start when no page was found, for the person to move. */
export function defaultQuad(width: number, height: number, margin = 0.08): Quad {
  const mx = width * margin; const my = height * margin;
  return [{ x: mx, y: my }, { x: width - mx, y: my }, { x: width - mx, y: height - my }, { x: mx, y: height - my }];
}

/** Whether two sightings of a page are the same one, held still: every corner within `tolerance` of the frame's long side. */
export function steady(a: Quad | null, b: Quad | null, frame: { width: number; height: number }, tolerance = 0.015): boolean {
  if (!a || !b) return false;
  const limit = tolerance * Math.max(frame.width, frame.height);
  return a.every((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y) <= limit);
}
