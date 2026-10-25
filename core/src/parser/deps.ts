import type { LlmLogger, PageReading } from '../llm/types.js';
import type { ParseResponse } from '../types.js';
import type { OcrReading } from './ocr.js';

/**
 * What the adapters need from the outside, passed in so each can be tested without
 * a sidecar, a model or image files. `getParser()` supplies the real ones.
 */
export interface ParserDeps {
  /** Parse the whole file with the local sidecar. */
  sidecar: (filePath: string) => Promise<ParseResponse>;
  /** Pixel size of a rasterized page image. */
  imageSize: (imagePath: string) => { width: number; height: number };
  /** Local OCR of one page image: lines with boxes, and how confident it is. */
  ocrPage: (imagePath: string, pageNumber: number) => Promise<OcrReading>;
  /** Read one page image with the model. The only call that sends an image away. */
  readPage: (imagePath: string) => Promise<PageReading | null>;
  logger: LlmLogger;
}
