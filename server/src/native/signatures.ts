import { execFile } from 'child_process';
import { mkdtemp, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';
import sharp from 'sharp';
import { getChatLlm } from 'spine-core/llm/index.js';
import { logger } from 'spine-core/logger.js';
import { aiReadingAllowed } from 'spine-core/parser/index.js';
import { mapLimit } from 'spine-core/concurrency.js';
import { llmConcurrency } from 'spine-core/config.js';
import { describeError } from 'spine-core/failure.js';
import { MAX_PAGE_IMAGE_PIXELS, STAMP_MAX_SIDE, parseImageList, parseSigners, pickStampCandidates, type DigitalSigner, type PdfImage, type StampDoctor } from 'spine-core/ingestion/signatures-parse.js';

export * from 'spine-core/ingestion/signatures-parse.js';

const execFileAsync = promisify(execFile);

/** poppler reads files anyone can send, so a call that does not finish is stopped. */
const POPPLER_TIMEOUT_MS = 60_000;
/**
 * Doctors from signature stamps. A clinic's report prints the signer as a stamp: a small picture, with the
 * name, specialty and professional code, so none of it is in the page's text. The stamp is an image
 * embedded in the PDF, so it can be pulled out as it is (poppler's `pdfimages`, which is already needed for
 * `pdftoppm`) and only that crop, never the page, is shown to the model.
 *
 * This is the second thing that sends an image off the host, and it follows the same operator switch
 * (`SPINE_MULTIMODAL_ENABLED`): with it off nothing here runs. A failure is logged and means no
 * doctors from stamps; it never fails an upload.
 */

/** Writes the chosen pictures of one page to `dir`, reduced, and returns their paths. */
async function extractAndReduce(filePath: string, page: number, picks: PdfImage[], dir: string, maxPagePixels: number): Promise<string[]> {
  await execFileAsync('pdfimages', ['-png', '-f', String(page), '-l', String(page), filePath, path.join(dir, `p${page}`)], { timeout: POPPLER_TIMEOUT_MS });
  const written = (await readdir(dir)).filter(f => f.startsWith(`p${page}-`) && f.endsWith('.png')).sort();
  const out: string[] = [];
  for (const pick of picks) {
    const file = written[pick.index];
    if (!file) continue;
    const reduced = path.join(dir, `r${page}-${pick.index}.png`);
    await sharp(path.join(dir, file), { limitInputPixels: maxPagePixels })
      .resize({ width: STAMP_MAX_SIDE, height: STAMP_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .png()
      .toFile(reduced);
    out.push(reduced);
  }
  return out;
}

/**
 * The doctors on the stamps of a PDF's given pages (each the last page of a document), by page. Empty
 * for every page unless the operator has allowed images to leave, and for any page where anything fails.
 */
export async function readSignatures(filePath: string, lastPages: number[], maxPagePixels = MAX_PAGE_IMAGE_PIXELS): Promise<Map<number, StampDoctor[]>> {
  const result = new Map<number, StampDoctor[]>();
  const pages = [...new Set(lastPages)];
  if (pages.length === 0 || !aiReadingAllowed()) return result;

  let listing: PdfImage[];
  try {
    listing = parseImageList((await execFileAsync('pdfimages', ['-list', filePath], { maxBuffer: 32 * 1024 * 1024, timeout: POPPLER_TIMEOUT_MS })).stdout);
  } catch (err) {
    logger.warn('could not list the images in a PDF; no doctors read from stamps', { error: describeError(err) });
    return result;
  }

  await mapLimit(pages, llmConcurrency(), async page => {
    const picks = pickStampCandidates(listing, page);
    if (picks.length === 0) return;
    const pixels = listing.filter(image => image.page === page).reduce((sum, image) => sum + image.width * image.height, 0);
    if (pixels > maxPagePixels) {
      logger.warn('a page declares too many image pixels; its stamps are not read', { page, pixels });
      return;
    }
    const dir = await mkdtemp(path.join(tmpdir(), 'spine-stamps-'));
    try {
      const images = await extractAndReduce(filePath, page, picks, dir, maxPagePixels);
      if (images.length === 0) return;
      logger.info('sending signature stamps to the model provider', { page, images: images.length });
      const reading = await getChatLlm().readStamps(images);
      if (reading && reading.doctors.length > 0) result.set(page, reading.doctors);
    } catch (err) {
      logger.warn('could not read the signature stamps on a page', { page, error: describeError(err) });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  return result;
}


/** The people who digitally signed a PDF. Empty if there are none, or if anything goes wrong. */
export async function readDigitalSigners(filePath: string): Promise<DigitalSigner[]> {
  try {
    // pdfsig prints a harmless "NSS_Init failed" on stderr when it has no certificate store.
    const { stdout } = await execFileAsync('pdfsig', [filePath], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, TZ: 'UTC' } }) // pdfsig prints the signing time in the host's zone;
    return parseSigners(stdout);
  } catch (err) {
    const stdout = (err as { stdout?: string }).stdout;
    // pdfsig exits non-zero for a file with no signatures, or one it could not fully check: use what it printed.
    if (typeof stdout === 'string' && stdout.includes('Signature #')) return parseSigners(stdout);
    return [];
  }
}
