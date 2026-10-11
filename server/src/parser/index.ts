import { getChatLlm } from '../llm/index.js';
import { loadParserConfig } from '../config.js';
import { logger } from '../logger.js';
import { parseDocument } from '../ingestion/ingestion-client.js';
import { getPageImageDimensions } from '../ingestion/rasterize.js';
import { checkOcrAvailable, ocrPage } from './ocr.js';
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
} satisfies Record<string, (deps: ParserDeps, config: ParserConfig) => Parser>;

export const PARSERS = Object.keys(ADAPTERS);

const SENDS_IMAGES = new Set(['multimodal', 'hybrid']);

/** Pure: validates the config and builds a parser. Testable with fake dependencies. */
export function createParser(config: ParserConfig, deps: ParserDeps): Parser {
  const factory = (ADAPTERS as Record<string, ((deps: ParserDeps, config: ParserConfig) => Parser) | undefined>)[
    config.mode
  ];
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
  return factory(deps, config);
}

function realDeps(config: ParserConfig): ParserDeps {
  return {
    sidecar: parseDocument,
    imageSize: getPageImageDimensions,
    ocrPage: (imagePath, pageNumber) => ocrPage(imagePath, pageNumber, config.ocrLangs),
    readPage: imagePath => getChatLlm().readPage(imagePath),
    logger,
  };
}

let _parser: Parser | null = null;
let _modelParser: Parser | null = null;

/** Reads config on first use and memoizes. */
export function getParser(): Parser {
  if (!_parser) {
    const config = loadParserConfig();
    _parser = createParser(config, realDeps(config));
  }
  return _parser;
}

/**
 * A parser that has the model read every page, for the "Read with AI" button. It is
 * the same `multimodal` adapter and the same switch: refused unless the operator has
 * allowed images to leave, so the button cannot work where the setting says no.
 */
export function getModelParser(): Parser {
  if (!_modelParser) {
    const config = loadParserConfig();
    _modelParser = createParser({ ...config, mode: 'multimodal' }, realDeps(config));
  }
  return _modelParser;
}

/** Whether the operator has allowed page images to be sent to the model at all. */
export function aiReadingAllowed(): boolean {
  return loadParserConfig().multimodalEnabled;
}

/**
 * At startup, in `hybrid` only: Tesseract and the configured language packs must be
 * there. A missing pack does not fail, it just scores lower and sends more pages to
 * the model, which is cost and egress with nothing to say why.
 */
export async function checkParserRequirements(): Promise<void> {
  const config = loadParserConfig();
  if (config.mode === 'hybrid') await checkOcrAvailable(config.ocrLangs);
}

/** Tests only. The model parser defaults to the same replacement unless given its own. */
export function resetParser(replacement: Parser | null = null, modelReplacement: Parser | null = replacement): void {
  _parser = replacement;
  _modelParser = modelReplacement;
}

export * from './types.js';
export type { ParserDeps } from './deps.js';
