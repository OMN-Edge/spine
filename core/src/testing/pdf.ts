import sharp from 'sharp';

/** One embedded picture. Pictures with the same `key` on different pages are one object, as a letterhead is. */
export interface PdfPicture {
  key: string;
  width: number;
  height: number;
  /** Grey level 0-255, so two pictures differ in bytes as well as in size. */
  shade?: number;
}

/**
 * A small real PDF whose pages carry the given pictures as JPEG images (DCTDecode), which is how a
 * clinic's reporting tool embeds a stamp or a logo. Hand-written, with an accurate cross-reference table,
 * so poppler's `pdfimages` reads it as it reads a real one.
 */
export async function makePdf(pages: PdfPicture[][]): Promise<Buffer> {
  const objects: Buffer[] = []; // index 0 is object 1
  const add = (body: Buffer | string) => { objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body)); return objects.length; };

  const catalog = add('');  // 1, filled below
  const tree = add('');     // 2, filled below

  const imageObject = new Map<string, number>();
  for (const picture of pages.flat()) {
    if (imageObject.has(picture.key)) continue;
    const jpeg = await sharp({ create: { width: picture.width, height: picture.height, channels: 3, background: { r: picture.shade ?? 128, g: picture.shade ?? 128, b: picture.shade ?? 128 } } })
      .jpeg().toBuffer();
    const head = Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${picture.width} /Height ${picture.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
    imageObject.set(picture.key, add(Buffer.concat([head, jpeg, Buffer.from('\nendstream')])));
  }

  const pageObjects: number[] = [];
  for (const pictures of pages) {
    const names = pictures.map((p, i) => `/Im${i}`);
    const content = pictures.map((_, i) => `q 120 0 0 60 ${20 + i * 10} ${20 + i * 70} cm ${names[i]} Do Q`).join('\n');
    const contentObj = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const xobjects = pictures.map((p, i) => `${names[i]} ${imageObject.get(p.key)} 0 R`).join(' ');
    pageObjects.push(add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 600 800] /Resources << /XObject << ${xobjects} >> >> /Contents ${contentObj} 0 R >>`));
  }
  objects[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${tree} 0 R >>`);
  objects[tree - 1] = Buffer.from(`<< /Type /Pages /Kids [${pageObjects.map(n => `${n} 0 R`).join(' ')}] /Count ${pageObjects.length} >>`);

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n')];
  const offsets: number[] = [];
  let at = chunks[0].length;
  objects.forEach((body, i) => {
    offsets.push(at);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    chunks.push(chunk);
    at += chunk.length;
  });
  const xref = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f ', ...offsets.map(o => `${String(o).padStart(10, '0')} 00000 n `)].join('\n');
  chunks.push(Buffer.from(`${xref}\ntrailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${at}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
