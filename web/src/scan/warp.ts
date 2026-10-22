import { newRaster, type Point, type Quad, type Raster } from './image';

/**
 * Straightening a page (FR-ING-06: perspective correction and crop): the quadrilateral the page makes in the photo becomes a
 * rectangle. Each pixel of the result asks where it came from in the photo through the projective map that takes the rectangle's
 * corners to the page's, and takes the colour there, blended between the four pixels around the spot.
 */

/** Solves A x = b by Gaussian elimination with pivoting. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    if (Math.abs(m[col][col]) < 1e-12) throw new Error('the corners do not make a page');
    for (let r = col + 1; r < n; r++) {
      const f = m[r][col] / m[col][col];
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r][n];
    for (let c = r + 1; c < n; c++) s -= m[r][c] * x[c];
    x[r] = s / m[r][r];
  }
  return x;
}

/** The 3x3 projective map taking the four points `from` to the four points `to`, as its eight free numbers (the ninth is 1). */
export function homography(from: Point[], to: Point[]): number[] {
  const a: number[][] = []; const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i]; const { x: u, y: v } = to[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  return solve(a, b);
}

export const apply = (h: number[], p: Point): Point => {
  const d = h[6] * p.x + h[7] * p.y + 1;
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / d, y: (h[3] * p.x + h[4] * p.y + h[5]) / d };
};

/** How big the straightened page is: the longer of each pair of opposite edges, so nothing is squeezed. */
export function pageSize(q: Quad, longSide = 2000): { width: number; height: number } {
  const len = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  let width = Math.max(len(q[0], q[1]), len(q[3], q[2]));
  let height = Math.max(len(q[0], q[3]), len(q[1], q[2]));
  const scale = Math.min(1, longSide / Math.max(width, height));
  width = Math.max(2, Math.round(width * scale)); height = Math.max(2, Math.round(height * scale));
  return { width, height };
}

export function warpPerspective(src: Raster, quad: Quad, size = pageSize(quad)): Raster {
  const { width, height } = size;
  const out = newRaster(width, height);
  // From the result back to the photo.
  const h = homography([{ x: 0, y: 0 }, { x: width - 1, y: 0 }, { x: width - 1, y: height - 1 }, { x: 0, y: height - 1 }], quad);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = apply(h, { x, y });
      const x0 = Math.floor(p.x); const y0 = Math.floor(p.y);
      const o = (y * width + x) * 4;
      if (x0 < 0 || y0 < 0 || x0 >= src.width - 1 || y0 >= src.height - 1) {
        // Outside the photo (the corners were dragged past its edge): white paper.
        out.data[o] = out.data[o + 1] = out.data[o + 2] = 255; out.data[o + 3] = 255;
        continue;
      }
      const fx = p.x - x0; const fy = p.y - y0;
      const i00 = (y0 * src.width + x0) * 4; const i10 = i00 + 4; const i01 = i00 + src.width * 4; const i11 = i01 + 4;
      for (let c = 0; c < 3; c++) {
        out.data[o + c] = src.data[i00 + c] * (1 - fx) * (1 - fy) + src.data[i10 + c] * fx * (1 - fy) + src.data[i01 + c] * (1 - fx) * fy + src.data[i11 + c] * fx * fy;
      }
      out.data[o + 3] = 255;
    }
  }
  return out;
}
