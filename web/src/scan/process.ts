import { enhance } from './enhance';
import type { Quad, Raster } from './image';
import { pageSize, warpPerspective } from './warp';

/** The browser side of scanning: a photo into pixels and back. Everything here runs on the device (FR-ING-10). */
const MAX_SOURCE_SIDE = 3000;

export interface Loaded { raster: Raster; width: number; height: number; scale: number }

/** A photo as pixels, shrunk so its long side is at most `MAX_SOURCE_SIDE`; `scale` says by how much, to map corners to it. */
export async function loadRaster(blob: Blob, maxSide = MAX_SOURCE_SIDE): Promise<Loaded> {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale)); const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('this browser cannot work with pictures');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const data = ctx.getImageData(0, 0, width, height);
  return { raster: { data: data.data, width, height }, width, height, scale };
}

export function rasterToBlob(r: Raster, quality = 0.92): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = r.width; canvas.height = r.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('this browser cannot work with pictures'));
  ctx.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height), 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('could not save the picture'))), 'image/jpeg', quality));
}

/** The page cut out and straightened, plain and cleaned up. `quad` is in the photo's own pixels as loaded at `loaded.scale`. */
export async function processPage(loaded: Loaded, quad: Quad): Promise<{ plain: Blob; clean: Blob }> {
  const straight = warpPerspective(loaded.raster, quad, pageSize(quad));
  const [plain, clean] = await Promise.all([rasterToBlob(straight), rasterToBlob(enhance(straight))]);
  return { plain, clean };
}
