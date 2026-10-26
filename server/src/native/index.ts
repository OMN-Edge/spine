import { useNativeTools, type NativeTools } from 'spine-core/native-tools.js';
import { ocrPage } from './ocr.js';
import { countryOf } from '../geo.js';
import { extractPdfPages } from './pdf-pages.js';
import { rasterizePdf } from './rasterize.js';
import { rotateImage, uprightJpeg, uprightPng } from './image-ops.js';
import { textToPdf } from './text-pdf.js';
import { NodeZipReader } from './zip-read.js';
import { newZip } from './zip-write.js';

/**
 * The tools of the shared code, done on Node with poppler, Tesseract, sharp, pdfkit, yauzl, yazl and maxmind. The production server registers
 * none of them: it holds no records and so reads no document (SECURITY.md **M-37**), except that it looks up where a share was opened
 * (`countryOf`, in `../geo.ts`, which it imports on its own). They exist so that the whole app can run on Node, in the tests that drive it and in the
 * real-model suite, with the same code the device runs.
 */
export const nodeTools: NativeTools = {
  rasterizePdf, ocrPage, extractPdfPages, uprightPng, uprightJpeg, rotateImage, textToPdf,
  // These two load the parser and the model interface, which the tests that run the app replace with mocks of their own. A test run
  // registers the tools before the test file's mocks exist, so they are loaded when first used: then what they load is what the file mocked.
  readSignatures: async (...args) => (await import('./signatures.js')).readSignatures(...args),
  readDigitalSigners: async (...args) => (await import('./signatures.js')).readDigitalSigners(...args),
  openZip: (filePath, maxEntries) => NodeZipReader.open(filePath, maxEntries),
  newZip, countryOf,
};

export const useNodeTools = (): void => useNativeTools(nodeTools);
