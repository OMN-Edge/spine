import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import { ParserConfigError } from 'spine-core/parser/types.js';

const execFileAsync = promisify(execFile);

import { missingLanguages, parseTesseractTsv, type OcrReading } from 'spine-core/parser/ocr-reading.js';

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

export async function checkOcrAvailable(langs: string): Promise<void> {
  let output: string;
  try {
    const { stdout, stderr } = await execFileAsync('tesseract', ['--list-langs']);
    // Older builds print the list on stderr.
    output = `${stdout}\n${stderr}`;
  } catch {
    throw new ParserConfigError('tesseract is not installed, and the configured parser needs it (apt install tesseract-ocr), or set SPINE_PARSER=text, or SPINE_OCR=off with hybrid');
  }
  const missing = missingLanguages(output, langs);
  if (missing.length > 0) {
    throw new ParserConfigError(
      `tesseract is missing the language pack(s): ${missing.join(', ')} ` +
        `(SPINE_OCR_LANGS=${langs}). Install them, e.g. apt install ${missing.map(l => `tesseract-ocr-${l}`).join(' ')}`,
    );
  }
}
