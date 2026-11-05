/**
 * What a PDF may ask of the device when it is drawn into page images (SECURITY.md S-55). A tiny file can name a page of thousands of
 * points on a side or hundreds of thousands of pages, and the device draws every page at 200 DPI into memory it keeps; without a ceiling a
 * file of a few hundred bytes took gigabytes and the tab died, again at the next start, because the upload was found still processing.
 */
export const RENDER_SCALE = 200 / 72;
/** Pages in one PDF. A record of a hospital stay is a few dozen; this is far above any that is not made to be a bomb. */
export const MAX_PDF_PAGES = 500;
/** Pixels of one page image at the render scale: A2 at 200 DPI. A larger page is drawn smaller, not refused. */
export const MAX_PAGE_PIXELS = 25_000_000;
/** Bytes of page images kept for one PDF. */
export const MAX_KEPT_BYTES = 1_000_000_000;

export class PdfTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfTooLargeError';
  }
}

export function checkPageCount(pages: number): void {
  if (pages > MAX_PDF_PAGES) throw new PdfTooLargeError(`This PDF has ${pages} pages; Spine reads at most ${MAX_PDF_PAGES} pages in one file. Split it and add the parts.`);
}

/** The scale to draw a page of `width` by `height` points at: the usual one, lowered so that the image has at most `MAX_PAGE_PIXELS`. */
export function scaleFor(width: number, height: number): number {
  const pixels = width * height * RENDER_SCALE * RENDER_SCALE;
  if (!(pixels > MAX_PAGE_PIXELS)) return RENDER_SCALE;
  return RENDER_SCALE * Math.sqrt(MAX_PAGE_PIXELS / pixels);
}

export function checkKeptBytes(bytes: number): void {
  if (bytes > MAX_KEPT_BYTES) throw new PdfTooLargeError('The page images of this PDF are too large to keep. Split it and add the parts.');
}
