import fs from '../shims/fs';
import path from 'path';
import { resolveDataDir } from 'spine-core/config';
import { getDocument } from './pdfjs';
import { checkKeptBytes, checkPageCount, scaleFor } from './rasterize-limits';

/**
 * Same contract as core/src/ingestion/rasterize.ts: each page of the PDF as a 200 DPI PNG under `<data>/pages/<id>/page-N.png`. A page that would
 * be larger than `MAX_PAGE_PIXELS` is drawn smaller, and a PDF of more than `MAX_PDF_PAGES` pages, or whose images pass the byte budget, is
 * refused before more is drawn (`rasterize-limits.ts`, SECURITY.md S-55).
 */

export async function rasterizePdf(sourceFileId: string, filePath: string): Promise<Array<{ page_number: number; image_path: string }>> {
  const outDir = path.join(resolveDataDir(), 'pages', sourceFileId);
  fs.mkdirSync(outDir, { recursive: true });
  const task = getDocument({ data: new Uint8Array(fs.readFileSync(filePath) as Buffer) });
  const pdf = await task.promise;
  try {
    checkPageCount(pdf.numPages);
    let kept = 0;
    const pages: Array<{ page_number: number; image_path: string }> = [];
    const digits = String(pdf.numPages).length;
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const [width, height] = [page.getViewport({ scale: 1 }).width, page.getViewport({ scale: 1 }).height];
      const view = page.getViewport({ scale: scaleFor(width, height) });
      const canvas = new OffscreenCanvas(Math.ceil(view.width), Math.ceil(view.height));
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: context as unknown as CanvasRenderingContext2D, viewport: view }).promise;
      const png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
      const image_path = path.join(outDir, `page-${String(n).padStart(digits, '0')}.png`);
      kept += png.length;
      checkKeptBytes(kept);
      fs.writeFileSync(image_path, png);
      pages.push({ page_number: n, image_path });
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
