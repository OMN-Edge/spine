import type { Point, Quad, Raster } from './image';

/**
 * Finding the page in a picture, on the device (FR-ING-06, FR-ING-10): nothing is sent anywhere to do it. The finding itself is
 * `scanic` (classical edge detection and contour analysis compiled to WebAssembly, MIT), loaded only when the scan screen opens; this
 * file turns its answer into the corner order the rest of the screen uses, and keeps the two small helpers that are ours. The optional
 * neural detector of that library fetches its model from a third-party CDN by default, so it is not used.
 */
type Corners = { topLeft: Point; topRight: Point; bottomRight: Point; bottomLeft: Point };

/** scanic's corners as top-left, top-right, bottom-right, bottom-left. */
export const quadOf = (c: Corners): Quad => [c.topLeft, c.topRight, c.bottomRight, c.bottomLeft];
export const cornersOf = (q: Quad): Corners => ({ topLeft: q[0], topRight: q[1], bottomRight: q[2], bottomLeft: q[3] });

let scanner: Promise<import('scanic').Scanner> | null = null;
function engine() {
  scanner ??= import('scanic').then(async ({ Scanner }) => {
    const s = new Scanner();
    await s.initialize();
    return s;
  });
  return scanner;
}

const asImageData = (r: Raster) => new ImageData(new Uint8ClampedArray(r.data.buffer as ArrayBuffer, r.data.byteOffset, r.data.byteLength), r.width, r.height);

/** The page's four corners in the picture's own pixels, or null if none was found. */
export async function detectDocument(src: Raster): Promise<Quad | null> {
  const result = await (await engine()).scan(asImageData(src), { mode: 'detect' });
  return result.success && result.corners ? quadOf(result.corners) : null;
}

/** The page cut out of the picture and straightened, whatever size the corners make it. */
export async function straighten(src: Raster, quad: Quad): Promise<Raster> {
  const result = await (await engine()).extract(asImageData(src), cornersOf(quad), { output: 'imagedata' });
  const out = result.output as ImageData | null;
  if (!result.success || !out) throw new Error(result.message || 'could not straighten the page');
  return { data: out.data, width: out.width, height: out.height };
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
