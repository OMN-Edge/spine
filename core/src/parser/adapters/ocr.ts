import type { ParseResponse } from '../../types.js';
import type { ParserDeps } from '../deps.js';
import type { OcrReading } from '../ocr.js';
import type { Parser, ParseInput, ParserConfig } from '../types.js';
import { createSidecarParser } from './sidecar.js';
import { limiter } from '../../concurrency.js';
import { textCharsOf } from '../text-layer.js';
import { describeError } from '../../failure.js';

/**
 * The PDF's text layer where it has one, and local OCR (Tesseract) for the pages that do not.
 * Nothing leaves the host. There is no model to fall back on, so a page OCR reads badly stays
 * as read, and the log line for it says how confident Tesseract was. Handwriting is the case
 * this does poorly on; `hybrid` is what sends those pages to a model.
 *
 * OCR is CPU-bound and Tesseract already uses the cores it can, so it runs one page at a time.
 */
export function createOcrParser(deps: ParserDeps, config: ParserConfig): Parser {
  const sidecar = createSidecarParser(deps);
  const ocrLane = limiter(1);

  return {
    imageEgress: false,

    async parse(input: ParseInput): Promise<ParseResponse> {
      const log = (page: number, detail: Record<string, unknown>) =>
        deps.logger.info('page routed', { sourceFileId: input.sourceFileId, page, ...detail });

      // As in `hybrid`: if the sidecar is down this throws and the upload fails, rather than
      // treating every page as scanned.
      const fromSidecar = await sidecar.parse(input);
      const pages: ParseResponse['pages'] = [];

      for (const image of input.pages) {
        const n = image.page_number;
        const layer = fromSidecar.pages.find(page => page.page_number === n);
        if (layer && textCharsOf(layer) >= config.textLayerMinChars) {
          log(n, { route: 'text_layer', textChars: textCharsOf(layer) });
          pages.push({ ...layer, extraction_source: 'native_text' });
          continue;
        }

        const { width, height } = deps.imageSize(image.image_path);
        let reading: OcrReading | null = null;
        try {
          reading = await ocrLane(() => deps.ocrPage(image.image_path, n));
        } catch (err) {
          deps.logger.warn('local OCR failed on a page', {
            sourceFileId: input.sourceFileId, page: n, error: describeError(err),
          });
        }
        log(n, reading
          ? { route: 'ocr_local', words: reading.words, meanConfidence: Math.round(reading.meanConfidence), lowShare: Number(reading.lowConfidenceShare.toFixed(2)) }
          : { route: 'ocr_local', words: 0 });
        pages.push({
          page_number: n, elements: reading?.elements ?? [], extraction_source: 'ocr',
          image_width: width, image_height: height,
        });
      }

      return { pages };
    },
  };
}
