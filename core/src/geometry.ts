/** A box as fractions of its page (0 to 1), the same as every stored bounding box. */
export interface Box { x0: number; y0: number; x1: number; y1: number }

/** Clockwise quarter turns of a page image. */
export type Turn = 90 | 180 | 270;
export const isTurn = (value: unknown): value is Turn => value === 90 || value === 180 || value === 270;

/**
 * Where a box sits after the page image is turned clockwise by `turn`: a point (x, y) of the page goes to (1 - y, x) for a quarter
 * turn, (1 - x, 1 - y) for a half and (y, 1 - x) for three quarters, and a box is the box of its two corners.
 */
export function rotateBox(box: Box, turn: Turn): Box {
  const { x0, y0, x1, y1 } = box;
  if (turn === 90) return { x0: 1 - y1, y0: x0, x1: 1 - y0, y1: x1 };
  if (turn === 180) return { x0: 1 - x1, y0: 1 - y1, x1: 1 - x0, y1: 1 - y0 };
  return { x0: y0, y0: 1 - x1, x1: y1, y1: 1 - x0 };
}
