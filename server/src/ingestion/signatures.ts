import { execFile } from 'child_process';
import { mkdtemp, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';
import sharp from 'sharp';
import { getChatLlm } from '../llm/index.js';
import { logger } from '../logger.js';
import { aiReadingAllowed } from '../parser/index.js';
import { mapLimit } from '../concurrency.js';
import { llmConcurrency } from '../config.js';

const execFileAsync = promisify(execFile);

/** poppler reads files anyone can send, so a call that does not finish is stopped. */
const POPPLER_TIMEOUT_MS = 60_000;
/**
 * `pdfimages` writes every image on a page, not only the ones chosen, so a page declaring more pixels than
 * this is not unpacked (a file built to fill the disk or memory). A scan of a page is about 8 million.
 */
export const MAX_PAGE_IMAGE_PIXELS = 120_000_000;

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

/** One embedded image, as `pdfimages -list` reports it. */
export interface PdfImage {
  page: number;
  /** Its position among the images of its page, which is how `pdfimages` numbers the files it writes. */
  index: number;
  type: string;
  width: number;
  height: number;
  /** As printed ("37.7K"): with the size, it tells one picture from another without reading it. */
  size: string;
}

/**
 * First guesses, like the OCR thresholds, tuned by looking at what is sent. A stamp is wider than tall
 * (1.4 to 2.5 in the reports seen), where a QR code or a round seal is square and a logo is a long strip.
 * There is no ceiling on size: a stamp can be a large scan (1580 x 878 was one).
 */
export const STAMP_ASPECT_MIN = 1.2;
export const STAMP_ASPECT_MAX = 4.0;
export const STAMP_MIN_WIDTH = 100;
export const STAMP_MIN_HEIGHT = 40;
/** At most this many pictures go to the model for one document. */
export const MAX_STAMPS_PER_DOCUMENT = 4;
/** What is sent is reduced to this on its longer side: a stamp is read at far less than a scan's resolution. */
export const STAMP_MAX_SIDE = 1000;

/** Parses `pdfimages -list`. Rows it does not understand are skipped. */
export function parseImageList(output: string): PdfImage[] {
  const perPage = new Map<number, number>();
  const rows: PdfImage[] = [];
  for (const line of output.split('\n').slice(2)) {
    const t = line.trim().split(/\s+/);
    // page num type width height color comp bpc enc interp objectId objectGen x-ppi y-ppi size ratio
    if (t.length < 15 || !/^\d+$/.test(t[0])) continue;
    const page = Number(t[0]);
    const index = perPage.get(page) ?? 0;
    perPage.set(page, index + 1);
    rows.push({ page, index, type: t[2], width: Number(t[3]), height: Number(t[4]), size: t[14] });
  }
  return rows;
}

const signature = (image: PdfImage) => `${image.width}x${image.height}:${image.size}`;

/**
 * The pictures on a document's last page that may be a stamp, at most `MAX_STAMPS_PER_DOCUMENT`. Left out:
 * masks (a picture's transparency, not a picture), anything square or a long strip, anything small, and
 * anything that appears on more than one page of the file: that is a letterhead, not a signature.
 */
export function pickStampCandidates(all: PdfImage[], lastPage: number): PdfImage[] {
  const pagesWith = new Map<string, Set<number>>();
  for (const image of all) {
    const pages = pagesWith.get(signature(image)) ?? new Set<number>();
    pages.add(image.page);
    pagesWith.set(signature(image), pages);
  }
  return all
    .filter(image => image.page === lastPage && image.type === 'image')
    .filter(image => image.width >= STAMP_MIN_WIDTH && image.height >= STAMP_MIN_HEIGHT)
    .filter(image => {
      const aspect = image.width / image.height;
      return aspect >= STAMP_ASPECT_MIN && aspect <= STAMP_ASPECT_MAX;
    })
    .filter(image => (pagesWith.get(signature(image))?.size ?? 0) < 2)
    .sort((a, b) => b.width * b.height - a.width * a.height || a.index - b.index)
    .slice(0, MAX_STAMPS_PER_DOCUMENT);
}

export interface StampDoctor {
  name: string;
  specialty: string | null;
  code: string | null;
}

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
    logger.warn('could not list the images in a PDF; no doctors read from stamps', { error: err instanceof Error ? err.message : String(err) });
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
      logger.warn('could not read the signature stamps on a page', { page, error: err instanceof Error ? err.message : String(err) });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  return result;
}


/**
 * Digital signatures: a signature field in the PDF whose certificate names the signer. Nothing is sent
 * anywhere (poppler's `pdfsig` reads it locally), so unlike a stamp this does not depend on the image switch.
 *
 * Only a person counts: a certificate with a given name and a surname (a qualified personal signature).
 * A company seal has a common name and no given name, and the certificate's serial number is an
 * identifier of the person, not a professional code, so it is not kept. A signature that does not
 * validate is ignored.
 */
export interface DigitalSigner {
  name: string;
  signedAt: string | null;
}

/** Parses `pdfsig` output: one block per signature, introduced by "Signature #n:". */
export function parseSigners(output: string): DigitalSigner[] {
  const out: DigitalSigner[] = [];
  for (const block of output.split(/^Signature #\d+:/m).slice(1)) {
    const field = (label: string) => block.match(new RegExp(`^\\s*- ${label}:\\s*(.+)$`, 'm'))?.[1].trim() ?? null;
    if (/invalid/i.test(field('Signature Validation') ?? '')) continue;
    const dn = field('Signer full Distinguished Name') ?? '';
    const part = (key: string) => dn.match(new RegExp(`(?:^|,)${key}=([^,]+)`))?.[1].trim();
    const given = part('givenName'), surname = part('SN');
    if (!given || !surname) continue;
    const time = field('Signing Time');
    const parsed = time ? new Date(`${time} UTC`) : null;
    out.push({ name: `${given} ${surname}`, signedAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null });
  }
  // The same person signing twice is one signer.
  return out.filter((signer, i) => out.findIndex(o => o.name === signer.name) === i);
}

/** The people who digitally signed a PDF. Empty if there are none, or if anything goes wrong. */
export async function readDigitalSigners(filePath: string): Promise<DigitalSigner[]> {
  try {
    // pdfsig prints a harmless "NSS_Init failed" on stderr when it has no certificate store.
    const { stdout } = await execFileAsync('pdfsig', [filePath], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
    return parseSigners(stdout);
  } catch (err) {
    const stdout = (err as { stdout?: string }).stdout;
    // pdfsig exits non-zero for a file with no signatures, or one it could not fully check: use what it printed.
    if (typeof stdout === 'string' && stdout.includes('Signature #')) return parseSigners(stdout);
    return [];
  }
}
