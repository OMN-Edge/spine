import { getChatLlm } from '../llm/index.js';
import { loadParserConfig } from '../config.js';
import { parseDocument } from '../ingestion/ingestion-client.js';
import { getPageImageDimensions } from '../ingestion/rasterize.js';
import { createHybridParser } from './adapters/hybrid.js';
import { createMultimodalParser } from './adapters/multimodal.js';
import { createSidecarParser } from './adapters/sidecar.js';
import type { ParserDeps } from './deps.js';
import { ParserConfigError, type Parser, type ParserConfig } from './types.js';

/** A registry, as for the other interfaces: an adapter is one entry and one file. */
const ADAPTERS = {
  sidecar: createSidecarParser,
  multimodal: createMultimodalParser,
  hybrid: createHybridParser,
} satisfies Record<string, (deps: ParserDeps) => Parser>;

export const PARSERS = Object.keys(ADAPTERS);

const SENDS_IMAGES = new Set(['multimodal', 'hybrid']);

/** Pure: validates the config and builds a parser. Testable with fake dependencies. */
export function createParser(config: ParserConfig, deps: ParserDeps): Parser {
  const factory = (ADAPTERS as Record<string, ((deps: ParserDeps) => Parser) | undefined>)[config.mode];
  if (!factory) {
    throw new ParserConfigError(`unknown SPINE_PARSER "${config.mode}"; expected one of ${PARSERS.join(', ')}`);
  }
  // Checked again here, not only in config.ts: this is the function that decides
  // whether an image can leave, so it does not rely on its caller having asked.
  if (SENDS_IMAGES.has(config.mode) && !config.multimodalEnabled) {
    throw new ParserConfigError(
      `SPINE_PARSER=${config.mode} sends page images off this host and needs SPINE_MULTIMODAL_ENABLED=true`,
    );
  }
  return factory(deps);
}

let _parser: Parser | null = null;

/** Reads config on first use and memoizes. */
export function getParser(): Parser {
  if (!_parser) {
    _parser = createParser(loadParserConfig(), {
      sidecar: parseDocument,
      imageSize: getPageImageDimensions,
      readPage: imagePath => getChatLlm().readPage(imagePath),
      logger: {
        info: (message, detail) => console.log(message, detail ?? ''),
        warn: (message, detail) => console.warn(message, detail ?? ''),
      },
    });
  }
  return _parser;
}

/** Tests only. */
export function resetParser(replacement: Parser | null = null): void {
  _parser = replacement;
}

export * from './types.js';
export type { ParserDeps } from './deps.js';
