import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

import { parseTesseractTsv, type OcrReading } from 'spine-core/parser/ocr-reading.js';

export * from 'spine-core/parser/ocr-reading.js';

export async function ocrPage(imagePath: string, pageNumber: number, langs: string): Promise<OcrReading> {
  // Run from the image's own directory and pass only its name. Leptonica, the image
  // library inside Tesseract, rewrites an absolute path that starts with /tmp and then
  // reports the file as not found — measured here, same file, same bytes. Pages live
  // under DATA_DIR so this rarely matters, but a DATA_DIR under /tmp should not fail
  // with an error that blames the file.
  //
  // --psm 3: fully automatic page segmentation, which is what a whole page needs.
  const { stdout } = await execFileAsync(
    'tesseract',
    [path.basename(imagePath), '-', '-l', langs, '--psm', '3', 'tsv'],
    { cwd: path.dirname(imagePath), maxBuffer: 64 * 1024 * 1024 },
  );
  return parseTesseractTsv(stdout, pageNumber);
}
