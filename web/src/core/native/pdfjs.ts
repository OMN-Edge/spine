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

/**
 * The canvases PDF.js makes for itself, not for the page: a picture drawn much smaller than it is stored is scaled down in steps on canvases of
 * its own. Its default factory asks the page's `document` for them, and a worker has none (`this._document.createElement`: what failed on a
 * phone, on a file with a logo in it), so they are `OffscreenCanvas`es, which a worker has.
 */
class WorkerCanvasFactory {
  create(width: number, height: number) {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext('2d', { willReadFrequently: true }) };
  }
  reset({ canvas }: { canvas?: OffscreenCanvas | null }, width: number, height: number) {
    if (!canvas) throw new Error('Canvas is not specified');
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    canvas.width = width;
    canvas.height = height;
  }
  destroy(held: { canvas?: OffscreenCanvas | null; context?: unknown }) {
    if (!held.canvas) throw new Error('Canvas is not specified');
    held.canvas.width = held.canvas.height = 0;
    held.canvas = null;
    held.context = null;
  }
}

export const STANDARD_FONTS = `${import.meta.env?.BASE_URL ?? '/'}pdfjs/standard_fonts/`;
export const getDocument: typeof pdfjs.getDocument = (src: Parameters<typeof pdfjs.getDocument>[0]) =>
  pdfjs.getDocument({ ...(src as object), standardFontDataUrl: STANDARD_FONTS, disableFontFace: true, CanvasFactory: WorkerCanvasFactory } as never);
export const { OPS, Util } = pdfjs;
