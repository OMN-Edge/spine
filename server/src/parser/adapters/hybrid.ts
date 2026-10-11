import type { ParseResponse } from '../../types.js';
import type { ParserDeps } from '../deps.js';
import type { OcrReading } from '../ocr.js';
import type { Parser, ParseInput, ParserConfig } from '../types.js';
import { createSidecarParser } from './sidecar.js';
import { elementsFromReading } from './multimodal.js';
import { limiter, mapLimit } from '../../concurrency.js';

/**
 * Cheapest signal first, and each step only for the pages the one before could not
 * settle — so the model, which costs money and sends an image away, sees as few as
 * possible.
 *
 *   1. The page has a text layer       → use it. Free, exact, nothing leaves. (The sidecar
 *                                          returned text for it.)
 *   2. Local OCR reads it confidently  → keep that. Free, boxes are exact, nothing leaves.
 *   3. Otherwise                       → the model reads the page.
 *
 * Step 2 is the "would OCR have a chance" test. Tesseract reports its own confidence per
 * word; handwriting and tilt both pull it down, and at about 8 degrees of tilt it finds
 * no words at all. Both of those fail the test and go to the model. No LLM is used to
 * screen: looking at the image is the same egress as reading it, so screening would cost
 * the same privacy and add a call.
 *
 * The sidecar runs with its `fast` strategy, so it only ever returns text layers. Its old
 * `ocr` label is not used: it came from a `detection_origin` of "ocr" that Unstructured
 * never sets, so every scanned page came back as `native_text`.
 *
 * The model can only improve a page, never lose one: if it fails or gives an unusable
 * answer, the page keeps what local OCR read, and the failure is logged.
 *
 * Pages are handled in parallel (up to `SPINE_LLM_CONCURRENCY`), so one page waiting on the
 * model does not hold up the next. Local OCR is the exception: it is CPU-bound and
 * Tesseract already uses the cores it can, so it runs one page at a time, in a lane of its own.
 */
export function createHybridParser(deps: ParserDeps, config: ParserConfig): Parser {
  const sidecar = createSidecarParser(deps);
  const ocrLane = limiter(1);

  const ocrIsGoodEnough = (ocr: OcrReading): { ok: boolean; why: string } => {
    if (ocr.words === 0) return { ok: false, why: 'local OCR found no words' };
    if (ocr.meanConfidence < config.ocrMinConfidence) {
      return { ok: false, why: `local OCR confidence ${ocr.meanConfidence.toFixed(0)} is below ${config.ocrMinConfidence}` };
    }
    if (ocr.lowConfidenceShare > config.ocrMaxLowShare) {
      return {
        ok: false,
        why: `${(ocr.lowConfidenceShare * 100).toFixed(0)}% of words are weak, above ${(config.ocrMaxLowShare * 100).toFixed(0)}%`,
      };
    }
    return { ok: true, why: 'local OCR is confident' };
  };

  return {
    imageEgress: true,

    async parse(input: ParseInput): Promise<ParseResponse> {
      const log = (page: number, detail: Record<string, unknown>) =>
        deps.logger.info('page routed', { sourceFileId: input.sourceFileId, page, ...detail });

      // The sidecar runs `fast`, which returns only a PDF's own text layer, so a page it
      // returns text for has one and a page it returns nothing for does not. If it is down
      // this throws and the upload fails, rather than treating every page as scanned and
      // sending digital PDFs to OCR and the model because of an outage.
      const fromSidecar = await sidecar.parse(input);
      const sidecarPage = (n: number) => fromSidecar.pages.find(page => page.page_number === n);

      // How much real text a page has, by non-whitespace characters, so a scan whose only
      // text is a stray page number does not count as having a text layer.
      const textChars = (n: number) =>
        (sidecarPage(n)?.elements ?? []).reduce((sum, element) => sum + element.text.replace(/\s+/g, '').length, 0);
      const hasLayer = (n: number) => textChars(n) >= config.textLayerMinChars;

      const pages = await mapLimit(input.pages, config.concurrency, async (image): Promise<ParseResponse['pages'][number]> => {
        const n = image.page_number;
        const { width, height } = deps.imageSize(image.image_path);

        const layer = sidecarPage(n);
        if (layer && hasLayer(n)) {
          log(n, { route: 'text_layer', textChars: textChars(n) });
          return { ...layer, extraction_source: 'native_text' };
        }

        // No usable text layer. Local OCR first.
        let ocr: OcrReading | null = null;
        try {
          ocr = await ocrLane(() => deps.ocrPage(image.image_path, n));
        } catch (err) {
          deps.logger.warn('local OCR failed on a page', {
            sourceFileId: input.sourceFileId, page: n, error: err instanceof Error ? err.message : String(err),
          });
        }

        const verdict = ocr ? ocrIsGoodEnough(ocr) : { ok: false, why: 'local OCR failed' };
        const figures = ocr
          ? { words: ocr.words, meanConfidence: Math.round(ocr.meanConfidence), lowShare: Number(ocr.lowConfidenceShare.toFixed(2)) }
          : {};

        if (ocr && verdict.ok) {
          log(n, { route: 'ocr_local', ...figures });
          return {
            page_number: n, elements: ocr.elements, extraction_source: 'ocr',
            image_width: width, image_height: height,
          };
        }

        // The model.
        log(n, { route: 'model', why: verdict.why, ...figures });
        deps.logger.info('sending a page image to the model provider', { sourceFileId: input.sourceFileId, page: n });

        const fallback = {
          page_number: n,
          elements: ocr?.elements ?? [],
          extraction_source: 'ocr' as const,
          image_width: width,
          image_height: height,
        };

        try {
          const reading = await deps.readPage(image.image_path);
          if (reading && reading.regions.length > 0) {
            return {
              page_number: n,
              elements: elementsFromReading(reading, n, width, height),
              extraction_source: 'multimodal',
              image_width: width,
              image_height: height,
            };
          }
          deps.logger.warn('the model read nothing usable from a page; keeping local OCR', { sourceFileId: input.sourceFileId, page: n });
        } catch (err) {
          deps.logger.warn('the model could not read a page; keeping local OCR', {
            sourceFileId: input.sourceFileId, page: n, error: err instanceof Error ? err.message : String(err),
          });
        }
        return fallback;
      });

      return { pages };
    },
  };
}
