/** The part of a browser `ImageData` the scanner uses, so the algorithms run (and are tested) without a canvas. */
export interface Raster {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface Point { x: number; y: number }
/** A page's four corners, clockwise from the top left. */
export type Quad = [Point, Point, Point, Point];

export const newRaster = (width: number, height: number): Raster => ({ data: new Uint8ClampedArray(width * height * 4), width, height });
