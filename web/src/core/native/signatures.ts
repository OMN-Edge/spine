import fs from 'fs';
import { getDocument, OPS } from './pdfjs';
import { getChatLlm } from 'spine-core/llm/index';
import { aiReadingAllowed } from 'spine-core/parser/index';
import { logger } from 'spine-core/logger';
import { describeError } from 'spine-core/failure';
import { MAX_PAGE_IMAGE_PIXELS, STAMP_MAX_SIDE, pickStampCandidates, type DigitalSigner, type PdfImage, type StampDoctor } from 'spine-core/ingestion/signatures-parse';

import { readSigners } from 'spine-core/ingestion/signatures-cms';

export * from 'spine-core/ingestion/signatures-parse';

/**
 * Same contract as core/src/ingestion/signatures.ts for the doctors on a stamp: the pictures on a document's last page are listed by
 * PDF.js, the ones that may be a stamp are chosen by the same rules (`pickStampCandidates`), reduced, and only those crops, never the
 * page, go to the model, and only when image reading is allowed. A failure means no doctors from stamps; it never fails an upload.
 */

interface Raw { width: number; height: number; kind?: number; data?: Uint8Array | Uint8ClampedArray; bitmap?: ImageBitmap }
type Listed = PdfImage & { name: string | null; inline: Raw | null };

const IMAGE_OPS = new Set<number>([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject]);

/** A cheap fingerprint of a picture's pixels, so the same letterhead on two pages is told from two different stamps of the same size. */
function fingerprint(raw: Raw): string {
  const data = raw.data;
  if (!data) return `bitmap${raw.width}x${raw.height}`;
  let hash = 2166136261;
  const step = Math.max(1, Math.floor(data.length / 512));
  for (let i = 0; i < data.length; i += step) hash = Math.imul(hash ^ data[i], 16777619);
  return `${data.length}:${(hash >>> 0).toString(16)}`;
}

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof getDocument>['promise']>['getPage']>>;

/** The decoded picture behind a name PDF.js gave an image on this page. */
function resolve(page: Page, name: string): Promise<Raw | null> {
  return new Promise(done => {
    const timer = setTimeout(() => done(null), 10_000);
    const get = name.startsWith('g_') ? page.commonObjs : page.objs;
    get.get(name, (raw: Raw | null) => { clearTimeout(timer); done(raw ?? null); });
  });
}

