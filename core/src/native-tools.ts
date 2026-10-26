import type { DigitalSigner, StampDoctor } from './ingestion/signatures-parse.js';
import type { UprightOptions } from './ingestion/image-ops.js';
import type { OcrReading } from './parser/ocr-reading.js';
import type { ZipReader } from './archive/zip-read.js';
import type { ZipWriter } from './archive/zip-write.js';
import type { Settings } from './config.js';

/**
 * What the shared code needs from the machine it runs on and cannot do itself: render a PDF, read a page by OCR, cut pages out of a PDF,
 * turn and shrink a picture, find stamps and signatures, write a PDF, read and write a zip, and say where an address is. Each host brings its
 * own, so this package imports no native library and no program: the server's are in `server/src/native/` (poppler, Tesseract, sharp, pdfkit,
 * yauzl, yazl, maxmind), used by the tests that run the whole app on Node and by the real-model suite, and the device's are in
 * `web/src/core/native/` (PDF.js, Tesseract.js, canvas, pdf-lib, fflate). The files in this package that used to hold the Node versions keep
 * their names and their signatures and ask for the tool from here, so the callers did not change.
 */
export interface NativeTools {
  rasterizePdf(sourceFileId: string, filePath: string): Promise<Array<{ page_number: number; image_path: string }>>;
  ocrPage(imagePath: string, pageNumber: number, langs: string): Promise<OcrReading>;
  extractPdfPages(source: string, sourcePages: number[]): Promise<Buffer>;
  uprightPng(src: string, dest: string, options: UprightOptions): Promise<void>;
  uprightJpeg(src: string, options: UprightOptions): Promise<{ jpeg: Buffer; width: number; height: number; channels: number }>;
  rotateImage(src: string, dest: string, degrees: number): Promise<{ width: number; height: number }>;
  readSignatures(filePath: string, lastPages: number[], maxPagePixels?: number): Promise<Map<number, StampDoctor[]>>;
  readDigitalSigners(filePath: string): Promise<DigitalSigner[]>;
  textToPdf(text: string, outPath: string): Promise<void>;
  openZip(filePath: string, maxEntries?: number): Promise<ZipReader>;
  newZip(): ZipWriter;
  countryOf(address: string | null | undefined, env?: Settings): Promise<string | null>;
}

/** Every tool, by name, so that a host's set can be checked against the list (a missing one is a feature that fails when it is first used). */
export const NATIVE_TOOL_NAMES = [
  'rasterizePdf', 'ocrPage', 'extractPdfPages', 'uprightPng', 'uprightJpeg', 'rotateImage',
  'readSignatures', 'readDigitalSigners', 'textToPdf', 'openZip', 'newZip', 'countryOf',
] as const satisfies readonly (keyof NativeTools)[];
// A tool added to the interface and left out of the list is a compile error here.
const _complete: Exclude<keyof NativeTools, (typeof NATIVE_TOOL_NAMES)[number]> extends never ? true : never = true;
void _complete;

let current: NativeTools | null = null;

/** Called once by the process that brings the tools: the device when it starts its core, the server's tests that run the whole app. */
export function useNativeTools(tools: NativeTools | null): void {
  current = tools;
}

/** The tools of this process. With none registered a feature that needs one fails at once, saying so, instead of with an import that is empty. */
export function nativeTools(): NativeTools {
  if (!current) throw new Error('no native tools have been registered for this process (useNativeTools)');
  return current;
}
