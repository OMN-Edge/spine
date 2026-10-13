import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { resolveDataDir } from '../config.js';

/** The longest side a page image may have. A phone photo is 4000+ pixels; the model does not need them. */
export const MAX_PHOTO_SIDE = 2600;
/** A photo declaring more pixels than this is refused rather than decoded (sharp's own default is 268 million). */
export const MAX_PHOTO_PIXELS = 120_000_000;

/**
 * A photo as the one page of its upload: upright (phones store most photos sideways and set an EXIF
 * flag, which the model would not apply and boxes drawn on it would then be wrong), no larger than
 * `MAX_PHOTO_SIDE`, flattened onto white if it has transparency, and as a PNG, which is what the page
 * viewer and the rest of the pipeline expect. The original stays untouched in `originals/`.
 */
export async function normalisePhoto(
  sourceFileId: string,
  filePath: string,
): Promise<Array<{ page_number: number; image_path: string }>> {
  const outDir = path.join(resolveDataDir(), 'pages', sourceFileId);
  fs.mkdirSync(outDir, { recursive: true });
  const imagePath = path.join(outDir, 'page-1.png');

  await sharp(filePath, { limitInputPixels: MAX_PHOTO_PIXELS })
    .rotate() // by the EXIF orientation, then the flag is dropped from the output
    .resize({ width: MAX_PHOTO_SIDE, height: MAX_PHOTO_SIDE, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .png()
    .toFile(imagePath);

  return [{ page_number: 1, image_path: imagePath }];
}
