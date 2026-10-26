import type { NativeTools } from 'spine-core/native-tools';
import { checkOcrAvailable, ocrPage } from './ocr';
import { countryOf } from './geo';
import { rotateImage, uprightJpeg, uprightPng } from './image-ops';
import { extractPdfPages } from './pdf-pages';
import { rasterizePdf } from './rasterize';
import { readDigitalSigners, readSignatures } from './signatures';
import { textToPdf } from './text-pdf';
import { BrowserZipReader } from './zip-read';
import { newZip } from './zip-write';

/**
 * The tools of the shared code, done in the browser: PDF.js for rendering, Tesseract.js for OCR, the canvas for pictures, pdf-lib for cutting
 * and writing PDFs, fflate for zips, and WebCrypto for signatures. The core registers them when it starts (`boot.ts`), where the server's
 * tests register the Node ones (`server/src/native/index.ts`); both are checked against the list in `core/src/native-tools.ts`.
 */
export const browserTools: NativeTools = {
  rasterizePdf, ocrPage, checkOcrAvailable, extractPdfPages, uprightPng, uprightJpeg, rotateImage, readSignatures, readDigitalSigners, textToPdf,
  openZip: (filePath, maxEntries) => BrowserZipReader.open(filePath, maxEntries),
  newZip, countryOf,
};
