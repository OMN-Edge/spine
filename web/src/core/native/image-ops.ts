import fs from 'fs';
import { Buffer } from 'buffer';
import type { UprightOptions } from '../../../../server/src/ingestion/image-ops';

/** Same contract as server/src/ingestion/image-ops.ts, done with the browser's image decoding and canvas. */
async function decode(src: string, maxPixels: number): Promise<ImageBitmap> {
  const bitmap = await createImageBitmap(new Blob([fs.readFileSync(src) as unknown as BlobPart]), { imageOrientation: 'from-image' });
  if (bitmap.width * bitmap.height > maxPixels) { bitmap.close(); throw new Error('the picture has too many pixels'); }
  return bitmap;
}

async function uprightCanvas(src: string, o: UprightOptions): Promise<OffscreenCanvas> {
  const bitmap = await decode(src, o.maxPixels);
  const scale = Math.min(1, o.maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#fff'; // flattened onto white
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

const bytesOf = async (canvas: OffscreenCanvas, type: string, quality?: number) =>
  new Uint8Array(await (await canvas.convertToBlob({ type, quality })).arrayBuffer());

export async function uprightPng(src: string, dest: string, options: UprightOptions): Promise<void> {
  fs.writeFileSync(dest, await bytesOf(await uprightCanvas(src, options), 'image/png'));
}

export async function uprightJpeg(src: string, options: UprightOptions) {
  const canvas = await uprightCanvas(src, options);
  return { jpeg: Buffer.from(await bytesOf(canvas, 'image/jpeg', 0.92)), width: canvas.width, height: canvas.height, channels: 3 };
}

export async function rotateImage(src: string, dest: string, degrees: number): Promise<{ width: number; height: number }> {
  const bitmap = await decode(src, Number.MAX_SAFE_INTEGER);
  const turned = degrees % 180 !== 0;
  const canvas = new OffscreenCanvas(turned ? bitmap.height : bitmap.width, turned ? bitmap.width : bitmap.height);
  const context = canvas.getContext('2d')!;
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate((degrees * Math.PI) / 180);
  context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  bitmap.close();
  fs.writeFileSync(dest, await bytesOf(canvas, 'image/png'));
  return { width: canvas.width, height: canvas.height };
}
