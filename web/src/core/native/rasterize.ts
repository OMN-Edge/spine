import fs from 'fs';
import path from 'path';
import { resolveDataDir } from '../../../../server/src/config';
import { getDocument } from './pdfjs';

/** Same contract as server/src/ingestion/rasterize.ts: each page of the PDF as a 200 DPI PNG under `<data>/pages/<id>/page-N.png`. */
const SCALE = 200 / 72;

export async function rasterizePdf(sourceFileId: string, filePath: string): Promise<Array<{ page_number: number; image_path: string }>> {
  const outDir = path.join(resolveDataDir(), 'pages', sourceFileId);
  fs.mkdirSync(outDir, { recursive: true });
  const task = getDocument({ data: new Uint8Array(fs.readFileSync(filePath) as Buffer) });
  const pdf = await task.promise;
  try {
    const pages: Array<{ page_number: number; image_path: string }> = [];
    const digits = String(pdf.numPages).length;
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const view = page.getViewport({ scale: SCALE });
      const canvas = new OffscreenCanvas(Math.ceil(view.width), Math.ceil(view.height));
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: context as unknown as CanvasRenderingContext2D, viewport: view }).promise;
      const png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
      const image_path = path.join(outDir, `page-${String(n).padStart(digits, '0')}.png`);
      fs.writeFileSync(image_path, png);
      pages.push({ page_number: n, image_path });
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
