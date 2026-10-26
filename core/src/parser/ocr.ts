import { nativeTools, type NativeTools } from '../native-tools.js';

export * from './ocr-reading.js';

/** A page read by OCR: lines with boxes in the image's own pixels. Done by the host's tool (`native-tools.ts`). */
export const ocrPage: NativeTools['ocrPage'] = (imagePath, pageNumber, langs) => nativeTools().ocrPage(imagePath, pageNumber, langs);
