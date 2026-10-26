import sharp from 'sharp';
import type { UprightOptions } from 'spine-core/ingestion/image-ops.js';

const upright = (src: string, o: UprightOptions) =>
  sharp(src, { limitInputPixels: o.maxPixels })
    .rotate() // by the EXIF orientation, then the flag is dropped from the output
    .resize({ width: o.maxSide, height: o.maxSide, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' });

/** A photo made upright, no larger than `maxSide`, flattened onto white, written as a PNG. */
export async function uprightPng(src: string, dest: string, options: UprightOptions): Promise<void> {
  await upright(src, options).png().toFile(dest);
}

/** The same, as a high-quality sRGB JPEG in memory. */
export async function uprightJpeg(src: string, options: UprightOptions): Promise<{ jpeg: Buffer; width: number; height: number; channels: number }> {
  const { data, info } = await upright(src, options).toColourspace('srgb').jpeg({ quality: 92 }).toBuffer({ resolveWithObject: true });
  return { jpeg: data, width: info.width, height: info.height, channels: info.channels };
}

/** An image turned clockwise by 90, 180 or 270 degrees and written to `dest`. Gives the size it came out. */
export async function rotateImage(src: string, dest: string, degrees: number): Promise<{ width: number; height: number }> {
  const info = await sharp(src).rotate(degrees).toFile(dest);
  return { width: info.width, height: info.height };
}
