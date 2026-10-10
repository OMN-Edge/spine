import type { ParseResponse } from '../../types.js';
import type { ParserDeps } from '../deps.js';
import type { Parser, ParseInput } from '../types.js';
import { createSidecarParser } from './sidecar.js';
import { elementsFromReading } from './multimodal.js';

/**
 * The sidecar first; the model only for the pages it is bad at.
 *
 * Routing is per page, not per deployment. A page the sidecar read from a text
 * layer is exact, free and stays on this host. A page it had to OCR — scans and
 * handwriting, the archive's hard case — or found nothing on, goes to the model.
 * A `mixed` page keeps the sidecar's result: part of it is exact text already.
 *
 * The model can only improve a page, never lose one: if it fails or gives an
 * unusable answer, the page keeps what the sidecar read and the failure is logged.
 */
export function createHybridParser(deps: ParserDeps): Parser {
  const sidecar = createSidecarParser(deps);

  return {
    imageEgress: true,

    async parse(input: ParseInput): Promise<ParseResponse> {
      const parsed = await sidecar.parse(input);
      const imageOf = new Map(input.pages.map(page => [page.page_number, page.image_path]));

      const pages = [];
      for (const page of parsed.pages) {
        const needsModel = page.extraction_source === 'ocr' || page.elements.length === 0;
        if (!needsModel) {
          pages.push(page);
          continue;
        }

        deps.logger.info('sending a page image to the model provider', {
          sourceFileId: input.sourceFileId,
          page: page.page_number,
          why: page.elements.length === 0 ? 'sidecar found no text' : 'sidecar had to OCR',
        });

        try {
          const reading = await deps.readPage(imageOf.get(page.page_number)!);
          if (reading && reading.regions.length > 0) {
            pages.push({
              ...page,
              elements: elementsFromReading(reading, page.page_number, page.image_width, page.image_height),
              extraction_source: 'multimodal' as const,
            });
            continue;
          }
          deps.logger.warn('the model read nothing usable from a page; keeping the sidecar result', {
            sourceFileId: input.sourceFileId,
            page: page.page_number,
          });
        } catch (err) {
          deps.logger.warn('the model could not read a page; keeping the sidecar result', {
            sourceFileId: input.sourceFileId,
            page: page.page_number,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        pages.push(page);
      }

      return { pages };
    },
  };
}
