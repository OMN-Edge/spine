import type { ParseResponse, UnstructuredElement } from '../../types.js';
import type { PageReading } from '../../llm/types.js';
import type { ParserDeps } from '../deps.js';
import type { Parser, ParseInput, ParserConfig } from '../types.js';
import { mapLimit } from '../../concurrency.js';

/**
 * Turn what a model read into the elements the rest of the pipeline already understands. They carry
 * text and no box: a model's idea of where text sits was unreliable, so nothing is drawn for them, and
 * a field read from such a page keeps its page (the page it was found on) and no highlight.
 */
export function elementsFromReading(reading: PageReading, pageNumber: number): UnstructuredElement[] {
  return reading.regions.map(region => ({
    type: 'Text',
    text: region.text,
    page_number: pageNumber,
    bbox: null,
    source: 'multimodal' as const,
  }));
}

/**
 * Every page read by the model, one image per call, several calls at once (up to
 * `SPINE_LLM_CONCURRENCY`). The pages are independent, so there is nothing to gain from
 * reading them in turn and a 100-page scan is the case where it matters. Results come back
 * in page order whatever order the calls finish in.
 *
 * No sidecar, so nothing here can fall back: a page the model cannot read fails the
 * upload, with the page number, rather than being stored empty and looking like a blank
 * page. After the first failure no further page is started.
 */
export function createMultimodalParser(deps: ParserDeps, config: Pick<ParserConfig, 'concurrency'>): Parser {
  return {
    imageEgress: true,

    async parse(input: ParseInput): Promise<ParseResponse> {
      const pages = await mapLimit(input.pages, config.concurrency, async image => {
        const { width, height } = deps.imageSize(image.image_path);

        deps.logger.info('sending a page image to the model provider', {
          sourceFileId: input.sourceFileId,
          page: image.page_number,
        });
        const reading = await deps.readPage(image.image_path);
        if (!reading) {
          throw new Error(`page ${image.page_number} could not be read: the model's answer was not usable`);
        }

        return {
          page_number: image.page_number,
          elements: elementsFromReading(reading, image.page_number),
          extraction_source: 'multimodal' as const,
          image_width: width,
          image_height: height,
        };
      });

      return { pages };
    },
  };
}
