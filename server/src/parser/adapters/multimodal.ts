import type { ParseResponse, UnstructuredElement } from '../../types.js';
import type { PageReading } from '../../llm/types.js';
import type { ParserDeps } from '../deps.js';
import type { Parser, ParseInput } from '../types.js';

/**
 * Turn what a model read into the elements the rest of the pipeline already
 * understands. The model gives fractions of the page; elements carry pixels.
 *
 * These boxes are the model's own estimate, so they are less exact than the
 * sidecar's. The page is marked `multimodal` and the UI says so.
 */
export function elementsFromReading(
  reading: PageReading,
  pageNumber: number,
  width: number,
  height: number,
): UnstructuredElement[] {
  return reading.regions.map(region => ({
    type: 'Text',
    text: region.text,
    page_number: pageNumber,
    bbox: {
      x0: region.x0 * width,
      y0: region.y0 * height,
      x1: region.x1 * width,
      y1: region.y1 * height,
    },
    source: 'multimodal' as const,
  }));
}

/**
 * Every page read by the model. No sidecar, so nothing here can fall back: a page
 * the model cannot read fails the upload, with the page number, rather than being
 * stored empty and looking like a blank page.
 */
export function createMultimodalParser(deps: ParserDeps): Parser {
  return {
    imageEgress: true,

    async parse(input: ParseInput): Promise<ParseResponse> {
      const pages: ParseResponse['pages'] = [];

      for (const image of input.pages) {
        const { width, height } = deps.imageSize(image.image_path);

        deps.logger.info('sending a page image to the model provider', {
          sourceFileId: input.sourceFileId,
          page: image.page_number,
        });
        const reading = await deps.readPage(image.image_path);
        if (!reading) {
          throw new Error(`page ${image.page_number} could not be read: the model's answer was not usable`);
        }

        pages.push({
          page_number: image.page_number,
          elements: elementsFromReading(reading, image.page_number, width, height),
          extraction_source: 'multimodal',
          image_width: width,
          image_height: height,
        });
      }

      return { pages };
    },
  };
}
