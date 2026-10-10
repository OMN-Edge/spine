import type { ParseResponse, UnstructuredElement } from '../../types.js';
import type { ParserDeps } from '../deps.js';
import type { Parser, ParseInput } from '../types.js';

/**
 * The local Unstructured sidecar: exact boxes for native text, no egress, but weak
 * OCR on handwriting — which is what the multimodal adapter is for.
 *
 * Its output is reshaped to the parser contract: one entry per page image, with
 * boxes in that image's pixel space.
 */
export function createSidecarParser(deps: ParserDeps): Parser {
  return {
    imageEgress: false,

    async parse(input: ParseInput): Promise<ParseResponse> {
      const parsed = await deps.sidecar(input.filePath);
      const byNumber = new Map(parsed.pages.map(page => [page.page_number, page]));

      return {
        pages: input.pages.map(image => {
          const { width, height } = deps.imageSize(image.image_path);
          const page = byNumber.get(image.page_number);

          // The sidecar omits a page with no elements. Keep it, empty, so the page
          // still has its row and its image.
          if (!page) {
            return {
              page_number: image.page_number,
              elements: [],
              extraction_source: 'native_text' as const,
              image_width: width,
              image_height: height,
            };
          }

          // Its boxes are in its own coordinate system, whose size it reports.
          // Missing or zero means it had no coordinates, so there is nothing to scale.
          const scaleX = page.image_width > 0 ? width / page.image_width : 1;
          const scaleY = page.image_height > 0 ? height / page.image_height : 1;

          const elements: UnstructuredElement[] = page.elements.map(element => ({
            ...element,
            bbox: element.bbox && {
              x0: element.bbox.x0 * scaleX,
              y0: element.bbox.y0 * scaleY,
              x1: element.bbox.x1 * scaleX,
              y1: element.bbox.y1 * scaleY,
            },
          }));

          return {
            page_number: image.page_number,
            elements,
            extraction_source: page.extraction_source,
            image_width: width,
            image_height: height,
          };
        }),
      };
    },
  };
}
