import type { ParseResponse } from '../types.js';

/** A rasterized page: the image the parser reads, and the one the UI shows. */
export interface ParserPage {
  page_number: number;
  image_path: string;
}

export interface ParseInput {
  sourceFileId: string;
  /** The original file, for parsers that read it directly. */
  filePath: string;
  pages: ParserPage[];
}

/**
 * The parser interface: text and where it is, for each page of a document.
 *
 * The contract, which every adapter keeps so nothing downstream has to guess:
 *
 *  - **One entry per input page, in the same order.** A blank page is an entry with
 *    no elements, not an absence. (The sidecar leaves blank pages out, and pairing
 *    its output with the images by position would shift every page after one.)
 *  - **`image_width` and `image_height` are the pixel size of that page's image**,
 *    and every element's box is in that pixel space. The sidecar reports its own
 *    coordinate system — PDF points for native text, 72 per inch, against a 200 DPI
 *    image — so its adapter scales into the image's space.
 */
export interface Parser {
  parse(input: ParseInput): Promise<ParseResponse>;
  /**
   * Whether this parser can send page images off the host. Read at startup so the
   * operator can see it in the log (SECURITY.md M-7).
   */
  readonly imageEgress: boolean;
}

export interface ParserConfig {
  mode: string;
  /** Required for any parser that sends images (`multimodal`, `hybrid`). */
  multimodalEnabled: boolean;
}

export class ParserConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParserConfigError';
  }
}
