import { getChatLlm } from '../llm/index.js';
import { loadParserConfig } from '../config.js';
import { logger } from '../logger.js';
import { parseDocument } from '../ingestion/ingestion-client.js';
import { getPageImageDimensions } from '../ingestion/rasterize.js';
import { checkOcrAvailable, ocrPage } from './ocr.js';
import { createHybridParser } from './adapters/hybrid.js';
import { createMultimodalParser } from './adapters/multimodal.js';
import { createOcrParser } from './adapters/ocr.js';
import { createSidecarParser } from './adapters/sidecar.js';
import type { ParserDeps } from './deps.js';
import { ParserConfigError, type Parser, type ParserConfig } from './types.js';

/** A registry, as for the other interfaces: an adapter is one entry and one file. */
const ADAPTERS = {
  text: createSidecarParser,
  ocr: createOcrParser,
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

function realDeps(config: ParserConfig, model?: string): ParserDeps {
  return {
    sidecar: parseDocument,
    imageSize: getPageImageDimensions,
    ocrPage: (imagePath, pageNumber) => ocrPage(imagePath, pageNumber, config.ocrLangs),
    readPage: imagePath => getChatLlm(model).readPage(imagePath),
    logger,
  };
}

let _parser: Parser | null = null;
let _modelParser: Parser | null = null;
const _modelParsers = new Map<string, Parser>();
const _parsers = new Map<string, Parser>();
let _modelParserReplaced = false;
let _parserReplaced = false;

/** Reads config on first use and memoizes. */
export function getParser(model?: string): Parser {
  // The configured strategy with a chosen model for whatever it sends to one.
  if (model && !_parserReplaced) {
    let parser = _parsers.get(model);
    if (!parser) {
      const config = loadParserConfig();
      parser = createParser(config, realDeps(config, model));
      _parsers.set(model, parser);
    }
    return parser;
  }
  if (!_parser) {
    const config = loadParserConfig();
    _parser = createParser(config, realDeps(config));
  }
  return _parser;
}

/**
 * A parser that has the model read every page, for a photo, which has no text layer
 * for anything local to read. It is the same `multimodal` adapter and the same switch:
 * refused unless the operator has allowed images to leave.
 */
export function getModelParser(model?: string): Parser {
  if (model && !_modelParserReplaced) {
    let parser = _modelParsers.get(model);
    if (!parser) {
      const config = loadParserConfig();
      parser = createParser({ ...config, mode: 'multimodal' }, realDeps(config, model));
      _modelParsers.set(model, parser);
    }
    return parser;
  }
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
 * At startup, in `ocr`, and in `hybrid` with local OCR on: Tesseract and the configured language packs must be
 * there. A missing pack does not fail, it just scores lower and sends more pages to
 * the model, which is cost and egress with nothing to say why.
 */
export async function checkParserRequirements(): Promise<void> {
  const config = loadParserConfig();
  if (config.mode === 'ocr' || (config.mode === 'hybrid' && config.ocrEnabled)) await checkOcrAvailable(config.ocrLangs);
}

/** Tests only. The model parser defaults to the same replacement unless given its own. */
export function resetParser(replacement: Parser | null = null, modelReplacement: Parser | null = replacement): void {
  _parser = replacement;
  _modelParser = modelReplacement;
  _modelParsers.clear();
  _parsers.clear();
  _modelParserReplaced = modelReplacement !== null;
  _parserReplaced = replacement !== null;
}

export * from './types.js';
export type { ParserDeps } from './deps.js';
