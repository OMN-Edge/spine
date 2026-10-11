import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import type { UnstructuredElement } from '../types.js';
import { ParserConfigError } from './types.js';

const execFileAsync = promisify(execFile);

/** Below this a word counts as low confidence. Tesseract's own scale is 0 to 100. */
export const LOW_CONFIDENCE_WORD = 60;

/** What local OCR made of one page, and how sure it is. */
export interface OcrReading {
  /** Lines of text with boxes in the page image's own pixel space. */
  elements: UnstructuredElement[];
  words: number;
  /** Mean word confidence, 0 to 100. */
  meanConfidence: number;
  /** Share of words under 60, 0 to 1. */
  lowConfidenceShare: number;
}

/**
 * Tesseract's TSV output, as lines with boxes plus the confidence figures that decide
 * whether this reading is good enough to keep.
 *
 * Tesseract runs on the rasterized page itself, so its boxes are already in the image's
 * pixel space and need no scaling. Rows with confidence -1 are layout structure, not
 * words.
 *
 * What it reports on tilt: measured on this machine, print tilted 3 degrees reads at
 * about 87, but at 8 degrees or more it finds no words at all. So "no words" is the tilt
 * signal as much as it is the blank-page one, and both go to the model.
 */
export function parseTesseractTsv(tsv: string, pageNumber: number): OcrReading {
  const lines = tsv.split('\n');
  const header = lines[0]?.split('\t') ?? [];
  const col = (name: string) => header.indexOf(name);
  const [iBlock, iPar, iLine] = [col('block_num'), col('par_num'), col('line_num')];
  const [iLeft, iTop, iWidth, iHeight] = [col('left'), col('top'), col('width'), col('height')];
  const [iConf, iText] = [col('conf'), col('text')];

  const byLine = new Map<string, { words: string[]; x0: number; y0: number; x1: number; y1: number }>();
  const confidences: number[] = [];

  for (const row of lines.slice(1)) {
    const cells = row.split('\t');
    const text = (cells[iText] ?? '').trim();
    const conf = Number(cells[iConf]);
    if (!text || !Number.isFinite(conf) || conf < 0) continue;

    confidences.push(conf);

    const key = `${cells[iBlock]}.${cells[iPar]}.${cells[iLine]}`;
    const x0 = Number(cells[iLeft]);
    const y0 = Number(cells[iTop]);
    const x1 = x0 + Number(cells[iWidth]);
    const y1 = y0 + Number(cells[iHeight]);
    const line = byLine.get(key);
    if (line) {
      line.words.push(text);
      line.x0 = Math.min(line.x0, x0);
      line.y0 = Math.min(line.y0, y0);
      line.x1 = Math.max(line.x1, x1);
      line.y1 = Math.max(line.y1, y1);
    } else {
      byLine.set(key, { words: [text], x0, y0, x1, y1 });
    }
  }

  const words = confidences.length;
  return {
    words,
    meanConfidence: words ? confidences.reduce((a, b) => a + b, 0) / words : 0,
    lowConfidenceShare: words ? confidences.filter(c => c < LOW_CONFIDENCE_WORD).length / words : 1,
    elements: [...byLine.values()].map(line => ({
      type: 'Text',
      text: line.words.join(' '),
      page_number: pageNumber,
      bbox: { x0: line.x0, y0: line.y0, x1: line.x1, y1: line.y1 },
      source: 'ocr' as const,
    })),
  };
}

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

/**
 * Tesseract and every language pack asked for must be installed, checked up front.
 * A missing Romanian pack does not fail: Tesseract carries on with the languages it
 * has, reads diacritics worse, scores lower, and so sends more pages to the model —
 * more cost and more images leaving, with nothing to say why. Better to refuse to start.
 */
export function missingLanguages(listLangsOutput: string, wanted: string): string[] {
  const installed = new Set(
    listLangsOutput.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('List of')),
  );
  return wanted.split('+').filter(lang => !installed.has(lang));
}

export async function checkOcrAvailable(langs: string): Promise<void> {
  let output: string;
  try {
    const { stdout, stderr } = await execFileAsync('tesseract', ['--list-langs']);
    // Older builds print the list on stderr.
    output = `${stdout}\n${stderr}`;
  } catch {
    throw new ParserConfigError('tesseract is not installed, and SPINE_PARSER=hybrid needs it (apt install tesseract-ocr)');
  }
  const missing = missingLanguages(output, langs);
  if (missing.length > 0) {
    throw new ParserConfigError(
      `tesseract is missing the language pack(s): ${missing.join(', ')} ` +
        `(SPINE_OCR_LANGS=${langs}). Install them, e.g. apt install ${missing.map(l => `tesseract-ocr-${l}`).join(' ')}`,
    );
  }
}