function toCanvas(raw: Raw): OffscreenCanvas {
  const { width, height } = raw;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#fff'; // flattened onto white, as on the server
  context.fillRect(0, 0, width, height);
  if (raw.bitmap) { context.drawImage(raw.bitmap, 0, 0); return canvas; }
  const pixels = new ImageData(width, height);
  const from = raw.data ?? new Uint8Array(0);
  // kind: 1 grey with one bit a pixel, 2 RGB, 3 RGBA (pdf.js ImageKind)
  if (raw.kind === 3) pixels.data.set(from.subarray(0, pixels.data.length));
  else if (raw.kind === 2) for (let i = 0, j = 0; i < width * height; i++, j += 3) { pixels.data.set([from[j], from[j + 1], from[j + 2], 255], i * 4); }
  else if (raw.kind === 1) {
    const stride = (width + 7) >> 3;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const v = (from[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
      pixels.data.set([v, v, v, 255], (y * width + x) * 4);
    }
  } else throw new Error('a picture in a form this does not read');
  const layer = new OffscreenCanvas(width, height);
  layer.getContext('2d')!.putImageData(pixels, 0, 0);
  context.drawImage(layer, 0, 0);
  return canvas;
}

async function reduced(raw: Raw): Promise<Uint8Array> {
  const scale = Math.min(1, STAMP_MAX_SIDE / Math.max(raw.width, raw.height));
  const out = new OffscreenCanvas(Math.max(1, Math.round(raw.width * scale)), Math.max(1, Math.round(raw.height * scale)));
  const context = out.getContext('2d')!;
  context.imageSmoothingQuality = 'high';
  context.drawImage(toCanvas(raw), 0, 0, out.width, out.height);
  return new Uint8Array(await (await out.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

/**
 * The reduced pictures that may be stamps on the given pages of a PDF, as PNG, by page. Separate from the model call so that it can be
 * tried without one (`npm run check:browser`).
 */
export async function stampImages(bytes: Uint8Array, lastPages: number[], maxPagePixels = MAX_PAGE_IMAGE_PIXELS): Promise<Map<number, Uint8Array[]>> {
  const result = new Map<number, Uint8Array[]>();
  const task = getDocument({ data: bytes.slice() });
  const pdf = await task.promise;
  try {
    const wanted = new Set(lastPages);
    const listing: Listed[] = [];
    const pages = new Map<number, Page>();
    let declared = 0;
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      pages.set(n, page);
      const { fnArray, argsArray } = await page.getOperatorList();
      let index = 0;
      for (let i = 0; i < fnArray.length; i++) {
        if (!IMAGE_OPS.has(fnArray[i])) continue;
        const args = argsArray[i] as [string | Raw, number?, number?];
        const inline = typeof args[0] === 'string' ? null : args[0];
        const width = inline?.width ?? args[1] ?? 0;
        const height = inline?.height ?? args[2] ?? 0;
        declared += width * height;
        if (declared > maxPagePixels * 4) throw new Error('the file declares too many image pixels');
        listing.push({ page: n, index: index++, type: fnArray[i] === OPS.paintImageMaskXObject ? 'stencil' : 'image', width, height, size: '', name: inline ? null : (args[0] as string), inline });
      }
    }

    // The same size on more than one page may be a letterhead: only then are the pixels compared, because that is what the server tells by file size.
    const sizes = new Map<string, Set<number>>();
    for (const image of listing) sizes.set(`${image.width}x${image.height}`, (sizes.get(`${image.width}x${image.height}`) ?? new Set()).add(image.page));
    for (const image of listing) {
      if ((sizes.get(`${image.width}x${image.height}`)?.size ?? 0) < 2) continue;
      const raw = image.inline ?? (image.name ? await resolve(pages.get(image.page)!, image.name) : null);
      image.size = raw ? fingerprint(raw) : '';
    }

    for (const page of wanted) {
      const picks = pickStampCandidates(listing, page);
      const pixels = listing.filter(image => image.page === page).reduce((sum, image) => sum + image.width * image.height, 0);
      if (picks.length === 0 || pixels > maxPagePixels) continue;
      const crops: Uint8Array[] = [];
      for (const pick of picks) {
        const chosen = listing.find(image => image.page === pick.page && image.index === pick.index)!;
        const raw = chosen.inline ?? (chosen.name ? await resolve(pages.get(page)!, chosen.name) : null);
        if (raw) crops.push(await reduced(raw));
      }
      if (crops.length > 0) result.set(page, crops);
    }
    return result;
  } finally {
    await task.destroy();
  }
}

export async function readSignatures(filePath: string, lastPages: number[], maxPagePixels = MAX_PAGE_IMAGE_PIXELS): Promise<Map<number, StampDoctor[]>> {
  const result = new Map<number, StampDoctor[]>();
  const pages = [...new Set(lastPages)];
  if (pages.length === 0 || !aiReadingAllowed()) return result;
  let crops: Map<number, Uint8Array[]>;
  try {
    crops = await stampImages(new Uint8Array(fs.readFileSync(filePath) as Buffer), pages, maxPagePixels);
  } catch (err) {
    logger.warn('could not list the images in a PDF; no doctors read from stamps', { error: describeError(err) });
    return result;
  }
  for (const [page, images] of crops) {
    // Held in the core's scratch space (`tmp/`), which is never saved, and let go as soon as the model has seen them.
    const dir = `/data/tmp/stamps-${page}-${Date.now()}`;
    fs.mkdirSync(dir, { recursive: true });
    try {
      const paths = images.map((png, i) => { const file = `${dir}/s${i}.png`; fs.writeFileSync(file, png); return file; });
      logger.info('sending signature stamps to the model provider', { page, images: paths.length });
      const reading = await getChatLlm().readStamps(paths);
      if (reading && reading.doctors.length > 0) result.set(page, reading.doctors);
    } catch (err) {
      logger.warn('could not read the signature stamps on a page', { page, error: describeError(err) });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return result;
}

/**
 * Checked on the device by the same code the server could use (`signatures-cms.ts`, WebCrypto): a signature counts when the bytes it covers
 * still match it, and its signer is marked `verified` when the file's certificates chain to an authority the operator named
 * (`SPINE_TRUST_ANCHORS_DIR`); without one a name is a label from the file (SECURITY.md S-23).
 */
let anchors: Promise<Uint8Array[]> | null = null;
/** The authorities this server's operator trusts for signatures (`GET /api/trust-anchors`), asked once; none if it cannot be asked. */
function trustAnchors(): Promise<Uint8Array[]> {
  anchors ??= fetch('/api/trust-anchors')
    .then(async res => (res.ok ? ((await res.json()) as { anchors?: string[] }).anchors ?? [] : []))
    .then(list => list.map(b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0))))
    .catch(() => []);
  return anchors;
}

export async function readDigitalSigners(filePath: string): Promise<DigitalSigner[]> {
  try {
    const bytes = new Uint8Array(fs.readFileSync(filePath) as Buffer);
    const signers = await readSigners(bytes, await trustAnchors());
    logger.info(`digital signatures read on the device: ${signers.length} in ${bytes.length} bytes`);
    return signers;
  } catch (err) {
    logger.warn('could not read the digital signatures of a PDF', { error: describeError(err) });
    return [];
  }
}
