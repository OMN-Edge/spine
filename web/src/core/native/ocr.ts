import fs from 'fs';
import { createWorker, type Worker } from 'tesseract.js';
import { parseTesseractTsv, type OcrReading } from 'spine-core/parser/ocr-reading';

export * from 'spine-core/parser/ocr-reading';

/**
 * Local OCR on the device: Tesseract compiled to WebAssembly (tesseract.js), with its worker, core and language data served from this
 * origin because the page's content security policy allows nothing else. Same contract as core/src/parser/ocr.ts: lines with boxes in
 * the image's own pixels, and the confidence figures that decide whether to keep the reading.
 */
const BASE = `${import.meta.env?.BASE_URL ?? '/'}tesseract`;
const TSV_HEADER = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
let current: { langs: string; worker: Promise<Worker> } | null = null;

function workerFor(langs: string): Promise<Worker> {
  if (current?.langs !== langs) {
    void current?.worker.then(w => w.terminate());
    current = {
      langs,
      worker: createWorker(langs.split('+'), 1, {
        workerPath: `${BASE}/worker.min.js`,
        corePath: `${BASE}/core`,
        langPath: `${BASE}/lang`,
        workerBlobURL: false,
        gzip: true,
        cacheMethod: 'none',
      }),
    };
  }
  return current.worker;
}

export async function ocrPage(imagePath: string, pageNumber: number, langs: string): Promise<OcrReading> {
  const worker = await workerFor(langs);
  const { data } = await worker.recognize(fs.readFileSync(imagePath) as Buffer, {}, { tsv: true });
  // tesseract.js writes the rows without the command line tool's header line, which the parser reads the columns from.
  return parseTesseractTsv(`${TSV_HEADER}\n${data.tsv ?? ''}`, pageNumber);
}

/** Nothing to install: the engine and the language data ship with the app. A missing file shows as a failed reading. */
export async function checkOcrAvailable(): Promise<void> {}
