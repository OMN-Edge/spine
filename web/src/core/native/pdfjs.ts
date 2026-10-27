import * as pdfjs from 'pdfjs-real/legacy/build/pdf.mjs';
import * as worker from 'pdfjs-real/legacy/build/pdf.worker.mjs';

/**
 * PDF.js for the core. The core already runs in a worker, so PDF.js runs its own worker code in the same one (it looks for
 * `globalThis.pdfjsWorker`) instead of starting another. Standard fonts are served from this origin: the page's content security policy
 * allows nothing else, and a file that names Helvetica without embedding it would otherwise render with no text.
 * Fonts the file embeds are drawn as shapes (`disableFontFace`): loaded as web fonts in this worker they came out as empty boxes, and a
 * page image is made once, so the slower drawing costs nothing that shows.
 */
(globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = worker;

export const STANDARD_FONTS = `${import.meta.env?.BASE_URL ?? '/'}pdfjs/standard_fonts/`;
export const getDocument: typeof pdfjs.getDocument = (src: Parameters<typeof pdfjs.getDocument>[0]) =>
  pdfjs.getDocument({ ...(src as object), standardFontDataUrl: STANDARD_FONTS, disableFontFace: true } as never);
export const { OPS, Util } = pdfjs;
