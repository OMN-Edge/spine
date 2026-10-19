import fs from 'fs';
import sharp from 'sharp';
import { MAX_PHOTO_PIXELS, MAX_PHOTO_SIDE } from './photo.js';

/** Photos in one upload: a document is a few pages, and each is decoded in memory here. */
export const MAX_PHOTOS_IN_SET = 40;

/** The resolution pages are drawn at when a PDF is read (`rasterize.ts`): a page is sized so it comes back at the photo's own pixels. */
const READ_DPI = 200;

/**
 * Several photos of one document become one PDF, a page for each in the order given, so everything after this treats them as the
 * pages they are: they are rasterised, grouped, read, exported and restored like any PDF. Each photo is made upright (a phone
 * stores most sideways and sets an EXIF flag that a PDF would not honour), no larger than `MAX_PHOTO_SIDE`, flattened onto white,
 * and kept as a JPEG at high quality. The same photos in the same order make the same bytes, so the same set sent twice is
 * recognised by its checksum. The photos themselves are not kept: the PDF is the original.
 */
export async function bundlePhotos(photos: string[], outPath: string): Promise<void> {
  const pages: Array<{ jpeg: Buffer; width: number; height: number; channels: number }> = [];
  for (const photo of photos) {
    const { data, info } = await sharp(photo, { limitInputPixels: MAX_PHOTO_PIXELS })
      .rotate()
      .resize({ width: MAX_PHOTO_SIDE, height: MAX_PHOTO_SIDE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .jpeg({ quality: 92 })
      .toBuffer({ resolveWithObject: true });
    pages.push({ jpeg: data, width: info.width, height: info.height, channels: info.channels });
  }

  // Objects: 1 catalog, 2 page tree, then per page its page, its drawing and its image.
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = chunks[0].length;
  const offsets: number[] = [];
  const put = (id: number, ...body: Array<string | Buffer>) => {
    offsets[id] = offset;
    const parts = [Buffer.from(`${id} 0 obj\n`), ...body.map(b => (typeof b === 'string' ? Buffer.from(b, 'latin1') : b)), Buffer.from('\nendobj\n')];
    for (const part of parts) { chunks.push(part); offset += part.length; }
  };
  const pageId = (i: number) => 3 + i * 3;

  put(1, '<< /Type /Catalog /Pages 2 0 R >>');
  put(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  pages.forEach((p, i) => {
    const w = +((p.width * 72) / READ_DPI).toFixed(2);
    const h = +((p.height * 72) / READ_DPI).toFixed(2);
    const draw = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    put(pageId(i), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${pageId(i) + 2} 0 R >> >> /Contents ${pageId(i) + 1} 0 R >>`);
    put(pageId(i) + 1, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
    put(
      pageId(i) + 2,
      `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /${p.channels === 1 ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`,
      p.jpeg,
      '\nendstream',
    );
  });

  const count = 3 + pages.length * 3;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id++) xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`, 'latin1'));
  fs.writeFileSync(outPath, Buffer.concat(chunks));
}
